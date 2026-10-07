package metrics

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// macOS exposes these counters without cgo only through system tools.
func run(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func readRaw() raw {
	var r raw
	sysctl := lines(run("/usr/sbin/sysctl", "-n", "vm.loadavg", "hw.memsize", "vm.swapusage", "kern.boottime"))
	if len(sysctl) >= 4 {
		if load, ok := parseDarwinLoad(sysctl[0]); ok {
			r.load = &load
		}
		if total, ok := parseUint(strings.TrimSpace(sysctl[1])); ok {
			r.memTotal = &total
			if used, ok := parseVMStat(run("/usr/bin/vm_stat")); ok && used <= total {
				r.memUsed = &used
			}
		}
		if swapTotal, swapUsed, ok := parseSwapUsage(sysctl[2]); ok {
			r.swapTotal, r.swapUsed = &swapTotal, &swapUsed
		}
		if boot, ok := parseBootTime(sysctl[3]); ok {
			uptime := float64(time.Now().Unix() - boot)
			r.uptime = &uptime
		}
	}
	if cpu, procs, ok := parsePSCPU(run("/bin/ps", "-A", "-o", "%cpu="), runtime.NumCPU()); ok {
		r.cpuPercent, r.procs = &cpu, &procs
	}
	r.netRx, r.netTx, r.hasNet = parseNetstat(run("/usr/sbin/netstat", "-ib"))
	r.disks = darwinDisks()
	return r
}

func darwinDisks() []Disk {
	count, err := syscall.Getfsstat(nil, 2 /* MNT_NOWAIT */)
	if err != nil || count <= 0 {
		return nil
	}
	buf := make([]syscall.Statfs_t, count)
	if count, err = syscall.Getfsstat(buf, 2); err != nil {
		return nil
	}
	var disks []Disk
	for _, st := range buf[:count] {
		fs, path := cString(st.Fstypename[:]), cString(st.Mntonname[:])
		if skipDarwinMount(fs, path, st.Flags) || st.Blocks == 0 {
			continue
		}
		size := uint64(st.Bsize)
		disks = append(disks, Disk{Mount: path, FS: fs, Total: st.Blocks * size, Used: (st.Blocks - st.Bfree) * size, Avail: st.Bavail * size})
	}
	return largestDisks(disks, 16)
}

func cString(value []int8) string {
	b := make([]byte, 0, len(value))
	for _, c := range value {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}
