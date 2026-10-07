//go:build linux || darwin

package install

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"hostherd/agent/internal/config"
)

const defaultInstallDir = "/opt/hostherd"
const defaultStateDir = "/var/lib/hostherd/runtime"

var defaultUnitDir = serviceUnitDir()

type installer struct {
	launchd     bool
	client      *http.Client
	unitDir     string
	run         func(context.Context, string, ...string) ([]byte, error)
	runnerReady func(context.Context, config.Config) error
	agentReady  func(context.Context, config.Config) error
}

func newInstaller() *installer {
	i := &installer{launchd: runtime.GOOS == "darwin", unitDir: defaultUnitDir, client: &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return validateHTTPS(req.URL.String())
	}}, run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		b, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(b)))
		}
		return b, nil
	}}
	i.runnerReady = waitRunner
	i.agentReady = i.waitAgent
	return i
}

func requireSystem() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("installation and updates must run as root")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return fmt.Errorf("unsupported %s architecture %s", runtime.GOOS, runtime.GOARCH)
	}
	if runtime.GOOS == "darwin" {
		_, err := os.Stat("/bin/launchctl")
		return err
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return fmt.Errorf("a running systemd host is required")
	}
	return nil
}

// Install enrolls this host and creates independent communication and runner
// services. It never replaces an existing enrollment or starts a user's work.
func Install(ctx context.Context, serverURL, code, binaryPath string, options Options) error {
	if options.System {
		return fmt.Errorf("--system applies to Windows; run the installer from a root shell to use root")
	}
	if err := requireSystem(); err != nil {
		return err
	}
	executionAccount, err := detectedExecutionAccount()
	if err != nil {
		return err
	}
	if err := validateHTTPS(serverURL); err != nil {
		return err
	}
	if code == "" {
		return fmt.Errorf("an enrollment code is required")
	}
	for path, mode := range map[string]os.FileMode{filepath.Dir(config.DefaultPath): 0700, defaultInstallDir: 0755, filepath.Dir(defaultStateDir): 0755} {
		if err := ensureRootDirectory(path, mode); err != nil {
			return err
		}
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(defaultStateDir), "update.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another installation or update is running")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if _, err := os.Lstat(config.DefaultPath); err == nil {
		return fmt.Errorf("already enrolled; use the web update action for an installed agent")
	} else if !os.IsNotExist(err) {
		return err
	}
	i := newInstaller()
	serverURL = strings.TrimRight(serverURL, "/")
	pub, err := i.get(ctx, serverURL+"/downloads/release.pub", 16384)
	if err != nil {
		return err
	}
	data, err := i.get(ctx, serverURL+"/downloads/manifest.json", 1<<20)
	if err != nil {
		return err
	}
	manifest, err := VerifyManifest(data, string(pub))
	if err != nil {
		return err
	}
	artifact, ok := manifest.Artifacts[runtime.GOOS+"-"+runtime.GOARCH]
	if !ok {
		return fmt.Errorf("release has no artifact for %s-%s", runtime.GOOS, runtime.GOARCH)
	}
	source, err := os.Open(binaryPath)
	if err != nil {
		return err
	}
	defer source.Close()
	if err = verifyReader(source, artifact.SHA256, io.Discard); err != nil {
		return err
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err = os.MkdirAll(defaultInstallDir, 0755); err != nil {
		return err
	}
	releasePath, err := stageBinary(defaultInstallDir, manifest.Version, source, artifact.SHA256)
	if err != nil {
		return err
	}
	hostname, err := os.Hostname()
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"code": code, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "version": manifest.Version, "executionUser": executionAccount.Username})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL+"/api/agent/enroll", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := i.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Enrollment responses contain a credential; do not include their body in errors.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("enrollment failed: HTTP %d", resp.StatusCode)
	}
	var enrolled struct {
		ServerID      string `json:"serverId"`
		Token         string `json:"token"`
		URL           string `json:"url"`
		ExecutionUser string `json:"executionUser"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&enrolled); err != nil {
		return fmt.Errorf("invalid enrollment response")
	}
	if enrolled.ServerID == "" || enrolled.Token == "" || enrolled.ExecutionUser == "" {
		return fmt.Errorf("incomplete enrollment response")
	}
	if enrolled.ExecutionUser != executionAccount.Username {
		return fmt.Errorf("central returned execution user %q, detected %q", enrolled.ExecutionUser, executionAccount.Username)
	}
	if err = validateHTTPS(enrolled.URL); err != nil {
		return fmt.Errorf("invalid enrolled server URL")
	}
	c := config.Config{URL: enrolled.URL, Token: enrolled.Token, ServerID: enrolled.ServerID, ExecutionUser: enrolled.ExecutionUser, StateDir: defaultStateDir, Generation: manifest.Version, Version: manifest.Version, PublicKey: string(pub), InstallDir: defaultInstallDir}
	// Save the issued credential before any service startup; a failed startup can
	// be diagnosed and retried without consuming another enrollment code.
	if err = config.Save(config.DefaultPath, c); err != nil {
		return err
	}
	if err = provisionState(c); err != nil {
		return err
	}
	if err = i.writeRunnerUnit(c, releasePath); err != nil {
		return err
	}
	if err = i.writeAgentUnit(c, config.DefaultPath); err != nil {
		return err
	}
	if err = atomicSymlink(releasePath, filepath.Join(c.InstallDir, "current")); err != nil {
		return err
	}
	if _, err = i.reloadServices(ctx); err != nil {
		return err
	}
	if _, err = i.startService(ctx, runnerUnit(c.Generation)); err != nil {
		return err
	}
	if err = i.runnerReady(ctx, c); err != nil {
		return fmt.Errorf("runner startup failed: %w", err)
	}
	if _, err = i.startService(ctx, agentUnit); err != nil {
		return err
	}
	if err = i.agentReady(ctx, c); err != nil {
		return fmt.Errorf("communication agent startup failed: %w", err)
	}
	return nil
}

// StartUpdate escapes the communication service's cgroup. Restarting that
// service therefore cannot kill an update halfway through activation/rollback.
func StartUpdate(configPath, manifestURL string) error {
	if err := validateHTTPS(manifestURL); err != nil {
		return err
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if runtime.GOOS == "darwin" {
		return newInstaller().startLaunchdUpdate(ctx, binary, configPath, manifestURL)
	}
	_, err = newInstaller().run(ctx, "systemd-run", "--quiet", "--collect", "--unit=hostherd-update-"+strconv.FormatInt(time.Now().UnixNano(), 10), "--property=Type=exec", "--property=User=root", binary, "update", "--config", configPath, "--manifest-url", manifestURL)
	return err
}

// RegisterOwnRunner applies to Windows: systemd and launchd runner services are
// written by the root updater.
func RegisterOwnRunner(context.Context, string, string) error {
	return fmt.Errorf("runner task registration applies to Windows only")
}

// StartUninstall runs the uninstaller outside the communication service, which
// it stops and deletes, as StartUpdate does for updates.
func StartUninstall(configPath string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	args := []string{binary, "uninstall", "--config", configPath}
	if runtime.GOOS == "darwin" {
		return newInstaller().startLaunchdOneShot(ctx, uninstallerLabel, args, configPath, "agent removal is already running")
	}
	_, err = newInstaller().run(ctx, "systemd-run", append([]string{"--quiet", "--collect", "--unit=hostherd-uninstall-" + strconv.FormatInt(time.Now().UnixNano(), 10), "--property=Type=exec", "--property=User=root"}, args...)...)
	return err
}

// Uninstall removes this installation after an explicit request: running jobs
// and terminals end, the communication and runner services are stopped and
// deleted, and the configuration, runtime data and binaries are removed.
func Uninstall(ctx context.Context, configPath string) error {
	if err := requireSystem(); err != nil {
		return err
	}
	if err := rootPrivateFile(configPath); err != nil {
		return err
	}
	c, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if err = validInstalledConfig(c); err != nil {
		return err
	}
	if dir := filepath.Dir(configPath); dir != filepath.Dir(config.DefaultPath) {
		return fmt.Errorf("unexpected configuration directory %s", dir)
	}
	if err = waitReply(ctx); err != nil {
		return err
	}
	return newInstaller().uninstall(ctx, configPath, c)
}

func (i *installer) uninstall(ctx context.Context, configPath string, c config.Config) error {
	stopRunningWork(ctx, c.StateDir)
	// The communication service goes first so it cannot restart a runner or
	// reconnect while the rest is removed.
	units := []string{agentUnit}
	matches, err := filepath.Glob(filepath.Join(i.unitDir, i.serviceFile(runnerUnit("*"))))
	if err != nil {
		return err
	}
	for _, match := range matches {
		generation := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(match), "hostherd-runner-"), ".service")
		if i.launchd {
			generation = strings.TrimSuffix(strings.TrimPrefix(filepath.Base(match), "io.hostherd.runner."), ".plist")
		}
		units = append(units, runnerUnit(generation))
	}
	var failures []error
	for _, unit := range units {
		// Stopping fails for a unit that is not loaded; deleting it still matters.
		i.stopService(ctx, unit)
		i.disableService(ctx, unit)
		if err := os.Remove(filepath.Join(i.unitDir, i.serviceFile(unit))); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err)
		}
	}
	if _, err := i.reloadServices(ctx); err != nil {
		failures = append(failures, err)
	}
	for _, dir := range []string{c.InstallDir, filepath.Dir(c.StateDir), filepath.Dir(configPath)} {
		if err := os.RemoveAll(dir); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func Update(ctx context.Context, configPath, manifestURL string) error {
	if err := requireSystem(); err != nil {
		return err
	}
	if err := validateHTTPS(manifestURL); err != nil {
		return err
	}
	if err := rootPrivateFile(configPath); err != nil {
		return err
	}
	c, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if err = validInstalledConfig(c); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(c.StateDir), "update.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another agent update is running")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	// Re-read after taking the lock in case a preceding update just completed.
	c, err = config.Load(configPath)
	if err != nil {
		return err
	}
	i := newInstaller()
	data, err := i.get(ctx, manifestURL, 1<<20)
	if err != nil {
		return err
	}
	m, err := VerifyManifest(data, c.PublicKey)
	if err != nil {
		return err
	}
	comparison, err := CompareVersions(m.Version, c.Version)
	if err != nil {
		return err
	}
	if comparison == 0 {
		return nil
	}
	if comparison < 0 {
		return fmt.Errorf("release downgrade from %s to %s is not allowed", c.Version, m.Version)
	}
	a, ok := m.Artifacts[runtime.GOOS+"-"+runtime.GOARCH]
	if !ok {
		return fmt.Errorf("release has no artifact for %s-%s", runtime.GOOS, runtime.GOARCH)
	}
	artifactURL, err := ArtifactURL(manifestURL, a)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifactURL, nil)
	if err != nil {
		return err
	}
	resp, err := i.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("release download: HTTP %d", resp.StatusCode)
	}
	path, err := stageBinary(c.InstallDir, m.Version, resp.Body, a.SHA256)
	if err != nil {
		return err
	}
	next := c
	next.Version, next.Generation = m.Version, m.Version
	return i.activate(ctx, configPath, c, next, path)
}

// CleanupRunners retires only older, idle execution services. All per-job
// metadata and unacknowledged output live in StateDir and are left intact.
// A candidate newer than the selected version may be staging or rolling back.
func CleanupRunners(ctx context.Context, c config.Config) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("runner service cleanup must run as root")
	}
	if err := validInstalledConfig(c); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(c.StateDir), "update.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil // The updater owns staging and activation while holding this lock.
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return newInstaller().cleanup(ctx, c)
}

func (i *installer) cleanup(ctx context.Context, c config.Config) error {
	entries, err := os.ReadDir(filepath.Join(c.InstallDir, "releases"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	changed := false
	var failures []error
	for _, entry := range entries {
		generation := entry.Name()
		if !entry.IsDir() || generation == c.Generation {
			continue
		}
		cmp, err := CompareVersions(generation, c.Version)
		if err != nil || cmp >= 0 {
			continue
		}
		probeCtx, cancel := context.WithTimeout(ctx, time.Second)
		health, err := readRunnerHealth(probeCtx, c.StateDir, generation)
		cancel()
		// A missing or failed runtime must be reported by the supervisor, not
		// silently treated as idle and erased by cleanup.
		if err != nil || !health.OK || health.Protocol != 1 || health.Version != generation || health.Active == nil || *health.Active != 0 {
			continue
		}
		if err = i.retireRunnerUnits(ctx, generation); err != nil {
			failures = append(failures, err)
			continue
		}
		// Remove only the root-managed release; never the runtime socket,
		// shared journal, completion records, or local output spool.
		if err = os.RemoveAll(filepath.Join(c.InstallDir, "releases", generation)); err != nil {
			failures = append(failures, err)
		}
		changed = true
	}
	if changed {
		if _, err = i.reloadServices(ctx); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// retireRunnerUnits stops and removes the generation's runner service.
func (i *installer) retireRunnerUnits(ctx context.Context, generation string) error {
	unit := runnerUnit(generation)
	if _, err := i.stopService(ctx, unit); err != nil {
		return err
	}
	if _, err := i.disableService(ctx, unit); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(i.unitDir, i.serviceFile(unit))); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (i *installer) activate(ctx context.Context, configPath string, previous, next config.Config, binaryPath string) error {
	// The old runner units are deliberately neither restarted nor stopped.
	if err := i.writeRunnerUnit(next, binaryPath); err != nil {
		return err
	}
	if _, err := i.reloadServices(ctx); err != nil {
		return err
	}
	if _, err := i.startService(ctx, runnerUnit(next.Generation)); err != nil {
		return err
	}
	if err := i.runnerReady(ctx, next); err != nil {
		return fmt.Errorf("new runner failed readiness; previous version remains selected: %w", err)
	}
	current := filepath.Join(previous.InstallDir, "current")
	previousTarget, err := os.Readlink(current)
	if err != nil {
		return fmt.Errorf("read current release: %w", err)
	}
	if err = atomicSymlink(binaryPath, current); err != nil {
		return errors.Join(err, atomicSymlink(previousTarget, current))
	}
	if err = config.Save(configPath, next); err != nil {
		return errors.Join(err, config.Save(configPath, previous), atomicSymlink(previousTarget, current))
	}
	_, startErr := i.restartAgent(ctx)
	if startErr == nil {
		startErr = i.agentReady(ctx, next)
	}
	if startErr == nil {
		return nil
	}
	// Rollback is independent of a cancelled caller or lost central connection.
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	restoreConfigErr := config.Save(configPath, previous)
	restoreLinkErr := atomicSymlink(previousTarget, current)
	_, restartErr := i.restartAgent(rollbackCtx)
	if restartErr == nil {
		restartErr = i.agentReady(rollbackCtx, previous)
	}
	if rollbackErr := errors.Join(restoreConfigErr, restoreLinkErr, restartErr); rollbackErr != nil {
		return fmt.Errorf("new agent failed (%v); rollback also failed: %w", startErr, rollbackErr)
	}
	// Even a new runner is preserved: it may have accepted a job before the new
	// communication process failed. The active agent discovers every generation.
	return fmt.Errorf("new agent startup failed; previous version restored: %w", startErr)
}

func (i *installer) get(ctx context.Context, rawURL string, max int64) ([]byte, error) {
	return download(ctx, i.client, rawURL, max)
}

func validInstalledConfig(c config.Config) error {
	if c.InstallDir != defaultInstallDir || c.StateDir != defaultStateDir {
		return fmt.Errorf("invalid system installation directories")
	}
	if !versionPattern.MatchString(c.Version) || !versionPattern.MatchString(c.Generation) {
		return fmt.Errorf("invalid installed version")
	}
	if _, err := lookupSystemAccount(c.ExecutionUser); err != nil {
		return fmt.Errorf("execution user: %w", err)
	}
	for _, path := range []string{c.InstallDir, filepath.Dir(c.StateDir)} {
		if err := checkRootDirectory(path); err != nil {
			return err
		}
	}
	return nil
}

func ensureRootDirectory(path string, mode os.FileMode) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	if err := checkRootDirectory(path); err != nil {
		return err
	}
	// Both the bootstrap and updater intentionally use umask 0077. Apply the
	// managed directory's exact mode after validating ownership, so a normal
	// execution account can traverse binary/state parents while config stays private.
	return os.Chmod(path, mode)
}

func checkRootDirectory(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || !info.IsDir() || info.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("managed directory %s must be a root-owned directory without group/other write access", path)
	}
	return nil
}

func rootPrivateFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("agent configuration must be a root-owned private regular file")
	}
	return nil
}

func provisionState(c config.Config) error {
	u, err := lookupSystemAccount(c.ExecutionUser)
	if err != nil {
		return fmt.Errorf("execution user %q must already exist: %w", c.ExecutionUser, err)
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return err
	}
	if err = ensureRootDirectory(filepath.Dir(c.StateDir), 0755); err != nil {
		return err
	}
	if err = os.Mkdir(c.StateDir, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(c.StateDir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("runtime state must be a real directory")
	}
	if err = os.Chown(c.StateDir, uid, gid); err != nil {
		return err
	}
	return os.Chmod(c.StateDir, 0700)
}

func stageBinary(root, version string, source io.Reader, sha string) (string, error) {
	if !versionPattern.MatchString(version) {
		return "", fmt.Errorf("invalid release version")
	}
	dir := filepath.Join(root, "releases", version)
	for _, path := range []string{root, filepath.Join(root, "releases"), dir} {
		if err := ensureRootDirectory(path, 0755); err != nil {
			return "", err
		}
	}
	path := filepath.Join(dir, "hostherd")
	f, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	err = verifyReader(source, sha, f)
	if err == nil {
		err = f.Chmod(0755)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if existing, e := os.Open(path); e == nil {
		defer existing.Close()
		if e = verifyReader(existing, sha, io.Discard); e != nil {
			return "", fmt.Errorf("installed version %s is immutable: %w", version, e)
		}
		return path, nil
	} else if !os.IsNotExist(e) {
		return "", e
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return path, syncDir(dir)
}

func atomicSymlink(target, path string) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".current-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	f.Close()
	os.Remove(tmp)
	defer os.Remove(tmp)
	if err = os.Symlink(target, tmp); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func runnerUnit(generation string) string { return "hostherd-runner-" + generation + ".service" }

func systemdQuote(value string) (string, error) {
	if strings.ContainsAny(value, "\x00\n\r") {
		return "", fmt.Errorf("invalid systemd argument")
	}
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "%", "%%")
	return "\"" + value + "\"", nil
}

func (i *installer) writeRunnerUnit(c config.Config, binaryPath string) error {
	if i.launchd {
		return i.writeLaunchdRunner(c, binaryPath)
	}
	unit, err := runnerDefinition(c, binaryPath)
	if err != nil {
		return err
	}
	return i.writeUnit(runnerUnit(c.Generation), unit)
}

// runnerDefinition is the systemd runner unit of one generation.
func runnerDefinition(c config.Config, binaryPath string) (string, error) {
	if !versionPattern.MatchString(c.Generation) {
		return "", fmt.Errorf("invalid runner generation")
	}
	u, err := lookupSystemAccount(c.ExecutionUser)
	if err != nil {
		return "", err
	}
	binary, err := systemdQuote(binaryPath)
	if err != nil {
		return "", err
	}
	state, err := systemdQuote(c.StateDir)
	if err != nil {
		return "", err
	}
	// Numeric identities avoid systemd specifier/name interpretation and apply
	// the enrolled account to file operations, commands and PTYs alike.
	if _, err = strconv.Atoi(u.Uid); err != nil {
		return "", err
	}
	if _, err = strconv.Atoi(u.Gid); err != nil {
		return "", err
	}
	// WorkingDirectory is not an ExecStart argument: surrounding quotes become
	// part of its path. systemd's unquoted ~ selects the enrolled User's home.
	// Stopping a retired runner ends only the runner itself, so daemons that
	// commands started outlive it. Commands and files get the usual umask;
	// runtime state is created with explicit private modes.
	unit := fmt.Sprintf("[Unit]\nDescription=Hostherd runner %s\nAfter=local-fs.target\n\n[Service]\nType=simple\nUser=%s\nGroup=%s\nWorkingDirectory=~\nExecStart=%s runner --state-dir %s --generation %s\nRestart=on-failure\nRestartSec=3\nKillMode=process\nTimeoutStopSec=30\nTasksMax=infinity\nUMask=0022\n\n[Install]\nWantedBy=multi-user.target\n", c.Generation, u.Uid, u.Gid, binary, state, c.Generation)
	return unit, nil
}

func (i *installer) writeAgentUnit(c config.Config, configPath string) error {
	body, err := i.agentDefinition(c, configPath)
	if err != nil {
		return err
	}
	return i.writeUnit(i.serviceFile(agentUnit), body)
}

// agentDefinition is the communication service definition. It names only the
// stable "current" link and config path, so it does not change per version.
// The agent restarts after any exit, including a clean one; an explicit
// stop (systemctl stop, launchctl bootout) still keeps it stopped.
func (i *installer) agentDefinition(c config.Config, configPath string) (string, error) {
	if i.launchd {
		return launchdPlist(agentLabel, []string{filepath.Join(c.InstallDir, "current"), "agent", "--config", configPath}, "root", "", "", 0o77, "<true/>"), nil
	}
	binary, err := systemdQuote(filepath.Join(c.InstallDir, "current"))
	if err != nil {
		return "", err
	}
	cfg, err := systemdQuote(configPath)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("[Unit]\nDescription=Hostherd communication agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nExecStart=%s agent --config %s\nRestart=always\nRestartSec=3\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n", binary, cfg), nil
}

func (i *installer) writeUnit(name, body string) error {
	if err := os.MkdirAll(i.unitDir, 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(i.unitDir, ".unit-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0644); err == nil {
		_, err = f.WriteString(body)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), filepath.Join(i.unitDir, name)); err != nil {
		return err
	}
	return syncDir(i.unitDir)
}

func (i *installer) waitAgent(ctx context.Context, c config.Config) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return poll(ctx, func() error {
		pid, err := i.agentPID(ctx)
		if err != nil {
			return err
		}
		marker := filepath.Join(filepath.Dir(c.StateDir), "agent-ready.json")
		if err = rootPrivateFile(marker); err != nil {
			return err
		}
		b, err := os.ReadFile(marker)
		if err != nil {
			return err
		}
		var ready struct {
			PID        int    `json:"pid"`
			Version    string `json:"version"`
			Generation string `json:"generation"`
		}
		if err = json.Unmarshal(b, &ready); err != nil {
			return err
		}
		if ready.PID != pid || ready.Version != c.Version || ready.Generation != c.Generation {
			return fmt.Errorf("communication agent has not confirmed local readiness")
		}
		return nil
	})
}
