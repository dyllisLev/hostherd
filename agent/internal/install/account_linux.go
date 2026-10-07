//go:build linux

package install

import "os/user"

func lookupSystemAccount(name string) (systemAccount, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return systemAccount{}, err
	}
	group, err := user.LookupGroupId(u.Gid)
	if err != nil {
		return systemAccount{}, err
	}
	return systemAccount{Username: u.Username, Uid: u.Uid, Gid: u.Gid, GroupName: group.Name, HomeDir: u.HomeDir}, nil
}
