//go:build windows

package config

import (
	"os"
	"path/filepath"
)

// ProgramData is restricted to SYSTEM and Administrators by the installer;
// only the runtime subdirectory is shared with the execution account.
var (
	DataDir         = filepath.Join(programData(), "Hostherd")
	DefaultPath     = filepath.Join(DataDir, "config.json")
	DefaultStateDir = filepath.Join(DataDir, "runtime")
)

func programData() string {
	if dir := os.Getenv("ProgramData"); dir != "" {
		return dir
	}
	return `C:\ProgramData`
}
