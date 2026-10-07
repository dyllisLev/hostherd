//go:build darwin

package platform

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func LoginShell() string {
	// macOS stores user accounts in Open Directory, not /etc/passwd.
	// Query the runner's OS identity rather than an inherited SHELL or USER.
	uid := strconv.Itoa(os.Getuid())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, "/usr/bin/dscacheutil", "-q", "user", "-a", "uid", uid).Output()
	if err == nil {
		if shell := directoryShell(string(data), uid); shell != "" {
			return shell
		}
	}
	return "/bin/sh"
}

func directoryShell(record, uid string) string {
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(record), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	shell := fields["shell"]
	if fields["uid"] != uid || !filepath.IsAbs(shell) || strings.ContainsAny(shell, "\x00\r\n") {
		return ""
	}
	return shell
}

// pollable keeps the blocking terminal master on macOS, where kqueue support for
// terminals is not relied upon. A disowned child that keeps the terminal open
// keeps it running until that child exits.
func pollable(f *os.File) *os.File { return f }
