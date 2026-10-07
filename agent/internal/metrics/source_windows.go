//go:build windows

package metrics

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
)

type memoryStatusEx struct {
	length, memoryLoad                   uint32
	totalPhys, availPhys                 uint64
	totalPageFile, availPageFile         uint64
	totalVirtual, availVirtual, extended uint64
}

func fileTime(t windows.Filetime) uint64 { return uint64(t.HighDateTime)<<32 | uint64(t.LowDateTime) }

// readRaw uses Win32 counters. Windows has no load average, so load is omitted.
func readRaw() raw {
	var r raw
	var idle, kernel, user windows.Filetime
	if ok, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user))); ok != 0 {
		// Kernel time includes idle time.
		r.cpuTotal, r.cpuIdle, r.hasCPUTimes = fileTime(kernel)+fileTime(user), fileTime(idle), true
	}
	status := memoryStatusEx{length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if ok, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status))); ok != 0 && status.availPhys <= status.totalPhys {
		total, used := status.totalPhys, status.totalPhys-status.availPhys
		r.memTotal, r.memUsed = &total, &used
	}
	if ticks, _, _ := procGetTickCount64.Call(); ticks != 0 {
		uptime := float64(ticks) / 1000
		r.uptime = &uptime
	}
	if procs, ok := countProcesses(); ok {
		r.procs = &procs
	}
	r.netRx, r.netTx, r.hasNet = hardwareInterfaceOctets()
	r.disks = largestDisks(fixedDrives(), 16)
	return r
}

func countProcesses() (int, bool) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	count := 0
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		count++
	}
	return count, count > 0
}

// hardwareInterfaceOctets sums physical NICs only, so virtual switches and
// VPN adapters do not count the same traffic twice.
func hardwareInterfaceOctets() (rx, tx uint64, ok bool) {
	var table *windows.MibIfTable2
	if windows.GetIfTable2Ex(windows.MibIfEntryNormal, &table) != nil {
		return 0, 0, false
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))
	const hardwareInterface = 0x1
	for _, row := range unsafe.Slice(&table.Table[0], table.NumEntries) {
		if row.InterfaceAndOperStatusFlags&hardwareInterface == 0 {
			continue
		}
		rx, tx, ok = rx+row.InOctets, tx+row.OutOctets, true
	}
	return rx, tx, ok
}

// fixedDrives reports local fixed volumes by drive letter.
func fixedDrives() []Disk {
	buffer := make([]uint16, 512)
	n, err := windows.GetLogicalDriveStrings(uint32(len(buffer)), &buffer[0])
	if err != nil || int(n) > len(buffer) {
		return nil
	}
	var disks []Disk
	for start := 0; start < int(n); {
		end := start
		for end < int(n) && buffer[end] != 0 {
			end++
		}
		if end == start {
			break
		}
		root := &buffer[start]
		if windows.GetDriveType(root) == windows.DRIVE_FIXED {
			var available, total, free uint64
			if windows.GetDiskFreeSpaceEx(root, &available, &total, &free) == nil && total > 0 {
				var fs [windows.MAX_PATH + 1]uint16
				windows.GetVolumeInformation(root, nil, 0, nil, nil, nil, &fs[0], uint32(len(fs)))
				disks = append(disks, Disk{Mount: windows.UTF16ToString(buffer[start:end]), FS: windows.UTF16ToString(fs[:]), Total: total, Used: total - free, Avail: available})
			}
		}
		start = end + 1
	}
	return disks
}
