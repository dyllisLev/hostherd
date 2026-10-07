//go:build linux

package install

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"hostherd/agent/internal/config"
)

func testConfig(t *testing.T) (config.Config, string) {
	t.Helper()
	root := t.TempDir()
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	c := config.Config{URL: "https://mcp.example", Token: "test-secret", ServerID: "server", ExecutionUser: u.Username, StateDir: filepath.Join(root, "state", "runtime"), InstallDir: filepath.Join(root, "opt"), Version: "1.0.0", Generation: "1.0.0"}
	if err = os.MkdirAll(c.InstallDir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "etc", "config.json")
	if err = config.Save(path, c); err != nil {
		t.Fatal(err)
	}
	if err = atomicSymlink(filepath.Join(c.InstallDir, "releases", "1.0.0", "hostherd"), filepath.Join(c.InstallDir, "current")); err != nil {
		t.Fatal(err)
	}
	return c, path
}

func TestActivationRollsBackWithoutTouchingRunnerLifetimes(t *testing.T) {
	for _, failure := range []string{"none", "runner", "communication"} {
		t.Run(failure, func(t *testing.T) {
			previous, path := testConfig(t)
			next := previous
			next.Version, next.Generation = "1.1.0", "1.1.0"
			var commands []string
			i := &installer{unitDir: t.TempDir(), run: func(_ context.Context, name string, args ...string) ([]byte, error) {
				commands = append(commands, name+" "+strings.Join(args, " "))
				return nil, nil
			}, runnerReady: func(context.Context, config.Config) error {
				if failure == "runner" {
					return fmt.Errorf("candidate could not initialize")
				}
				return nil
			}, agentReady: func(_ context.Context, c config.Config) error {
				if failure == "communication" && c.Version == next.Version {
					return fmt.Errorf("new agent exited at startup")
				}
				return nil
			}}
			binary := filepath.Join(next.InstallDir, "releases", next.Version, "hostherd")
			err := i.activate(context.Background(), path, previous, next, binary)
			if (err != nil) != (failure != "none") {
				t.Fatalf("activation result: %v", err)
			}
			loaded, e := config.Load(path)
			if e != nil {
				t.Fatal(e)
			}
			target, e := os.Readlink(filepath.Join(previous.InstallDir, "current"))
			if e != nil {
				t.Fatal(e)
			}
			want := next.Version
			if failure != "none" {
				want = previous.Version
			}
			if loaded.Version != want || loaded.Generation != want || target != filepath.Join(previous.InstallDir, "releases", want, "hostherd") {
				t.Fatalf("wrong selected release: %+v %s", loaded, target)
			}
			if loaded.Token != previous.Token || loaded.ExecutionUser != previous.ExecutionUser {
				t.Fatal("update changed enrollment")
			}
			info, e := os.Stat(path)
			if e != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("credential permissions: %v %v", info, e)
			}
			for _, command := range commands {
				if strings.Contains(command, "stop") || strings.Contains(command, "disable") || strings.Contains(command, runnerUnit(previous.Generation)) {
					t.Fatalf("update touched running old runner: %s", command)
				}
			}
			if failure == "runner" {
				for _, command := range commands {
					if strings.Contains(command, "restart") {
						t.Fatal("comm restarted before runner was ready")
					}
				}
			}
			if failure == "communication" && !strings.Contains(err.Error(), "previous version restored") {
				t.Fatal(err)
			}
		})
	}
}

func TestStageRejectsCorruptionAndDoesNotOverwriteInstalledGeneration(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("release installation requires root")
	}
	root := t.TempDir()
	binary := []byte("release one")
	sum := sha256.Sum256(binary)
	digest := hex.EncodeToString(sum[:])
	if _, err := stageBinary(root, "1.0.0", strings.NewReader("broken download"), digest); err == nil {
		t.Fatal("corrupt download staged")
	}
	path, err := stageBinary(root, "1.0.0", bytes.NewReader(binary), digest)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = stageBinary(root, "1.0.0", bytes.NewReader(binary), digest); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(path)
	if !os.SameFile(before, after) {
		t.Fatal("same release replaced inode used by running process")
	}
	other := []byte("different release")
	sum = sha256.Sum256(other)
	if _, err = stageBinary(root, "1.0.0", bytes.NewReader(other), hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("same version changed its binary")
	}
	data, _ := os.ReadFile(path)
	if !bytes.Equal(data, binary) {
		t.Fatal("installed binary was overwritten")
	}
}

func TestInstallDirectoriesIgnoreRestrictiveUmask(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("installation permissions require root")
	}
	u, err := user.Lookup("nobody")
	if err != nil {
		t.Skip("non-root verification account unavailable")
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	// Use a direct /tmp child: testing.T.TempDir has an additional private
	// parent which would prevent the non-root process reaching this fixture.
	base, err := os.MkdirTemp("", "hostherd-install-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(base) })
	if err = os.Chmod(base, 0755); err != nil {
		t.Fatal(err)
	}
	previousMask := syscall.Umask(0077)
	defer syscall.Umask(previousMask)
	configDir := filepath.Join(base, "config")
	installDir := filepath.Join(base, "install")
	stateParent := filepath.Join(base, "state")
	for path, mode := range map[string]os.FileMode{configDir: 0700, installDir: 0755} {
		if err = ensureRootDirectory(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	c := config.Config{ExecutionUser: u.Username, InstallDir: installDir, StateDir: filepath.Join(stateParent, "runtime")}
	if err = provisionState(c); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(configDir, "config.json")
	if err = os.WriteFile(configPath, []byte("private-test-config"), 0600); err != nil {
		t.Fatal(err)
	}
	binary := []byte("#!/bin/sh\n[ ! -r \"$2\" ] || exit 42\nprintf state > \"$1/permission-check\" || exit 43\nprintf installed-ok\n")
	sum := sha256.Sum256(binary)
	for _, version := range []string{"1.2.3", "1.2.4"} {
		path, err := stageBinary(installDir, version, bytes.NewReader(binary), hex.EncodeToString(sum[:]))
		if err != nil {
			t.Fatal(err)
		}
		for dir, want := range map[string]os.FileMode{configDir: 0700, installDir: 0755, filepath.Join(installDir, "releases"): 0755, filepath.Dir(path): 0755, stateParent: 0755, c.StateDir: 0700} {
			info, err := os.Stat(dir)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != want {
				t.Fatalf("%s mode %04o, want %04o under umask 0077", dir, info.Mode().Perm(), want)
			}
		}
		cmd := exec.Command(path, c.StateDir, configPath)
		cmd.Dir = "/"
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{uint32(gid)}}}
		output, err := cmd.CombinedOutput()
		if err != nil || string(output) != "installed-ok" {
			t.Fatalf("registered non-root account cannot execute release/use state: %v %q", err, output)
		}
	}
}

func TestUnitsUseEnrolledAccountAndIndependentServices(t *testing.T) {
	c, cfg := testConfig(t)
	if u, err := user.Lookup("nobody"); err == nil {
		c.ExecutionUser = u.Username
	}
	i := &installer{unitDir: t.TempDir()}
	if err := i.writeRunnerUnit(c, "/opt/hostherd/releases/1.0.0/hostherd"); err != nil {
		t.Fatal(err)
	}
	if err := i.writeAgentUnit(c, cfg); err != nil {
		t.Fatal(err)
	}
	runner, _ := os.ReadFile(filepath.Join(i.unitDir, runnerUnit(c.Generation)))
	agent, _ := os.ReadFile(filepath.Join(i.unitDir, "hostherd-agent.service"))
	u, _ := user.Lookup(c.ExecutionUser)
	if !strings.Contains(string(runner), "User="+u.Uid+"\n") || !strings.Contains(string(runner), "Group="+u.Gid+"\n") || !strings.Contains(string(runner), "TasksMax=infinity") {
		t.Fatalf("incorrect execution account/limits: %s", runner)
	}
	for _, bad := range []string{"PartOf=", "BindsTo=", "Requires=hostherd-agent", "hostherd-agent.service"} {
		if strings.Contains(string(runner), bad) {
			t.Fatalf("runner coupled to comm service: %s", bad)
		}
	}
	if !strings.Contains(string(agent), "User=root") {
		t.Fatal("comm service cannot perform privileged updates")
	}
	if !strings.Contains(string(agent), "\nRestart=always\nRestartSec=3\n") || !strings.Contains(string(runner), "\nRestart=on-failure\nRestartSec=3\nKillMode=process\n") || !strings.Contains(string(runner), "\nUMask=0022\n") {
		t.Fatalf("restart policy: agent %q runner %q", agent, runner)
	}
}

func TestGeneratedRunnerUnitPassesSystemdParser(t *testing.T) {
	analyze, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze unavailable")
	}
	c, _ := testConfig(t)
	i := &installer{unitDir: t.TempDir()}
	if err = i.writeRunnerUnit(c, "/bin/true"); err != nil {
		t.Fatal(err)
	}
	unitPath := filepath.Join(i.unitDir, runnerUnit(c.Generation))
	verify := func(path string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, analyze, "verify", "--generators=no", "--man=no", "--recursive-errors=no", path).CombinedOutput()
	}
	if output, err := verify(unitPath); err != nil {
		t.Fatalf("generated runner unit rejected by systemd: %v\n%s", err, output)
	}
	// Reproduce the deployed failure with the same generated unit so this
	// regression check exercises systemd's path parser, not a string assertion.
	body, err := os.ReadFile(unitPath)
	if err != nil {
		t.Fatal(err)
	}
	u, err := user.Lookup(c.ExecutionUser)
	if err != nil {
		t.Fatal(err)
	}
	broken := strings.Replace(string(body), "WorkingDirectory=~", "WorkingDirectory=\""+u.HomeDir+"\"", 1)
	if err = os.WriteFile(unitPath, []byte(broken), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := verify(unitPath)
	if err == nil || !strings.Contains(string(output), "WorkingDirectory= path is not absolute") {
		t.Fatalf("quoted directory did not reproduce the startup failure: %v\n%s", err, output)
	}
}

func TestRunnerReadinessRequiresMatchingProtocolAndVersion(t *testing.T) {
	c, _ := testConfig(t)
	short, err := os.MkdirTemp("", "hostherd-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(short) })
	c.StateDir = short
	socket := filepath.Join(c.StateDir, "runners", c.Generation, "runner.sock")
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"ok":true,"protocol":1,"version":"1.0.0","active":0}`)
	})}
	go server.Serve(l)
	defer server.Close()
	if err = waitRunner(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	c.Version = "1.1.0"
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if err = waitRunner(ctx, c); err == nil {
		t.Fatal("mismatched new binary reported ready")
	}
}

func TestStartUpdateUsesIndependentSystemdUnit(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "args")
	if err := os.WriteFile(filepath.Join(dir, "systemd-run"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$UPDATE_CAPTURE\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("UPDATE_CAPTURE", capture)
	if err := StartUpdate("/etc/hostherd/config.json", "https://mcp.example/downloads/manifest.json"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	args := string(b)
	for _, want := range []string{"--unit=hostherd-update-", "--property=Type=exec\n", "--property=User=root\n", "\nupdate\n--config\n/etc/hostherd/config.json\n--manifest-url\n"} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %q in %s", want, args)
		}
	}
}

func TestBootstrapVerifiesSignatureAndBinaryBeforeExecuting(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("bootstrap requires root")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("unsupported architecture")
	}
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("OpenSSL unavailable")
	}
	script, err := filepath.Abs("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"none", "signature", "binary"} {
		t.Run(mutation, func(t *testing.T) {
			dir := t.TempDir()
			fixture := filepath.Join(dir, "fixture")
			if err := os.Mkdir(fixture, 0700); err != nil {
				t.Fatal(err)
			}
			binary := []byte("#!/bin/sh\nprintf 'executed' > \"$EXECUTION_MARKER\"\n")
			envelope, key, _ := signedFixture(t, "1.0.0", binary)
			if mutation == "signature" {
				envelope = bytes.Replace(envelope, []byte(`"signature":"`), []byte(`"signature":"AAAA`), 1)
			}
			if mutation == "binary" {
				binary = append(binary, []byte("# tampered\n")...)
			}
			for name, data := range map[string][]byte{"manifest.json": envelope, "release.pub": []byte(key), "hostherd-linux-" + runtime.GOARCH: binary} {
				if err := os.WriteFile(filepath.Join(fixture, name), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			fakeCurl := "#!/bin/sh\nset -eu\nsource=\noutput=\nwhile [ \"$#\" -gt 0 ]; do\n case \"$1\" in\n  -o) output=$2; shift 2 ;;\n  https://gate.example/downloads/*) source=${1##*/}; shift ;;\n  https://*) exit 9 ;;\n  *) shift ;;\n esac\ndone\ncp \"$CURL_FIXTURE/$source\" \"$output\"\n"
			if err := os.WriteFile(filepath.Join(dir, "curl"), []byte(fakeCurl), 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(dir, "executed")
			// The release names another address; everything comes from the given central.
			cmd := exec.Command("sh", script, "--url", "https://gate.example", "--code", "one-time-code")
			cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "CURL_FIXTURE="+fixture, "EXECUTION_MARKER="+marker)
			output, err := cmd.CombinedOutput()
			if mutation == "none" && err != nil {
				t.Fatalf("valid bootstrap: %v: %s", err, output)
			}
			if mutation != "none" && err == nil {
				t.Fatal("tampered release bootstrap succeeded")
			}
			_, markerErr := os.Stat(marker)
			if (markerErr == nil) != (mutation == "none") {
				t.Fatalf("execution before verification for %s: %v: %s", mutation, markerErr, output)
			}
		})
	}
}

func TestCleanupOnlyRetiresOlderIdleRunnerAndPreservesSpool(t *testing.T) {
	c, _ := testConfig(t)
	c.Generation, c.Version = "2.0.0", "2.0.0"
	short, err := os.MkdirTemp("", "hostherd-clean-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(short) })
	c.StateDir = short
	spool := filepath.Join(c.StateDir, "jobs", "unacknowledged-output")
	if err = os.MkdirAll(filepath.Dir(spool), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(spool, []byte("must survive cleanup"), 0600); err != nil {
		t.Fatal(err)
	}
	var commands []string
	i := &installer{unitDir: t.TempDir(), run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		return nil, nil
	}}
	for _, entry := range []struct {
		version string
		active  int
	}{{"1.0.0", 0}, {"1.1.0", 2}, {"2.0.0", 0}, {"3.0.0", 0}} {
		entry := entry
		dir := filepath.Join(c.InstallDir, "releases", entry.version)
		if err = os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "hostherd"), []byte("binary"), 0755); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(i.unitDir, runnerUnit(entry.version)), []byte("unit"), 0644); err != nil {
			t.Fatal(err)
		}
		socket := filepath.Join(c.StateDir, "runners", entry.version, "runner.sock")
		if err = os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
			t.Fatal(err)
		}
		listener, e := net.Listen("unix", socket)
		if e != nil {
			t.Fatal(e)
		}
		server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"ok":true,"protocol":1,"version":%q,"active":%d}`, entry.version, entry.active)
		})}
		go server.Serve(listener)
		t.Cleanup(func() { server.Close() })
	}
	if err = i.cleanup(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"1.0.0", "1.1.0", "2.0.0", "3.0.0"} {
		_, e := os.Stat(filepath.Join(c.InstallDir, "releases", version, "hostherd"))
		if (e == nil) != (version != "1.0.0") {
			t.Errorf("incorrect cleanup of %s: %v", version, e)
		}
	}
	data, err := os.ReadFile(spool)
	if err != nil || string(data) != "must survive cleanup" {
		t.Fatal("output spool changed", err)
	}
	for _, command := range commands {
		if strings.Contains(command, "hostherd-runner-") && !strings.Contains(command, "hostherd-runner-1.0.0.service") {
			t.Fatalf("cleanup touched active/current/candidate runner: %s", command)
		}
	}
}

func TestAgentReadinessRejectsStalePID(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("production readiness requires a root-owned marker")
	}
	c, _ := testConfig(t)
	if err := os.MkdirAll(filepath.Dir(c.StateDir), 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(filepath.Dir(c.StateDir), "agent-ready.json")
	i := &installer{run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "show" {
			return []byte("123\n"), nil
		}
		return nil, nil
	}}
	if err := os.WriteFile(marker, []byte(`{"pid":123,"version":"1.0.0","generation":"1.0.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := i.waitAgent(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte(`{"pid":122,"version":"1.0.0","generation":"1.0.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if err := i.waitAgent(ctx, c); err == nil {
		t.Fatal("stale agent marker was accepted")
	}
}
