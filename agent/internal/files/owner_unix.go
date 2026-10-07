//go:build linux || darwin

package files

import (
	"os"
	"syscall"
)

// keepOwner gives a replacement the replaced file's owner when the runner runs
// as root; other accounts can only create files they own.
func keepOwner(f *os.File, replaced os.FileInfo) error {
	s, ok := replaced.Sys().(*syscall.Stat_t)
	if !ok || os.Geteuid() != 0 {
		return nil
	}
	return f.Chown(int(s.Uid), int(s.Gid))
}
