package metrics

// Parsers for macOS tool output. Kept platform-neutral so tests run on Linux.

import (
	"regexp"
	"strings"
)

// parseDarwinLoad reads `sysctl -n vm.loadavg`: "{ 1.86 2.03 2.11 }".
func parseDarwinLoad(text string) (load [3]float64, ok bool) {
	f := fields(strings.Trim(strings.TrimSpace(text), "{}"))
	if len(f) < 3 {
		return load, false
	}
	for i := 0; i < 3; i++ {
		if load[i], ok = parseFloat(f[i]); !ok {
			return load, false
		}
	}
	return load, true
}

var pageSize = regexp.MustCompile(`page size of (\d+) bytes`)

// parseVMStat returns used memory as Activity Monitor counts it: app (active),
// wired and compressed pages.
func parseVMStat(text string) (uint64, bool) {
	match := pageSize.FindStringSubmatch(text)
	if match == nil {
		return 0, false
	}
	size, _ := parseUint(match[1])
	pages := map[string]uint64{}
	for _, line := range lines(text) {
		colon := strings.LastIndexByte(line, ':')
		if colon < 0 {
			continue
		}
		if n, ok := parseUint(strings.TrimSuffix(strings.TrimSpace(line[colon+1:]), ".")); ok {
			pages[strings.Trim(line[:colon], `"`)] = n
		}
	}
	active, okActive := pages["Pages active"]
	wired, okWired := pages["Pages wired down"]
	if !okActive || !okWired {
		return 0, false
	}
	return (active + wired + pages["Pages occupied by compressor"]) * size, true
}

var swapField = regexp.MustCompile(`(total|used) = ([\d.]+)([KMG])`)

// parseSwapUsage reads `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1035.25M  free = ...".
func parseSwapUsage(text string) (total, used uint64, ok bool) {
	units := map[string]float64{"K": 1 << 10, "M": 1 << 20, "G": 1 << 30}
	found := 0
	for _, match := range swapField.FindAllStringSubmatch(text, -1) {
		value, valid := parseFloat(match[2])
		if !valid {
			continue
		}
		bytes := uint64(value * units[match[3]])
		if match[1] == "total" {
			total = bytes
		} else {
			used = bytes
		}
		found++
	}
	return total, used, found == 2
}

var bootSeconds = regexp.MustCompile(`sec = (\d+)`)

// parseBootTime reads `sysctl -n kern.boottime`: "{ sec = 1727000000, usec = 0 } ...".
func parseBootTime(text string) (int64, bool) {
	match := bootSeconds.FindStringSubmatch(text)
	if match == nil {
		return 0, false
	}
	n, ok := parseUint(match[1])
	return int64(n), ok
}

// parsePSCPU sums per-process CPU (100 per core) into a whole-machine percentage.
func parsePSCPU(text string, cpus int) (float64, int, bool) {
	if cpus < 1 {
		return 0, 0, false
	}
	total, procs := 0.0, 0
	for _, line := range lines(text) {
		if value, ok := parseFloat(strings.TrimSpace(line)); ok {
			total += value
			procs++
		}
	}
	if procs == 0 {
		return 0, 0, false
	}
	return clamp(total/float64(cpus), 0, 100), procs, true
}

// parseNetstat sums link-level byte counters of Ethernet/Wi-Fi interfaces (en*)
// from `netstat -ib`. Address can be blank, so counters are read from the end.
func parseNetstat(text string) (rx, tx uint64, ok bool) {
	rows := lines(text)
	if len(rows) < 2 {
		return 0, 0, false
	}
	for _, line := range rows[1:] {
		f := fields(line)
		if len(f) < 8 || !strings.HasPrefix(f[0], "en") || !strings.HasPrefix(f[2], "<Link#") {
			continue
		}
		// ... Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
		in, okIn := parseUint(f[len(f)-5])
		out, okOut := parseUint(f[len(f)-2])
		if okIn && okOut {
			rx, tx, ok = rx+in, tx+out, true
		}
	}
	return rx, tx, ok
}

// skipDarwinMount keeps writable local volumes. Read-only volumes are the sealed
// system snapshot ("/"), mounted images and toolchain/simulator assets, which
// always look full; user data lives on /System/Volumes/Data. Other system
// volumes share the Data volume's container.
func skipDarwinMount(fs, path string, flags uint32) bool {
	const readOnly = 0x1 // MNT_RDONLY
	if fs != "apfs" && fs != "hfs" && fs != "exfat" && fs != "msdos" {
		return true
	}
	if flags&readOnly != 0 {
		return true
	}
	return strings.HasPrefix(path, "/System/Volumes/") && path != "/System/Volumes/Data"
}
