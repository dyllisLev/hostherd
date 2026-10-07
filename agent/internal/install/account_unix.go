//go:build linux || darwin

package install

import (
	"fmt"
	"os"
	"strings"
)

type systemAccount struct {
	Username  string
	Uid       string
	Gid       string
	GroupName string
	HomeDir   string
}

func detectedExecutionAccount() (systemAccount, error) {
	// The bootstrap is run with sudo. SUDO_USER preserves the login account
	// that requested installation; a direct root invocation intentionally uses root.
	name := os.Getenv("SUDO_USER")
	if name == "" {
		name = "root"
	}
	if strings.ContainsAny(name, "\x00\r\n") {
		return systemAccount{}, fmt.Errorf("invalid detected execution user")
	}
	account, err := lookupSystemAccount(name)
	if err != nil {
		return systemAccount{}, fmt.Errorf("detected execution user %q: %w", name, err)
	}
	return account, nil
}
