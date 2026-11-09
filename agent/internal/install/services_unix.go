//go:build linux || darwin

package install

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
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

// On macOS the runner is a LaunchAgent in the execution user's login session
// (gui/<uid>), so its commands can reach that user's TCC-protected data and
// GUI services. The communication agent stays a root LaunchDaemon.
func (i *installer) isRunner(unit string) bool { return i.launchd && unit != agentUnit }
func (i *installer) serviceDir(unit string) string {
	if i.isRunner(unit) {
		return i.runnerDir
	}
	return i.unitDir
}
func (i *installer) servicePath(unit string) string {
	return filepath.Join(i.serviceDir(unit), i.serviceFile(unit))
}
func (i *installer) launchdDomain(unit string) string {
	if i.isRunner(unit) {
		return i.runnerDomain
	}
	return "system"
}

// removeService deletes the unit file. A runner installed before the move to
// login sessions also left a plist under LaunchDaemons.
func (i *installer) removeService(unit string) error {
	paths := []string{i.servicePath(unit)}
	if i.isRunner(unit) {
		paths = append(paths, filepath.Join(i.unitDir, i.serviceFile(unit)))
	}
	var failures []error
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// bindAccount selects the macOS login session and LaunchAgents directory of
// the enrolled execution user. It does nothing on Linux.
func (i *installer) bindAccount(name string) error {
	if !i.launchd {
		return nil
	}
	u, err := lookupSystemAccount(name)
	if err != nil {
		return err
	}
	i.runnerDir = filepath.Join(u.HomeDir, "Library", "LaunchAgents")
	i.runnerDomain = "gui/" + u.Uid
	return nil
}
func (i *installer) startService(ctx context.Context, unit string) ([]byte, error) {
	if !i.launchd {
		return i.run(ctx, "systemctl", "enable", "--now", unit)
	}
	domain := i.launchdDomain(unit)
	target := domain + "/" + launchdLabel(unit)
	// Never restart a reused generation: it may already own live work.
	if b, err := i.run(ctx, "/bin/launchctl", "print", target); err == nil {
		if _, err := launchdPID(b); err == nil {
			return nil, nil
		}
		// A staged runner that never started can be retried. Without -k,
		// kickstart also preserves a process that started after the probe.
		return i.run(ctx, "/bin/launchctl", "kickstart", target)
	}
	if i.isRunner(unit) {
		if _, err := i.run(ctx, "/bin/launchctl", "print", domain); err != nil {
			return nil, fmt.Errorf("no login session for the execution user; sign in to the Mac (automatic login keeps it available) and retry: %w", err)
		}
	}
	if _, err := i.run(ctx, "/bin/launchctl", "enable", target); err != nil {
		return nil, err
	}
	return i.run(ctx, "/bin/launchctl", "bootstrap", domain, i.servicePath(unit))
}
func (i *installer) stopService(ctx context.Context, unit string) ([]byte, error) {
	if i.launchd {
		b, err := i.run(ctx, "/bin/launchctl", "bootout", i.launchdDomain(unit)+"/"+launchdLabel(unit))
		if err != nil && i.isRunner(unit) {
			// A runner started before the move to login sessions is a system job.
			return i.run(ctx, "/bin/launchctl", "bootout", "system/"+launchdLabel(unit))
		}
		return b, err
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

// launchdPlist describes a job. A session job is a LaunchAgent that launchd runs
// as the logged-in user, so it names no UserName, GroupName or InitGroups.
func launchdPlist(label string, args []string, username, group, home string, umask int, keepAlive string, session bool) string {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key>" + plistString(label) + "\n<key>ProgramArguments</key><array>")
	for _, arg := range args {
		b.WriteString(plistString(arg))
	}
	b.WriteString("</array>")
	if session {
		b.WriteString("\n<key>LimitLoadToSessionType</key><string>Aqua</string>")
	} else {
		b.WriteString("\n<key>UserName</key>" + plistString(username))
		if group != "" {
			b.WriteString("\n<key>GroupName</key>" + plistString(group))
		}
		if home != "" {
			b.WriteString("\n<key>InitGroups</key><true/>")
		}
	}
	if home != "" {
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
	// The user owns LaunchAgents; create the directory for them when missing.
	if _, err := os.Stat(i.runnerDir); os.IsNotExist(err) {
		uid, uidErr := strconv.Atoi(u.Uid)
		gid, gidErr := strconv.Atoi(u.Gid)
		if err := errors.Join(uidErr, gidErr); err != nil {
			return err
		}
		if err := os.MkdirAll(i.runnerDir, 0755); err != nil {
			return err
		}
		if err := os.Chown(i.runnerDir, uid, gid); err != nil {
			return err
		}
	}
	plist := launchdPlist(launchdLabel(runnerUnit(c.Generation)), []string{binary, "runner", "--state-dir", c.StateDir, "--generation", c.Generation}, u.Username, u.GroupName, u.HomeDir, 0o22, "<dict><key>SuccessfulExit</key><false/></dict>", true)
	return i.writeUnitIn(i.runnerDir, i.serviceFile(runnerUnit(c.Generation)), plist)
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
	_, err = f.WriteString(launchdPlist(label, args, "root", "", "", 0o77, "", false))
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
