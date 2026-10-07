//go:build linux || darwin

package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hostherd/agent/internal/config"
)

func TestUninstallStopsEveryServiceAndRemovesTheInstallation(t *testing.T) {
	for _, launchd := range []bool{false, true} {
		t.Run(map[bool]string{false: "systemd", true: "launchd"}[launchd], func(t *testing.T) {
			root := t.TempDir()
			c := config.Config{StateDir: filepath.Join(root, "var", "runtime"), InstallDir: filepath.Join(root, "opt"), Version: "1.1.0", Generation: "1.1.0"}
			configPath := filepath.Join(root, "etc", "config.json")
			for _, dir := range []string{c.StateDir, filepath.Join(c.InstallDir, "releases", "1.1.0"), filepath.Dir(configPath)} {
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(configPath, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			var commands []string
			i := &installer{launchd: launchd, unitDir: filepath.Join(root, "units"), run: func(_ context.Context, name string, args ...string) ([]byte, error) {
				commands = append(commands, name+" "+strings.Join(args, " "))
				return nil, nil
			}}
			units := []string{agentUnit, runnerUnit("1.0.0"), runnerUnit("1.1.0")}
			for _, unit := range units {
				if err := i.writeUnit(i.serviceFile(unit), "unit"); err != nil {
					t.Fatal(err)
				}
			}
			unrelated := filepath.Join(i.unitDir, "other.service")
			if err := os.WriteFile(unrelated, nil, 0644); err != nil {
				t.Fatal(err)
			}
			if err := i.uninstall(context.Background(), configPath, c); err != nil {
				t.Fatal(err)
			}
			for _, unit := range units {
				if _, err := os.Lstat(filepath.Join(i.unitDir, i.serviceFile(unit))); !os.IsNotExist(err) {
					t.Fatalf("%s remains: %v", unit, err)
				}
				stop := "systemctl stop " + unit
				if launchd {
					stop = "/bin/launchctl bootout system/" + launchdLabel(unit)
				}
				if !strings.Contains(strings.Join(commands, "\n"), stop) {
					t.Fatalf("%s was not stopped:\n%s", unit, strings.Join(commands, "\n"))
				}
			}
			if !strings.HasSuffix(commands[0], agentUnit) && !strings.HasSuffix(commands[0], agentLabel) {
				t.Fatalf("the communication service must stop first: %v", commands)
			}
			if _, err := os.Stat(unrelated); err != nil {
				t.Fatalf("an unrelated unit was removed: %v", err)
			}
			for _, dir := range []string{c.InstallDir, filepath.Dir(c.StateDir), filepath.Dir(configPath)} {
				if _, err := os.Lstat(dir); !os.IsNotExist(err) {
					t.Fatalf("%s remains: %v", dir, err)
				}
			}
		})
	}
}
