//go:build linux || darwin

package platform

import (
	"os"
	"syscall"
)

func stateOwner(stateDir string) (*syscall.Stat_t, error) {
	info, err := os.Stat(stateDir)
	if err != nil {
		return nil, err
	}
	return info.Sys().(*syscall.Stat_t), nil
}

// ShareFileWithStateOwner hands an open file the root agent created in the
// shared state directory to that directory's owner (the runner account). The
// open handle is checked, so a swapped-in hard link is never re-owned.
func ShareFileWithStateOwner(f *os.File, stateDir string) error {
	owner, err := stateOwner(stateDir)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if s := info.Sys().(*syscall.Stat_t); info.Mode().IsRegular() && s.Nlink == 1 && s.Uid != owner.Uid {
		return f.Chown(int(owner.Uid), int(owner.Gid))
	}
	return nil
}

// ShareDirWithStateOwner gives a directory (not a symlink) to the state owner.
func ShareDirWithStateOwner(path, stateDir string) error {
	owner, err := stateOwner(stateDir)
	if err != nil {
		return err
	}
	return os.Lchown(path, int(owner.Uid), int(owner.Gid))
}
