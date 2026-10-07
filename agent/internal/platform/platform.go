package platform

import (
	"io"
	"os/exec"
)

// Process is a started command or terminal shell.
type Process interface {
	Pid() int
	// Wait returns nil for exit status 0, otherwise an error with ExitCode().
	Wait() error
}

// PTY is the controlling side of a terminal session.
type PTY interface {
	io.ReadWriteCloser
	Resize(cols, rows uint16) error
}

type cmdProcess struct{ cmd *exec.Cmd }

func (p cmdProcess) Pid() int    { return p.cmd.Process.Pid }
func (p cmdProcess) Wait() error { return p.cmd.Wait() }

// Started wraps a command already started with cmd.Start.
func Started(cmd *exec.Cmd) Process { return cmdProcess{cmd} }
