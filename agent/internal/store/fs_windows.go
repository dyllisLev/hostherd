//go:build windows

package store

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func Lock(path string, nonblocking bool) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK)
	if nonblocking {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	if err = windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &windows.Overlapped{}); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func Unlock(f *os.File) {
	windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &windows.Overlapped{})
	f.Close()
}

// ReplaceFile renames tmp over path. A concurrent reader without delete sharing
// briefly blocks the replace on Windows, so access denials are retried.
func ReplaceFile(tmp, path string) error {
	var err error
	for attempt := 0; attempt < 50; attempt++ {
		if err = os.Rename(tmp, path); err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
	return err
}

// SyncDir is a no-op: NTFS journals the rename and directories cannot be flushed.
func SyncDir(string) error { return nil }
