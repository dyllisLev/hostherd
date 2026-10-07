//go:build linux

package platform

import (
	"bufio"
	"os"
	"os/user"
	"strings"

	"golang.org/x/sys/unix"
)

func LoginShell() string {
	current, err := user.Current()
	if err != nil {
		return "/bin/sh"
	}
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return "/bin/sh"
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Split(s.Text(), ":")
		if len(fields) >= 7 && fields[0] == current.Username && fields[6] != "" {
			return fields[6]
		}
	}
	return "/bin/sh"
}

// pollable moves the terminal master to the poller so that a read deadline
// can end a read that a disowned child would otherwise keep open forever.
func pollable(f *os.File) *os.File {
	fd, err := unix.FcntlInt(f.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return f
	}
	if err = unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return f
	}
	f.Close()
	return os.NewFile(uintptr(fd), f.Name())
}
