//go:build darwin

package install

import "testing"

func TestParseDirectoryAccount(t *testing.T) {
	got, err := parseDirectoryAccount("name: Mac.User-1\nuid: 501\ngid: 20\ndir: /Users/Mac.User-1\nshell: /bin/zsh\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.Username != "Mac.User-1" || got.Uid != "501" || got.Gid != "20" || got.HomeDir != "/Users/Mac.User-1" {
		t.Fatalf("parsed account = %+v", got)
	}
	for _, record := range []string{"", "name: alice\nuid: bad\ngid: 20\ndir: /Users/alice\n", "name: alice\nuid: 501\ngid: 20\ndir: relative\n"} {
		if _, err := parseDirectoryAccount(record); err == nil {
			t.Fatalf("accepted invalid record %q", record)
		}
	}
}
