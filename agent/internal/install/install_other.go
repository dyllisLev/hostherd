//go:build !linux && !darwin && !windows

package install

import (
	"context"
	"fmt"
	"hostherd/agent/internal/config"
)

func Install(context.Context, string, string, string, Options) error {
	return fmt.Errorf("the automatic installer currently supports Linux and macOS only")
}
func Update(context.Context, string, string) error {
	return fmt.Errorf("the automatic updater currently supports Linux and macOS only")
}
func StartUpdate(string, string) error {
	return fmt.Errorf("the automatic updater currently supports Linux and macOS only")
}

func StartUninstall(string) error {
	return fmt.Errorf("agent removal currently supports Linux, macOS and Windows only")
}
func Uninstall(context.Context, string) error {
	return fmt.Errorf("agent removal currently supports Linux, macOS and Windows only")
}

func CleanupRunners(context.Context, config.Config) error {
	return fmt.Errorf("runner service cleanup currently supports Linux and macOS only")
}

func RegisterOwnRunner(context.Context, string, string) error {
	return fmt.Errorf("runner task registration applies to Windows only")
}
