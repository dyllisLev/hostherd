//go:build darwin

package platform

import "testing"

func TestDirectoryShell(t *testing.T) {
	for _, tc := range []struct{ name, record, want string }{
		{"zsh account", "name: alice\nuid: 501\ngid: 20\ndir: /Users/alice\nshell: /bin/zsh\n", "/bin/zsh"},
		{"custom shell", "uid: 501\nshell: /opt/homebrew/bin/fish\n", "/opt/homebrew/bin/fish"},
		{"shell path spaces", "uid: 501\nshell: /Applications/My Shell/bin/sh\n", "/Applications/My Shell/bin/sh"},
		{"wrong account", "uid: 502\nshell: /bin/zsh\n", ""},
		{"missing account", "", ""},
		{"missing shell", "uid: 501\n", ""},
		{"relative shell", "uid: 501\nshell: zsh\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := directoryShell(tc.record, "501"); got != tc.want {
				t.Fatalf("shell = %q, want %q", got, tc.want)
			}
		})
	}
}
