//go:build windows

package store

import "os"

// Creating symlinks needs a privilege on Windows; a plain open suffices.
const readFlags = os.O_RDONLY
