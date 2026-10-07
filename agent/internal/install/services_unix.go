//go:build linux || darwin

package install

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"hostherd/agent/internal/config"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const agentLabel = "io.hostherd.agent"
const updaterLabel = "io.hostherd.update"
const uninstallerLabel = "io.hostherd.uninstall"
const agentUnit = "hostherd-agent.service"

func serviceUnitDir() string {
	if runtime.GOOS == "darwin" {
		return "/Library/LaunchDaemons"
	}
	return "/etc/systemd/system"
}
func launchdLabel(unit string) string {
	if unit == agentUnit {
		return agentLabel
	}
	return "io.hostherd.runner." + strings.TrimSuffix(strings.TrimPrefix(unit, "hostherd-runner-"), ".service")
}

func (i *installer) serviceFile(unit string) string {
	if i.launchd {
		return launchdLabel(unit) + ".plist"
	}
	return unit
}
func (i *installer) reloadServices(ctx context.Context) ([]byte, error) {
	if i.launchd {
		return nil, nil
	}
	return i.run(ctx, "systemctl", "daemon-reload")
}
func (i *installer) startService(ctx context.Context, unit string) ([]byte, error) {
	if !i.launchd {
		return i.run(ctx, "systemctl", "enable", "--now", unit)
	}
	target := "system/" + launchdLabel(unit)
	// Never restart a reused generation: it may already own live work.
	if b, err := i.run(ctx, "/bin/launchctl", "print", target); err == nil {
		if _, err := launchdPID(b); err == nil {
			return nil, nil
		}
		// A staged runner that never started can be retried. Without -k,
		// kickstart also preserves a process that started after the probe.
		return i.run(ctx, "/bin/launchctl", "kickstart", target)
	}
	if _, err := i.run(ctx, "/bin/launchctl", "enable", target); err != nil {
		return nil, err
	}
	return i.run(ctx, "/bin/launchctl", "bootstrap", "system", filepath.Join(i.unitDir, i.serviceFile(unit)))
}
func (i *installer) stopService(ctx context.Context, unit string) ([]byte, error) {
	if i.launchd {
		return i.run(ctx, "/bin/launchctl", "bootout", "system/"+launchdLabel(unit))
	}
	return i.run(ctx, "systemctl", "stop", unit)
}
func (i *installer) disableService(ctx context.Context, unit string) ([]byte, error) {
	// Removing the plist after bootout prevents loading on the next boot.
	if i.launchd {
		return nil, nil
	}
	return i.run(ctx, "systemctl", "disable", unit)
}
func (i *installer) restartAgent(ctx context.Context) ([]byte, error) {
	if !i.launchd {
		return i.run(ctx, "systemctl", "restart", agentUnit)
	}
	target := "system/" + launchdLabel(agentUnit)
	if _, err := i.run(ctx, "/bin/launchctl", "print", target); err != nil {
		return i.startService(ctx, agentUnit)
	}
	return i.run(ctx, "/bin/launchctl", "kickstart", "-k", target)
}
func (i *installer) agentPID(ctx context.Context) (int, error) {
	if i.launchd {
		b, err := i.run(ctx, "/bin/launchctl", "print", "system/"+launchdLabel(agentUnit))
		if err != nil {
			return 0, err
		}
		return launchdPID(b)
	}
	if _, err := i.run(ctx, "systemctl", "is-active", "--quiet", agentUnit); err != nil {
		return 0, err
	}
	b, err := i.run(ctx, "systemctl", "show", "--property=MainPID", "--value", agentUnit)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("communication agent has no running PID")
	}
	return pid, nil
}
func launchdPID(b []byte) (int, error) {
	depth := 0
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if depth == 1 && strings.HasPrefix(line, "pid = ") {
			pid, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "pid = ")))
			if err == nil && pid > 0 {
				return pid, nil
			}
		}
		if strings.HasSuffix(line, "{") {
			depth++
		}
		if line == "}" {
			depth--
		}
	}
	return 0, fmt.Errorf("launchd job has no running PID")
}
func plistString(value string) string {
	var b bytes.Buffer
	xml.EscapeText(&b, []byte(value))
	return "<string>" + b.String() + "</string>"
}
func launchdPlist(label string, args []string, username, group, home string, umask int, keepAlive string) string {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key>" + plistString(label) + "\n<key>ProgramArguments</key><array>")
	for _, arg := range args {
		b.WriteString(plistString(arg))
	}
	b.WriteString("</array>\n<key>UserName</key>" + plistString(username))
	if group != "" {
		b.WriteString("\n<key>GroupName</key>" + plistString(group))
	}
	if home != "" {
		b.WriteString("\n<key>InitGroups</key><true/>")
		b.WriteString("\n<key>WorkingDirectory</key>" + plistString(home))
	}
	b.WriteString("\n<key>RunAtLoad</key><true/>\n<key>Umask</key><integer>" + strconv.Itoa(umask) + "</integer>\n<key>ExitTimeOut</key><integer>30</integer>\n")
	if keepAlive != "" {
		b.WriteString("<key>KeepAlive</key>" + keepAlive + "\n<key>ThrottleInterval</key><integer>3</integer>\n")
	}
	// A runner failure must not tear down independent command/PTY children.
	b.WriteString("<key>AbandonProcessGroup</key><true/>\n")
	b.WriteString("<key>EnvironmentVariables</key><dict><key>PATH</key>" + plistString("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin") + "\n")
	if home != "" {
		b.WriteString("<key>HOME</key>" + plistString(home) + "<key>USER</key>" + plistString(username) + "<key>LOGNAME</key>" + plistString(username))
	}
	b.WriteString("</dict>\n</dict></plist>\n")
	return b.String()
}
func (i *installer) writeLaunchdRunner(c config.Config, binary string) error {
	if !versionPattern.MatchString(c.Generation) {
		return fmt.Errorf("invalid runner generation")
	}
	u, err := lookupSystemAccount(c.ExecutionUser)
	if err != nil {
		return err
	}
	return i.writeUnit(i.serviceFile(runnerUnit(c.Generation)), launchdPlist(launchdLabel(runnerUnit(c.Generation)), []string{binary, "runner", "--state-dir", c.StateDir, "--generation", c.Generation}, u.Username, u.GroupName, u.HomeDir, 0o22, "<dict><key>SuccessfulExit</key><false/></dict>"))
}
func (i *installer) startLaunchdUpdate(ctx context.Context, binary, path, manifest string) error {
	return i.startLaunchdOneShot(ctx, updaterLabel, []string{binary, "update", "--config", path, "--manifest-url", manifest}, path, "another agent update is running")
}

// startLaunchdOneShot runs one nonpersistent root job; it never stops a job
// with a running PID.
func (i *installer) startLaunchdOneShot(ctx context.Context, label string, args []string, path, busy string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("updates must run as root")
	}
	target := "system/" + label
	if b, err := i.run(ctx, "/bin/launchctl", "print", target); err == nil {
		if _, err := launchdPID(b); err == nil {
			return fmt.Errorf("%s", busy)
		}
		if _, err := i.run(ctx, "/bin/launchctl", "bootout", target); err != nil {
			return err
		}
	}
	if err := rootPrivateFile(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".update-*.plist")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.WriteString(launchdPlist(label, args, "root", "", "", 0o77, ""))
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// bootstrap consumes the plist. Outside LaunchDaemons, it won't resume at boot.
	_, err = i.run(ctx, "/bin/launchctl", "bootstrap", "system", f.Name())
	return err
}
