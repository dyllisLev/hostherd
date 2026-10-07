//go:build linux || darwin

package install

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"hostherd/agent/internal/config"
	"io"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func launchdTestConfig(t *testing.T) (config.Config, string) {
	t.Helper()
	root := t.TempDir()
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	c := config.Config{URL: "https://mcp.example", Token: "test", ExecutionUser: u.Username, StateDir: filepath.Join(root, "runtime"), InstallDir: filepath.Join(root, "opt"), Version: "1.0.0", Generation: "1.0.0"}
	if err := os.MkdirAll(c.InstallDir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config.json")
	if err := config.Save(path, c); err != nil {
		t.Fatal(err)
	}
	if err := atomicSymlink(filepath.Join(c.InstallDir, "releases", c.Version, "hostherd"), filepath.Join(c.InstallDir, "current")); err != nil {
		t.Fatal(err)
	}
	return c, path
}
func TestLaunchdActivationPreservesGenerationsAndRollsBack(t *testing.T) {
	for _, failure := range []string{"none", "runner", "agent"} {
		t.Run(failure, func(t *testing.T) {
			previous, path := launchdTestConfig(t)
			next := previous
			next.Version, next.Generation = "1.1.0", "1.1.0"
			var commands []string
			i := &installer{launchd: true, unitDir: t.TempDir(), run: func(_ context.Context, name string, args ...string) ([]byte, error) {
				commands = append(commands, name+" "+strings.Join(args, " "))
				if args[0] == "print" && args[1] != "system/"+agentLabel {
					return nil, fmt.Errorf("not loaded")
				}
				return nil, nil
			}, runnerReady: func(context.Context, config.Config) error {
				if failure == "runner" {
					return fmt.Errorf("failed")
				}
				return nil
			}, agentReady: func(_ context.Context, c config.Config) error {
				if failure == "agent" && c.Version == next.Version {
					return fmt.Errorf("failed")
				}
				return nil
			}}
			binary := filepath.Join(next.InstallDir, "releases", next.Version, "hostherd")
			err := i.activate(context.Background(), path, previous, next, binary)
			if (err != nil) != (failure != "none") {
				t.Fatalf("result %v", err)
			}
			loaded, err := config.Load(path)
			if err != nil {
				t.Fatal(err)
			}
			want := next.Version
			if failure != "none" {
				want = previous.Version
			}
			link, _ := os.Readlink(filepath.Join(previous.InstallDir, "current"))
			if loaded.Version != want || link != filepath.Join(previous.InstallDir, "releases", want, "hostherd") {
				t.Fatalf("selection %s %s", loaded.Version, link)
			}
			kicks := 0
			for _, command := range commands {
				if strings.Contains(command, "kickstart") {
					kicks++
				}
				if strings.Contains(command, "bootout") || strings.Contains(command, "systemctl") || strings.Contains(command, "runner.1.0.0") {
					t.Fatalf("disturbed runner: %s", command)
				}
			}
			wantKicks := 1
			if failure == "runner" {
				wantKicks = 0
			}
			if failure == "agent" {
				wantKicks = 2
			}
			if kicks != wantKicks {
				t.Fatalf("agent restarts = %d want %d", kicks, wantKicks)
			}
		})
	}
}
func TestLaunchdPlistUsesRealAccountAndEscapedArguments(t *testing.T) {
	c, path := launchdTestConfig(t)
	i := &installer{launchd: true, unitDir: t.TempDir()}
	binary := filepath.Join(c.InstallDir, "a & b <c>")
	if err := i.writeRunnerUnit(c, binary); err != nil {
		t.Fatal(err)
	}
	if err := i.writeAgentUnit(c, path); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(i.unitDir, i.serviceFile(runnerUnit(c.Generation))))
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Dict struct {
			Array struct {
				Strings []string `xml:"string"`
			} `xml:"array"`
		} `xml:"dict"`
	}
	if err := xml.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	wantArgs := []string{binary, "runner", "--state-dir", c.StateDir, "--generation", c.Generation}
	if fmt.Sprint(decoded.Dict.Array.Strings) != fmt.Sprint(wantArgs) {
		t.Fatalf("decoded arguments %q", decoded.Dict.Array.Strings)
	}
	d := xml.NewDecoder(strings.NewReader(string(b)))
	for {
		_, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	u, _ := user.Current()
	group, _ := user.LookupGroupId(u.Gid)
	for _, part := range []string{"<key>UserName</key>" + plistString(u.Username), "<key>GroupName</key>" + plistString(group.Name), "<key>InitGroups</key><true/>", "<key>HOME</key>" + plistString(u.HomeDir), plistString(binary), "/opt/homebrew/bin:/opt/homebrew/sbin:", "<key>AbandonProcessGroup</key><true/>", "<key>Umask</key><integer>18</integer>", "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"} {
		if !strings.Contains(string(b), part) {
			t.Fatalf("missing %s", part)
		}
	}
	b, _ = os.ReadFile(filepath.Join(i.unitDir, agentLabel+".plist"))
	if !strings.Contains(string(b), "<key>UserName</key><string>root</string>") || !strings.Contains(string(b), "<key>KeepAlive</key><true/>") {
		t.Fatal("agent identity/restart policy")
	}
}

func TestLaunchdCleanupOnlyBootsOutOlderIdleRunner(t *testing.T) {
	c, _ := launchdTestConfig(t)
	c.Version, c.Generation = "2.0.0", "2.0.0"
	// Short root avoids Unix socket length limits, particularly on Darwin.
	state, err := os.MkdirTemp("/tmp", "mc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(state)
	c.StateDir = state
	i := &installer{launchd: true, unitDir: t.TempDir()}
	var commands []string
	i.run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		return nil, nil
	}
	for generation, active := range map[string]int{"1.0.0": 0, "1.1.0": 1, "2.0.0": 0, "3.0.0": 0} {
		dir := filepath.Join(c.InstallDir, "releases", generation)
		os.MkdirAll(dir, 0755)
		runtimeDir := filepath.Join(state, "runners", generation)
		os.MkdirAll(runtimeDir, 0700)
		spool := filepath.Join(runtimeDir, "output")
		os.WriteFile(spool, []byte("unacknowledged"), 0600)
		socket, err := net.Listen("unix", filepath.Join(runtimeDir, "runner.sock"))
		if err != nil {
			t.Fatal(err)
		}
		generation, active := generation, active
		server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"ok":true,"protocol":1,"version":%q,"active":%d}`, generation, active)
		})}
		go server.Serve(socket)
		defer server.Close()
	}
	if err := i.cleanup(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	if strings.Join(commands, "\n") != "/bin/launchctl bootout system/io.hostherd.runner.1.0.0" {
		t.Fatalf("commands %v", commands)
	}
	if _, err := os.Stat(filepath.Join(c.InstallDir, "releases", "1.0.0")); !os.IsNotExist(err) {
		t.Fatal("idle release remains")
	}
	if b, err := os.ReadFile(filepath.Join(state, "runners", "1.0.0", "output")); err != nil || string(b) != "unacknowledged" {
		t.Fatal("spool lost")
	}
}
func TestLaunchdReadinessRejectsStalePID(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-only readiness marker")
	}
	c, _ := launchdTestConfig(t)
	marker := filepath.Join(filepath.Dir(c.StateDir), "agent-ready.json")
	b, _ := json.Marshal(map[string]any{"pid": 42, "version": c.Version, "generation": c.Generation})
	os.WriteFile(marker, b, 0600)
	i := &installer{launchd: true, run: func(context.Context, string, ...string) ([]byte, error) {
		return []byte("system/io.hostherd.agent = {\n state = running\n pid = 43\n}\n"), nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := i.waitAgent(ctx, c); err == nil {
		t.Fatal("accepted stale marker")
	}
	b, _ = json.Marshal(map[string]any{"pid": 43, "version": c.Version, "generation": c.Generation})
	os.WriteFile(marker, b, 0600)
	if err := i.waitAgent(context.Background(), c); err != nil {
		t.Fatal(err)
	}
}
func TestLaunchdUpdateIsIndependentAndDoesNotRestartOnFailure(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root updater")
	}
	_, path := launchdTestConfig(t)
	var commands []string
	var temporary string
	i := &installer{launchd: true, run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		if args[0] == "print" {
			return []byte("system/io.hostherd.update = {\n state = not running\n}\n"), nil
		}
		if args[0] == "bootstrap" {
			temporary = args[2]
			b, err := os.ReadFile(temporary)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(b), "KeepAlive") || !strings.Contains(string(b), "<string>update</string>") || !strings.Contains(string(b), "<string>root</string>") {
				t.Fatal("invalid updater job")
			}
		}
		return nil, nil
	}}
	if err := i.startLaunchdUpdate(context.Background(), "/opt/hostherd/current", path, "https://example.com/manifest.json"); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 3 || !strings.Contains(commands[1], "bootout system/io.hostherd.update") {
		t.Fatalf("commands %v", commands)
	}
	if _, err := os.Stat(temporary); !os.IsNotExist(err) {
		t.Fatal("persistent updater plist left behind")
	}
	i.run = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("system/io.hostherd.update = {\n pid = 99\n}\n"), nil
	}
	if err := i.startLaunchdUpdate(context.Background(), "/opt/hostherd/current", path, "https://example.com/manifest.json"); err == nil {
		t.Fatal("interrupted running updater")
	}
}

func TestLaunchdStartReusesLiveRunnerAndRetriesInactiveCandidate(t *testing.T) {
	for _, running := range []bool{false, true} {
		var commands []string
		i := &installer{launchd: true, run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			commands = append(commands, strings.Join(args, " "))
			pid := ""
			if running {
				pid = "pid = 123\n"
			}
			return []byte("system/io.hostherd.runner.1.1.0 = {\n" + pid + "}\n"), nil
		}}
		if _, err := i.startService(context.Background(), runnerUnit("1.1.0")); err != nil {
			t.Fatal(err)
		}
		want := 1
		if !running {
			want = 2
		}
		if len(commands) != want {
			t.Fatalf("commands %v", commands)
		}
		if !running && commands[1] != "kickstart system/io.hostherd.runner.1.1.0" {
			t.Fatalf("unsafe retry: %v", commands)
		}
	}
}
