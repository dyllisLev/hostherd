//go:build linux || darwin

package install

import "testing"

func TestDetectedExecutionAccountUsesSudoUser(t *testing.T) {
	root, err := lookupSystemAccount("root")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SUDO_USER", root.Username)
	got, err := detectedExecutionAccount()
	if err != nil {
		t.Fatal(err)
	}
	if got.Username != root.Username || got.Uid != root.Uid || got.Gid != root.Gid || got.HomeDir != root.HomeDir {
		t.Fatalf("detected account = %+v, want %+v", got, root)
	}
	t.Setenv("SUDO_USER", "hostherd-account-that-does-not-exist")
	if _, err := detectedExecutionAccount(); err == nil {
		t.Fatal("accepted an unknown sudo user")
	}
}

func TestDetectedExecutionAccountDefaultsToRoot(t *testing.T) {
	t.Setenv("SUDO_USER", "")
	got, err := detectedExecutionAccount()
	if err != nil {
		t.Fatal(err)
	}
	if got.Username != "root" {
		t.Fatalf("execution user = %q, want root", got.Username)
	}
}
