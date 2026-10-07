//go:build windows

package files

import "os"

// keepOwner is a no-op: the replacement inherits the folder's ACL.
func keepOwner(*os.File, os.FileInfo) error { return nil }
