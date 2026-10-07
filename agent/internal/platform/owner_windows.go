//go:build windows

package platform

import "os"

// On Windows the runtime directory's inherited ACL grants the runner account
// access to everything the agent creates there; ownership is not changed.
func ShareFileWithStateOwner(*os.File, string) error { return nil }
func ShareDirWithStateOwner(string, string) error    { return nil }
