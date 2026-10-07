//go:build linux || darwin

package platform

import (
	"io"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"syscall"
	"testing"

	"github.com/creack/pty"
	"hostherd/agent/internal/model"
)

func TestCommandUsesRunnerAccountAndExplicitEnvironment(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", "/incorrect-inherited-home")
	t.Setenv("USER", "incorrect-inherited-user")
	t.Setenv("SHELL", "/incorrect-inherited-shell")
	cmd := Command(model.StartParams{Path: t.TempDir(), Cmd: "printf '%s' \"$HOSTHERD_VALUE\"", Env: map[string]string{"HOSTHERD_VALUE": "hello mac"}}, false)
	env := map[string]string{}
	for _, entry := range cmd.Env {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	if env["HOME"] != current.HomeDir || env["USER"] != current.Username || env["LOGNAME"] != current.Username || env["SHELL"] != cmd.Path {
		t.Fatalf("command did not use runner account: HOME=%q USER=%q LOGNAME=%q SHELL=%q", env["HOME"], env["USER"], env["LOGNAME"], env["SHELL"])
	}
	output, err := cmd.Output()
	if err != nil || string(output) != "hello mac" {
		t.Fatalf("command output %q: %v", output, err)
	}
}

func TestCommandAndPTYHaveIndependentProcessGroups(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		name := "command"
		if terminal {
			name = "pty"
		}
		t.Run(name, func(t *testing.T) {
			var cmd *exec.Cmd
			var input io.WriteCloser
			var terminalPTY PTY
			if terminal {
				cmd = exec.Command("/bin/sh")
				f, _, err := StartPTY(cmd, 80, 24)
				if err != nil {
					t.Fatal(err)
				}
				input, terminalPTY = f, f
			} else {
				cmd = Command(model.StartParams{Path: t.TempDir(), Cmd: "read -r line"}, false)
				read, write, err := os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				defer read.Close()
				input = write
				cmd.Stdin = read
				if err := cmd.Start(); err != nil {
					write.Close()
					t.Fatal(err)
				}
			}
			defer input.Close()
			defer func() {
				Terminate(cmd.Process.Pid, true)
				cmd.Wait()
			}()
			group, err := syscall.Getpgid(cmd.Process.Pid)
			if err != nil || group != cmd.Process.Pid || group == syscall.Getpgrp() {
				t.Fatalf("process group = %d for pid %d: %v", group, cmd.Process.Pid, err)
			}
			if terminal {
				if err := terminalPTY.Resize(132, 41); err != nil {
					t.Fatal(err)
				}
				size, err := pty.GetsizeFull(terminalPTY.(unixPTY).File)
				if err != nil || size.Cols != 132 || size.Rows != 41 {
					t.Fatalf("PTY size = %+v: %v", size, err)
				}
			}
		})
	}
}
