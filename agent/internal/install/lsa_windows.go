//go:build windows

package install

import (
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	advapi32                = windows.NewLazySystemDLL("advapi32.dll")
	procLsaOpenPolicy       = advapi32.NewProc("LsaOpenPolicy")
	procLsaAddAccountRights = advapi32.NewProc("LsaAddAccountRights")
	procLsaClose            = advapi32.NewProc("LsaClose")
	procLsaNtStatusToWin    = advapi32.NewProc("LsaNtStatusToWinError")

	netapi32                  = windows.NewLazySystemDLL("netapi32.dll")
	procNetUserGetLocalGroups = netapi32.NewProc("NetUserGetLocalGroups")
)

func lsaError(status uintptr) error {
	code, _, _ := procLsaNtStatusToWin.Call(status)
	return windows.Errno(code)
}

// grantBatchLogon lets the account run S4U scheduled tasks ("Log on as a batch
// job"), which standard users lack by default. Granting an existing right is a no-op.
func grantBatchLogon(sid string) error {
	account, err := windows.StringToSid(sid)
	if err != nil {
		return err
	}
	const policyCreateAccount, policyLookupNames = 0x10, 0x800
	attributes := windows.OBJECT_ATTRIBUTES{Length: uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{}))}
	var policy windows.Handle
	if status, _, _ := procLsaOpenPolicy.Call(0, uintptr(unsafe.Pointer(&attributes)), policyCreateAccount|policyLookupNames, uintptr(unsafe.Pointer(&policy))); status != 0 {
		return fmt.Errorf("open local security policy: %w", lsaError(status))
	}
	defer procLsaClose.Call(uintptr(policy))
	right, err := windows.NewNTUnicodeString("SeBatchLogonRight")
	if err != nil {
		return err
	}
	if status, _, _ := procLsaAddAccountRights.Call(uintptr(policy), uintptr(unsafe.Pointer(account)), uintptr(unsafe.Pointer(right)), 1); status != 0 {
		return fmt.Errorf("grant batch logon right: %w", lsaError(status))
	}
	return nil
}

// administratorsMember reports whether the account (DOMAIN\name) belongs to the
// local Administrators group, directly or through nested groups. It checks the
// account itself, not the elevated installer token.
func administratorsMember(account string) (bool, error) {
	admins, err := windows.StringToSid(adminsSID)
	if err != nil {
		return false, err
	}
	// Group names are localized ("Administratoren"); compare against the SID's name.
	adminsName, _, _, err := admins.LookupAccount("")
	if err != nil {
		return false, err
	}
	name, err := windows.UTF16PtrFromString(account)
	if err != nil {
		return false, err
	}
	const lgIncludeIndirect, maxPreferredLength = 1, 0xFFFFFFFF
	var buf *byte
	var read, total uint32
	if status, _, _ := procNetUserGetLocalGroups.Call(0, uintptr(unsafe.Pointer(name)), 0, lgIncludeIndirect, uintptr(unsafe.Pointer(&buf)), maxPreferredLength, uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total))); status != 0 {
		return false, windows.Errno(status)
	}
	defer windows.NetApiBufferFree(buf)
	// LOCALGROUP_USERS_INFO_0 holds only the group name pointer.
	for _, group := range unsafe.Slice((**uint16)(unsafe.Pointer(buf)), read) {
		if strings.EqualFold(windows.UTF16PtrToString(group), adminsName) {
			return true, nil
		}
	}
	return false, nil
}
