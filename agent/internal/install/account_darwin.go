//go:build darwin

package install

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func lookupSystemAccount(name string) (systemAccount, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, "/usr/bin/dscacheutil", "-q", "user", "-a", "name", name).Output()
	if err != nil {
		return systemAccount{}, err
	}
	account, err := parseDirectoryAccount(string(data))
	if err != nil {
		return systemAccount{}, err
	}
	group, err := exec.CommandContext(ctx, "/usr/bin/id", "-gn", account.Username).Output()
	if err != nil {
		return systemAccount{}, err
	}
	account.GroupName = strings.TrimSpace(string(group))
	if account.GroupName == "" || strings.ContainsAny(account.GroupName, "\x00\r\n") {
		return systemAccount{}, fmt.Errorf("directory service returned an invalid group")
	}
	return account, nil
}

func parseDirectoryAccount(record string) (systemAccount, error) {
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(record), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	account := systemAccount{Username: fields["name"], Uid: fields["uid"], Gid: fields["gid"], HomeDir: fields["dir"]}
	uid, uidErr := strconv.ParseUint(account.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(account.Gid, 10, 32)
	if account.Username == "" || strings.ContainsAny(account.Username, "\x00\r\n") || uidErr != nil || gidErr != nil || uid > 1<<32-1 || gid > 1<<32-1 || !filepath.IsAbs(account.HomeDir) || strings.ContainsAny(account.HomeDir, "\x00\r\n") {
		return systemAccount{}, fmt.Errorf("directory service returned an invalid user record")
	}
	return account, nil
}
