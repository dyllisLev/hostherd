package metrics

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func readFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func readRaw() raw {
	var r raw
	r.cpuTotal, r.cpuIdle, r.hasCPUTimes = parseProcStat(readFile("/proc/stat"))
	if load, _, ok := parseLoadavg(readFile("/proc/loadavg")); ok {
		r.load = &load
	}
	// /proc/loadavg counts threads; numeric /proc entries are processes.
	if entries, err := os.ReadDir("/proc"); err == nil {
		procs := 0
		for _, entry := range entries {
			if name := entry.Name(); name[0] >= '1' && name[0] <= '9' {
				if _, ok := parseUint(name); ok {
					procs++
				}
			}
		}
		r.procs = &procs
	}
	if memTotal, memUsed, swapTotal, swapUsed, ok := parseMeminfo(readFile("/proc/meminfo")); ok {
		r.memTotal, r.memUsed, r.swapTotal, r.swapUsed = &memTotal, &memUsed, &swapTotal, &swapUsed
	}
	if f := fields(readFile("/proc/uptime")); len(f) > 0 {
		if uptime, ok := parseFloat(f[0]); ok {
			r.uptime = &uptime
		}
	}
	r.netRx, r.netTx, r.hasNet = parseNetDev(readFile("/proc/net/dev"), physicalInterfaces())
	var pools map[string]Disk
	for _, m := range parseMounts(readFile("/proc/self/mounts")) {
		var st syscall.Statfs_t
		if syscall.Statfs(m.path, &st) != nil || st.Blocks == 0 {
			continue
		}
		size := uint64(st.Bsize)
		disk := Disk{Mount: m.path, FS: m.fs, Total: st.Blocks * size, Used: (st.Blocks - st.Bfree) * size, Avail: st.Bavail * size}
		// A pool's root dataset excludes its children and volumes; use the pool totals.
		if m.fs == "zfs" && !strings.Contains(m.device, "/") {
			if pools == nil {
				pools = parseZpoolList(zpoolList())
			}
			if pool, ok := pools[m.device]; ok {
				disk.Total, disk.Used, disk.Avail = pool.Total, pool.Used, pool.Avail
			}
		}
		r.disks = append(r.disks, disk)
	}
	r.disks = largestDisks(r.disks, 16)
	return r
}

// physicalInterfaces counts NICs backed by a device, so bridges, veth pairs and
// tunnels do not count the same traffic twice. Without any, all but loopback count.
func physicalInterfaces() func(string) bool {
	entries, _ := os.ReadDir("/sys/class/net")
	physical := map[string]bool{}
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join("/sys/class/net", entry.Name(), "device")); err == nil {
			physical[entry.Name()] = true
		}
	}
	return func(name string) bool {
		if len(physical) == 0 {
			return name != "lo" && !strings.HasPrefix(name, "veth")
		}
		return physical[name]
	}
}

func zpoolList() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "zpool", "list", "-Hp", "-o", "name,size,alloc,free").Output()
	if err != nil {
		return ""
	}
	return string(out)
}
