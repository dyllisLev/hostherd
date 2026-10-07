//go:build linux || darwin

package store

import (
	"os"
	"syscall"
)

// The root agent reads state the runner account can replace: never follow a
// planted symlink or block on a FIFO.
const readFlags = os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
