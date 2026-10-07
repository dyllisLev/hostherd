//go:build linux || darwin

// Package platform isolates operating system process and PTY details from the wire protocol.
package platform

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
	"hostherd/agent/internal/model"
)

func Command(p model.StartParams, terminal bool) *exec.Cmd {
	shell := LoginShell()
	var cmd *exec.Cmd
	if terminal {
		cmd = exec.Command(shell, "-l")
	} else {
		cmd = exec.Command(shell, "-c", p.Cmd)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	}
	cmd.Dir = p.Path
	env := map[string]string{}
	for _, entry := range os.Environ() {
		key, val, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = val
		}
	}
	if current, err := user.Current(); err == nil {
		env["HOME"] = current.HomeDir
		env["USER"] = current.Username
		env["LOGNAME"] = current.Username
	}
	env["SHELL"] = shell
	if env["PATH"] == "" {
		env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	if terminal {
		env["TERM"] = "xterm-256color"
		env["COLORTERM"] = "truecolor"
	}
	for key, val := range p.Env {
		env[key] = val
	}
	for key, val := range env {
		cmd.Env = append(cmd.Env, key+"="+val)
	}
	return cmd
}

type unixPTY struct{ *os.File }

// Resize avoids Fd(), which would put the terminal back into blocking mode.
func (t unixPTY) Resize(cols, rows uint16) error {
	c, err := t.SyscallConn()
	if err != nil {
		return err
	}
	controlErr := c.Control(func(fd uintptr) {
		err = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
	})
	return errors.Join(controlErr, err)
}

// StartPTY starts cmd as a login shell on a new pseudo-terminal.
func StartPTY(cmd *exec.Cmd, cols, rows uint16) (PTY, Process, error) {
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, nil, err
	}
	return unixPTY{pollable(f)}, Started(cmd), nil
}

// Terminate signals the job's process group: SIGTERM first, SIGKILL when forced.
// A group that already exited is not an error.
func Terminate(pid int, force bool) error {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	if err := syscall.Kill(-pid, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// ExitSignal names the signal that ended a process, if any.
func ExitSignal(err error) string {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return status.Signal().String()
		}
	}
	return ""
}

// CheckDirectory reports whether the runner account may enter path.
func CheckDirectory(path string) error { return syscall.Access(path, 1) } // X_OK

// SecureSocket restricts the runner socket to its owner.
func SecureSocket(path string) error { return os.Chmod(path, 0600) }

// SetCommandUmask gives commands, terminals and files the usual umask 022
// whatever the service manager set; runtime state uses explicit modes.
func SetCommandUmask() { syscall.Umask(0o022) }
