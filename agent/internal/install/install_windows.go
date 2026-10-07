//go:build windows

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
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"hostherd/agent/internal/config"
	"hostherd/agent/internal/ipc"
	"hostherd/agent/internal/model"
	"hostherd/agent/internal/store"
)

// Windows layout: binaries under Program Files (Users may read and run),
// configuration under ProgramData\Hostherd (SYSTEM and Administrators only),
// and the runtime directory additionally writable by the execution account.
const (
	AgentService     = "HostherdAgent"
	runnerTaskFolder = `\Hostherd\`
	systemAccount    = `NT AUTHORITY\SYSTEM`
	adminsSID        = "S-1-5-32-544"
)

var defaultInstallDir = filepath.Join(programFiles(), "Hostherd")

func programFiles() string {
	if dir := os.Getenv("ProgramFiles"); dir != "" {
		return dir
	}
	return `C:\Program Files`
}

func runnerTask(generation string) string { return runnerTaskFolder + "Runner-" + generation }

func httpClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return validateHTTPS(req.URL.String())
	}}
}

func system32(name string) string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", name)
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	b, err := cmd.CombinedOutput()
	if err != nil {
		return b, fmt.Errorf("%s: %w: %s", filepath.Base(name), err, strings.TrimSpace(string(b)))
	}
	return b, nil
}

func requireAdministrator() error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return fmt.Errorf("run the installer from an elevated (Administrator) PowerShell")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return fmt.Errorf("unsupported Windows architecture %s", runtime.GOARCH)
	}
	// ConPTY terminals need Windows 10 1809 / Server 2019 (build 17763).
	if v := windows.RtlGetVersion(); v.BuildNumber < 17763 {
		return fmt.Errorf("Windows 10 1809, Windows Server 2019 or later is required (build %d)", v.BuildNumber)
	}
	return nil
}

// executionAccount is the account that runs commands: the user who launched the
// elevated installer, or SYSTEM when requested or when already running as SYSTEM.
func executionAccount(useSystem bool) (name, sid string, err error) {
	if useSystem {
		return systemAccount, windowsSystemSID, nil
	}
	current, err := user.Current()
	if err != nil {
		return "", "", err
	}
	if current.Uid == windowsSystemSID {
		return systemAccount, windowsSystemSID, nil
	}
	return current.Username, current.Uid, nil
}

func accountSID(name string) (string, error) {
	if strings.EqualFold(name, systemAccount) {
		return windowsSystemSID, nil
	}
	sid, _, _, err := windows.LookupSID("", name)
	if err != nil {
		return "", fmt.Errorf("execution account %q: %w", name, err)
	}
	return sid.String(), nil
}

// secureDataDir restricts ProgramData\Hostherd to SYSTEM and Administrators.
func secureDataDir(ctx context.Context) error {
	if err := os.MkdirAll(config.DataDir, 0700); err != nil {
		return err
	}
	_, err := run(ctx, system32("icacls.exe"), config.DataDir, "/inheritance:r", "/grant:r", "*"+windowsSystemSID+":(OI)(CI)F", "*"+adminsSID+":(OI)(CI)F")
	return err
}

// provisionRuntime lets the execution account create jobs and its runner socket.
func provisionRuntime(ctx context.Context, stateDir, sid string) error {
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	if sid == windowsSystemSID {
		return nil
	}
	_, err := run(ctx, system32("icacls.exe"), stateDir, "/grant", "*"+sid+":(OI)(CI)M")
	return err
}

func lockUpdates() (*os.File, error) {
	lock, err := store.Lock(filepath.Join(config.DataDir, "update.lock"), true)
	if err != nil {
		return nil, fmt.Errorf("another installation or update is running")
	}
	return lock, nil
}

// Install enrolls this host, starts a runner task for the execution account and
// the communication service. It never replaces an existing enrollment.
func Install(ctx context.Context, serverURL, code, binaryPath string, options Options) error {
	if err := requireAdministrator(); err != nil {
		return err
	}
	account, sid, err := executionAccount(options.System)
	if err != nil {
		return err
	}
	// S4U tasks get no UAC filtering, so an administrator's commands run elevated.
	if sid != windowsSystemSID {
		if admin, err := administratorsMember(account); err == nil && admin {
			fmt.Printf("Hostherd: warning: %s is in the Administrators group; commands, files and terminals run with full administrator rights (UAC does not apply to scheduled-task logons).\n", account)
		}
	}
	if err := validateHTTPS(serverURL); err != nil {
		return err
	}
	if code == "" {
		return fmt.Errorf("an enrollment code is required")
	}
	if err = secureDataDir(ctx); err != nil {
		return err
	}
	lock, err := lockUpdates()
	if err != nil {
		return err
	}
	defer store.Unlock(lock)
	if _, err := os.Lstat(config.DefaultPath); err == nil {
		return fmt.Errorf("already enrolled; use the web update action for an installed agent")
	} else if !os.IsNotExist(err) {
		return err
	}
	client := httpClient()
	serverURL = strings.TrimRight(serverURL, "/")
	pub, err := download(ctx, client, serverURL+"/downloads/release.pub", 16384)
	if err != nil {
		return err
	}
	data, err := download(ctx, client, serverURL+"/downloads/manifest.json", 1<<20)
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
	releasePath, err := stageWindowsBinary(defaultInstallDir, manifest.Version, source, artifact.SHA256)
	if err != nil {
		return err
	}
	hostname, err := os.Hostname()
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"code": code, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "version": manifest.Version, "executionUser": account})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL+"/api/agent/enroll", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
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
	if enrolled.ServerID == "" || enrolled.Token == "" || enrolled.ExecutionUser != account {
		return fmt.Errorf("incomplete enrollment response")
	}
	if err = validateHTTPS(enrolled.URL); err != nil {
		return fmt.Errorf("invalid enrolled server URL")
	}
	c := config.Config{URL: enrolled.URL, Token: enrolled.Token, ServerID: enrolled.ServerID, ExecutionUser: account, StateDir: config.DefaultStateDir,
		Generation: manifest.Version, Version: manifest.Version, PublicKey: string(pub), InstallDir: defaultInstallDir}
	// Save the credential before starting anything, so a failed start can be retried.
	if err = config.Save(config.DefaultPath, c); err != nil {
		return err
	}
	if err = provisionRuntime(ctx, c.StateDir, sid); err != nil {
		return err
	}
	if err = registerRunner(ctx, c, sid, releasePath); err != nil {
		return err
	}
	if err = waitRunner(ctx, c); err != nil {
		return fmt.Errorf("runner startup failed: %w", err)
	}
	if err = installAgentService(releasePath); err != nil {
		return err
	}
	if err = startAgent(); err != nil {
		return err
	}
	return waitAgent(ctx, c)
}

// stageWindowsBinary verifies and stores releases\<version>\hostherd.exe.
func stageWindowsBinary(root, version string, source io.Reader, sha string) (string, error) {
	if !versionPattern.MatchString(version) {
		return "", fmt.Errorf("invalid release version")
	}
	dir := filepath.Join(root, "releases", version)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "hostherd.exe")
	f, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	err = verifyReader(source, sha, f)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if existing, statErr := os.Stat(path); statErr == nil && existing.Mode().IsRegular() {
		// A previous attempt staged the same version; it may be running.
		if current, openErr := os.Open(path); openErr == nil {
			verifyErr := verifyReader(current, sha, io.Discard)
			current.Close()
			if verifyErr == nil {
				return path, nil
			}
		}
	}
	if err = store.ReplaceFile(f.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

// registerRunner creates and starts the generation's scheduled task.
func registerRunner(ctx context.Context, c config.Config, sid, binary string) error {
	if sid != windowsSystemSID {
		if err := grantBatchLogon(sid); err != nil {
			return err
		}
	}
	if err := createRunnerTask(ctx, c, sid, binary, filepath.Join(config.DataDir, "runner-task.xml")); err != nil {
		return err
	}
	_, err := run(ctx, system32("schtasks.exe"), "/Run", "/TN", runnerTask(c.Generation))
	return err
}

// registerSuccessorRunner registers the new generation's task for a user
// account during an update. Task Scheduler denies SYSTEM creating or changing
// an S4U task of another account (ending, running and deleting it are
// allowed), so the current runner, which runs as that account, registers it.
func registerSuccessorRunner(ctx context.Context, previous, next config.Config, sid string) error {
	if err := grantBatchLogon(sid); err != nil {
		return err
	}
	params, _ := json.Marshal(map[string]string{"generation": next.Generation})
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := ipc.Call(callCtx, previous.StateDir, previous.Generation, model.Request{Type: "request", ID: "register-" + next.Generation, Method: "runner.register", Params: params}); err != nil {
		return fmt.Errorf("runner %s could not register the runner task for %s: %w", previous.Generation, next.Generation, err)
	}
	_, err := run(ctx, system32("schtasks.exe"), "/Run", "/TN", runnerTask(next.Generation))
	return err
}

// RegisterOwnRunner runs in a user-account runner: it registers, as that
// account, the task for an installed release generation. SYSTEM starts it.
func RegisterOwnRunner(ctx context.Context, stateDir, generation string) error {
	if !versionPattern.MatchString(generation) {
		return fmt.Errorf("invalid runner generation")
	}
	if !strings.EqualFold(filepath.Clean(stateDir), filepath.Clean(config.DefaultStateDir)) {
		return fmt.Errorf("unexpected state directory %s", stateDir)
	}
	current, err := user.Current()
	if err != nil {
		return err
	}
	if current.Uid == windowsSystemSID {
		return fmt.Errorf("SYSTEM runner tasks are registered by the updater")
	}
	binary := filepath.Join(defaultInstallDir, "releases", generation, "hostherd.exe")
	if _, err = os.Stat(binary); err != nil {
		return err
	}
	c := config.Config{Generation: generation, ExecutionUser: current.Username, StateDir: stateDir}
	return createRunnerTask(ctx, c, current.Uid, binary, filepath.Join(stateDir, "runner-task-"+generation+".xml"))
}

func createRunnerTask(ctx context.Context, c config.Config, sid, binary, definition string) error {
	units := utf16.Encode([]rune(runnerTaskXML(c, sid, binary, windows.ComposeCommandLine([]string{"runner", "--state-dir", c.StateDir, "--generation", c.Generation}))))
	b := []byte{0xFF, 0xFE} // UTF-16LE byte order mark, as schtasks expects.
	for _, u := range units {
		b = append(b, byte(u), byte(u>>8))
	}
	if err := os.WriteFile(definition, b, 0600); err != nil {
		return err
	}
	defer os.Remove(definition)
	_, err := run(ctx, system32("schtasks.exe"), "/Create", "/TN", runnerTask(c.Generation), "/XML", definition, "/F")
	return err
}

func retireRunner(ctx context.Context, generation string) error {
	task := runnerTask(generation)
	run(ctx, system32("schtasks.exe"), "/End", "/TN", task)
	if _, err := run(ctx, system32("schtasks.exe"), "/Delete", "/TN", task, "/F"); err != nil && !strings.Contains(err.Error(), "cannot find") {
		return err
	}
	return nil
}

func agentCommandLine(binary string) string {
	return windows.ComposeCommandLine([]string{binary, "agent", "--config", config.DefaultPath})
}

func installAgentService(binary string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.CreateService(AgentService, binary, mgr.Config{
		DisplayName: "Hostherd Agent", Description: "Connects this computer to the Hostherd central server.",
		StartType: mgr.StartAutomatic, DelayedAutoStart: false,
	}, "agent", "--config", config.DefaultPath)
	if err != nil {
		return err
	}
	defer s.Close()
	return setAgentRecovery(s)
}

// setAgentRecovery restarts the communication service whenever it ends without
// a stop request: after a crash and, with the non-crash flag, after it stops
// itself with an error. The last action repeats for later failures.
func setAgentRecovery(s *mgr.Service) error {
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}, {Type: mgr.ServiceRestart, Delay: 10 * time.Second}, {Type: mgr.ServiceRestart, Delay: 30 * time.Second}}, 86400); err != nil {
		return err
	}
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}

func withAgentService(do func(*mgr.Service) error) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(AgentService)
	if err != nil {
		return err
	}
	defer s.Close()
	return do(s)
}

func startAgent() error {
	return withAgentService(func(s *mgr.Service) error { return s.Start() })
}

// restartAgent stops the communication service and starts it with its current
// configuration. Runner tasks and their jobs are separate and keep running.
func restartAgent(ctx context.Context) error {
	return withAgentService(func(s *mgr.Service) error {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Stopped {
			if _, err = s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
				return err
			}
			for status.State != svc.Stopped {
				select {
				case <-ctx.Done():
					return fmt.Errorf("stop %s: %w", AgentService, ctx.Err())
				case <-time.After(200 * time.Millisecond):
				}
				if status, err = s.Query(); err != nil {
					return err
				}
			}
		}
		return s.Start()
	})
}

func setAgentBinary(binary string) error {
	return withAgentService(func(s *mgr.Service) error {
		cfg, err := s.Config()
		if err != nil {
			return err
		}
		cfg.BinaryPathName = agentCommandLine(binary)
		return s.UpdateConfig(cfg)
	})
}

func agentBinary() (string, error) {
	var binary string
	err := withAgentService(func(s *mgr.Service) error {
		cfg, err := s.Config()
		if err == nil {
			binary = cfg.BinaryPathName
		}
		return err
	})
	return binary, err
}

func agentPID() (int, error) {
	var pid int
	err := withAgentService(func(s *mgr.Service) error {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Running || status.ProcessId == 0 {
			return fmt.Errorf("%s is not running", AgentService)
		}
		pid = int(status.ProcessId)
		return nil
	})
	return pid, err
}

// waitAgent waits for the running service process to confirm local readiness.
func waitAgent(ctx context.Context, c config.Config) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return poll(ctx, func() error {
		pid, err := agentPID()
		if err != nil {
			return err
		}
		b, err := os.ReadFile(filepath.Join(filepath.Dir(c.StateDir), "agent-ready.json"))
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

func validInstalledConfig(c config.Config) error {
	if !strings.EqualFold(c.InstallDir, defaultInstallDir) || !strings.EqualFold(c.StateDir, config.DefaultStateDir) {
		return fmt.Errorf("invalid system installation directories")
	}
	if !versionPattern.MatchString(c.Version) || !versionPattern.MatchString(c.Generation) {
		return fmt.Errorf("invalid installed version")
	}
	return nil
}

// StartUpdate runs the updater as a detached process: stopping the agent
// service during activation must not end the update.
func StartUpdate(configPath, manifestURL string) error {
	if err := validateHTTPS(manifestURL); err != nil {
		return err
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(config.DataDir, "update.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(binary, "update", "--config", configPath, "--manifest-url", manifestURL)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// StartUninstall runs the uninstaller as a detached process, like StartUpdate.
// The running binary under Program Files cannot be deleted, so it runs from a
// copy in the Windows temporary directory that removes itself afterwards.
func StartUninstall(configPath string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	temp := filepath.Join(os.Getenv("SystemRoot"), "Temp")
	copyPath := filepath.Join(temp, fmt.Sprintf("hostherd-uninstall-%d.exe", time.Now().UnixNano()))
	if err = copyFile(binary, copyPath); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(temp, "hostherd-uninstall.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(copyPath, "uninstall", "--config", configPath)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err = cmd.Start(); err != nil {
		os.Remove(copyPath)
		return err
	}
	return cmd.Process.Release()
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(target)
	}
	return err
}

// Uninstall removes this installation after an explicit request: running jobs
// and terminals end, the agent service and every runner task are stopped and
// deleted, and ProgramData\Hostherd and Program Files\Hostherd are removed.
func Uninstall(ctx context.Context, configPath string) error {
	if err := requireAdministrator(); err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(configPath), filepath.Clean(config.DefaultPath)) {
		return fmt.Errorf("unexpected configuration path %s", configPath)
	}
	c, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if err = validInstalledConfig(c); err != nil {
		return err
	}
	if err = waitReply(ctx); err != nil {
		return err
	}
	stopRunningWork(ctx, c.StateDir)
	var failures []error
	// The service goes first so it cannot reconnect while the rest is removed.
	if err = removeAgentService(ctx); err != nil {
		failures = append(failures, err)
	}
	generations := map[string]bool{c.Generation: true}
	if entries, err := os.ReadDir(filepath.Join(c.InstallDir, "releases")); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && versionPattern.MatchString(entry.Name()) {
				generations[entry.Name()] = true
			}
		}
	}
	for generation := range generations {
		if err = retireRunner(ctx, generation); err != nil {
			failures = append(failures, err)
		}
	}
	// Ended runners may hold their binaries and sockets briefly.
	for _, dir := range []string{config.DataDir, c.InstallDir} {
		var removeErr error
		for attempt := 0; attempt < 40; attempt++ {
			if removeErr = os.RemoveAll(dir); removeErr == nil {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if removeErr != nil {
			failures = append(failures, removeErr)
		}
	}
	if binary, err := os.Executable(); err == nil && !strings.HasPrefix(strings.ToLower(binary), strings.ToLower(c.InstallDir)+`\`) {
		deleteAfterExit(binary)
	}
	return errors.Join(failures...)
}

// removeAgentService stops the communication service and deletes it.
func removeAgentService(ctx context.Context) error {
	err := withAgentService(func(s *mgr.Service) error {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Stopped {
			if _, err = s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
				return err
			}
			stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			for status.State != svc.Stopped {
				select {
				case <-stopCtx.Done():
					return fmt.Errorf("stop %s: %w", AgentService, stopCtx.Err())
				case <-time.After(200 * time.Millisecond):
				}
				if status, err = s.Query(); err != nil {
					return err
				}
			}
		}
		return s.Delete()
	})
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	return err
}

// deleteAfterExit removes the temporary uninstaller copy once it has exited.
func deleteAfterExit(path string) {
	cmd := exec.Command(system32("cmd.exe"))
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /d /c ping -n 4 127.0.0.1 >nul & del /f /q "` + path + `"`,
		CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err == nil {
		cmd.Process.Release()
	}
}

func Update(ctx context.Context, configPath, manifestURL string) error {
	if err := requireAdministrator(); err != nil {
		return err
	}
	if err := validateHTTPS(manifestURL); err != nil {
		return err
	}
	lock, err := lockUpdates()
	if err != nil {
		return err
	}
	defer store.Unlock(lock)
	c, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if err = validInstalledConfig(c); err != nil {
		return err
	}
	sid, err := accountSID(c.ExecutionUser)
	if err != nil {
		return err
	}
	client := httpClient()
	data, err := download(ctx, client, manifestURL, 1<<20)
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
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("release download: HTTP %d", resp.StatusCode)
	}
	path, err := stageWindowsBinary(c.InstallDir, m.Version, resp.Body, a.SHA256)
	if err != nil {
		return err
	}
	next := c
	next.Version, next.Generation = m.Version, m.Version
	return activate(ctx, configPath, c, next, sid, path)
}

// activate starts the new runner first; old runners keep their jobs. Then the
// agent service switches binaries, rolling back if the new agent is not ready.
func activate(ctx context.Context, configPath string, previous, next config.Config, sid, binary string) error {
	register := func() error { return registerRunner(ctx, next, sid, binary) }
	if sid != windowsSystemSID {
		register = func() error { return registerSuccessorRunner(ctx, previous, next, sid) }
	}
	if err := register(); err != nil {
		return err
	}
	if err := waitRunner(ctx, next); err != nil {
		return fmt.Errorf("new runner failed readiness; previous version remains selected: %w", err)
	}
	previousBinary, err := agentBinary()
	if err != nil {
		return err
	}
	if err = config.Save(configPath, next); err != nil {
		return err
	}
	if err = setAgentBinary(binary); err != nil {
		return errors.Join(err, config.Save(configPath, previous))
	}
	startErr := restartAgent(ctx)
	if startErr == nil {
		startErr = waitAgent(ctx, next)
	}
	if startErr == nil {
		return nil
	}
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	restoreErr := errors.Join(config.Save(configPath, previous), withAgentService(func(s *mgr.Service) error {
		cfg, err := s.Config()
		if err != nil {
			return err
		}
		cfg.BinaryPathName = previousBinary
		return s.UpdateConfig(cfg)
	}))
	restartErr := restartAgent(rollbackCtx)
	if restartErr == nil {
		restartErr = waitAgent(rollbackCtx, previous)
	}
	if rollbackErr := errors.Join(restoreErr, restartErr); rollbackErr != nil {
		return fmt.Errorf("new agent failed (%v); rollback also failed: %w", startErr, rollbackErr)
	}
	return fmt.Errorf("new agent startup failed; previous version restored: %w", startErr)
}

// CleanupRunners retires older, idle runner tasks and their release binaries.
// Job records and unacknowledged output in the runtime directory are kept.
func CleanupRunners(ctx context.Context, c config.Config) error {
	if err := validInstalledConfig(c); err != nil {
		return err
	}
	lock, err := store.Lock(filepath.Join(config.DataDir, "update.lock"), true)
	if err != nil {
		return nil // The updater owns staging and activation while holding this lock.
	}
	defer store.Unlock(lock)
	entries, err := os.ReadDir(filepath.Join(c.InstallDir, "releases"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var failures []error
	for _, entry := range entries {
		generation := entry.Name()
		if !entry.IsDir() || generation == c.Generation {
			continue
		}
		if cmp, err := CompareVersions(generation, c.Version); err != nil || cmp >= 0 {
			continue
		}
		probeCtx, cancel := context.WithTimeout(ctx, time.Second)
		health, err := readRunnerHealth(probeCtx, c.StateDir, generation)
		cancel()
		if err != nil || !health.OK || health.Protocol != 1 || health.Version != generation || health.Active == nil || *health.Active != 0 {
			continue
		}
		if err = retireRunner(ctx, generation); err != nil {
			failures = append(failures, err)
			continue
		}
		// The ended runner may hold its binary briefly.
		var removeErr error
		for attempt := 0; attempt < 20; attempt++ {
			if removeErr = os.RemoveAll(filepath.Join(c.InstallDir, "releases", generation)); removeErr == nil {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if removeErr != nil {
			failures = append(failures, removeErr)
		}
	}
	return errors.Join(failures...)
}
