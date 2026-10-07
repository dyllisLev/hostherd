// Package metrics samples host resource usage for the central dashboard.
package metrics

import (
	"bufio"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Disk is one mounted filesystem. Percent use is Used/(Used+Avail), as df reports.
type Disk struct {
	Mount string `json:"mount"`
	FS    string `json:"fs"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Avail uint64 `json:"avail"`
}

// Sample is one report. Values a platform cannot read are omitted.
type Sample struct {
	CPU       *float64 `json:"cpu,omitempty"`
	CPUs      int      `json:"cpus"`
	Load1     *float64 `json:"load1,omitempty"`
	Load5     *float64 `json:"load5,omitempty"`
	Load15    *float64 `json:"load15,omitempty"`
	MemTotal  *uint64  `json:"memTotal,omitempty"`
	MemUsed   *uint64  `json:"memUsed,omitempty"`
	SwapTotal *uint64  `json:"swapTotal,omitempty"`
	SwapUsed  *uint64  `json:"swapUsed,omitempty"`
	NetRx     *float64 `json:"netRx,omitempty"`
	NetTx     *float64 `json:"netTx,omitempty"`
	Uptime    *float64 `json:"uptime,omitempty"`
	Procs     *int     `json:"procs,omitempty"`
	Disks     []Disk   `json:"disks"`
}

// raw holds cumulative counters and instantaneous values read from the OS.
type raw struct {
	cpuTotal, cpuIdle   uint64
	hasCPUTimes         bool
	cpuPercent          *float64 // platforms without cumulative CPU times
	load                *[3]float64
	memTotal, memUsed   *uint64
	swapTotal, swapUsed *uint64
	netRx, netTx        uint64
	hasNet              bool
	uptime              *float64
	procs               *int
	disks               []Disk
}

// Collector turns successive counter readings into rates.
type Collector struct {
	read     func() raw
	previous *raw
	at       time.Time
}

func New() *Collector { return &Collector{read: readRaw} }

// Collect reads the host. Rates need a previous reading, so the first call
// omits CPU (on counter platforms) and network throughput.
func (c *Collector) Collect(now time.Time) Sample {
	current := c.read()
	s := Sample{CPUs: runtime.NumCPU(), CPU: current.cpuPercent, Uptime: current.uptime, Procs: current.procs, Disks: current.disks,
		MemTotal: current.memTotal, MemUsed: current.memUsed, SwapTotal: current.swapTotal, SwapUsed: current.swapUsed}
	if s.Disks == nil {
		s.Disks = []Disk{}
	}
	if current.load != nil {
		s.Load1, s.Load5, s.Load15 = &current.load[0], &current.load[1], &current.load[2]
	}
	if p := c.previous; p != nil {
		if current.hasCPUTimes && p.hasCPUTimes && current.cpuTotal > p.cpuTotal {
			total, idle := float64(current.cpuTotal-p.cpuTotal), float64(current.cpuIdle-p.cpuIdle)
			value := clamp(100*(1-idle/total), 0, 100)
			s.CPU = &value
		}
		if seconds := now.Sub(c.at).Seconds(); current.hasNet && p.hasNet && seconds > 0 && current.netRx >= p.netRx && current.netTx >= p.netTx {
			rx, tx := float64(current.netRx-p.netRx)/seconds, float64(current.netTx-p.netTx)/seconds
			s.NetRx, s.NetTx = &rx, &tx
		}
	}
	c.previous, c.at = &current, now
	return s
}

func clamp(v, low, high float64) float64 {
	if v < low {
		return low
	}
	if v > high {
		return high
	}
	return v
}

func fields(line string) []string { return strings.Fields(line) }

func lines(text string) []string {
	var out []string
	scanner := bufio.NewScanner(strings.NewReader(text))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		out = append(out, scanner.Text())
	}
	return out
}

func parseUint(value string) (uint64, bool) {
	n, err := strconv.ParseUint(value, 10, 64)
	return n, err == nil
}

func parseFloat(value string) (float64, bool) {
	n, err := strconv.ParseFloat(value, 64)
	return n, err == nil
}

// parseProcStat returns total and idle (idle+iowait) jiffies from /proc/stat.
func parseProcStat(text string) (total, idle uint64, ok bool) {
	for _, line := range lines(text) {
		f := fields(line)
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		// user nice system idle iowait irq softirq steal; guest time is already in user.
		for i, value := range f[1:] {
			if i >= 8 {
				break
			}
			n, valid := parseUint(value)
			if !valid {
				return 0, 0, false
			}
			total += n
			if i == 3 || i == 4 {
				idle += n
			}
		}
		return total, idle, true
	}
	return 0, 0, false
}

// parseLoadavg reads /proc/loadavg: three averages and running/total tasks.
func parseLoadavg(text string) (load [3]float64, procs int, ok bool) {
	f := fields(text)
	if len(f) < 4 {
		return load, 0, false
	}
	for i := 0; i < 3; i++ {
		if load[i], ok = parseFloat(f[i]); !ok {
			return load, 0, false
		}
	}
	if slash := strings.IndexByte(f[3], '/'); slash >= 0 {
		procs, _ = strconv.Atoi(f[3][slash+1:])
	}
	return load, procs, true
}

// parseMeminfo returns bytes; used memory excludes reclaimable cache (MemAvailable).
func parseMeminfo(text string) (memTotal, memUsed, swapTotal, swapUsed uint64, ok bool) {
	values := map[string]uint64{}
	for _, line := range lines(text) {
		f := fields(line)
		if len(f) >= 2 {
			if n, valid := parseUint(f[1]); valid {
				values[strings.TrimSuffix(f[0], ":")] = n * 1024
			}
		}
	}
	total, hasTotal := values["MemTotal"]
	available, hasAvailable := values["MemAvailable"]
	if !hasTotal || !hasAvailable || available > total {
		return 0, 0, 0, 0, false
	}
	swapTotal = values["SwapTotal"]
	if free := values["SwapFree"]; free <= swapTotal {
		swapUsed = swapTotal - free
	}
	return total, total - available, swapTotal, swapUsed, true
}

// parseNetDev sums receive and transmit bytes of the given interfaces from /proc/net/dev.
func parseNetDev(text string, include func(name string) bool) (rx, tx uint64, ok bool) {
	for _, line := range lines(text) {
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		name := strings.TrimSpace(line[:colon])
		f := fields(line[colon+1:])
		if len(f) < 9 || !include(name) {
			continue
		}
		r, okR := parseUint(f[0])
		t, okT := parseUint(f[8])
		if okR && okT {
			rx, tx, ok = rx+r, tx+t, true
		}
	}
	return rx, tx, ok
}

type mount struct{ device, path, fs string }

var localFilesystems = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "f2fs": true, "vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "jfs": true, "reiserfs": true, "bcachefs": true}

// parseMounts lists local filesystems once per device. Network filesystems are
// skipped so a stalled server cannot block sampling. A ZFS dataset mounted below
// another dataset of the same pool (a hypervisor's guest volumes) shares that
// pool's space and is skipped; a container whose root is such a dataset keeps it.
func parseMounts(text string) []mount {
	byDevice := map[string]mount{}
	for _, line := range lines(text) {
		f := fields(line)
		if len(f) < 3 || !localFilesystems[f[2]] {
			continue
		}
		m := mount{device: f[0], path: unescapeMount(f[1]), fs: f[2]}
		if old, seen := byDevice[m.device]; !seen || len(m.path) < len(old.path) {
			byDevice[m.device] = m
		}
	}
	pool := func(device string) string { return strings.SplitN(device, "/", 2)[0] }
	nested := func(m mount) bool {
		for _, other := range byDevice {
			if other.fs == "zfs" && other.device != m.device && pool(other.device) == pool(m.device) &&
				(other.path == "/" || strings.HasPrefix(m.path, other.path+"/")) {
				return true
			}
		}
		return false
	}
	out := make([]mount, 0, len(byDevice))
	for _, m := range byDevice {
		if m.fs != "zfs" || !nested(m) {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out
}

// unescapeMount decodes the octal escapes (\040 for space) used in /proc mount tables.
func unescapeMount(value string) string {
	if !strings.Contains(value, `\`) {
		return value
	}
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) {
			if n, err := strconv.ParseUint(value[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(value[i])
	}
	return b.String()
}

// largestDisks keeps the biggest filesystems so a host with many volumes stays readable.
func largestDisks(disks []Disk, limit int) []Disk {
	sort.SliceStable(disks, func(i, j int) bool { return disks[i].Total > disks[j].Total })
	if len(disks) > limit {
		disks = disks[:limit]
	}
	sort.Slice(disks, func(i, j int) bool { return disks[i].Mount < disks[j].Mount })
	return disks
}

// parseZpoolList reads `zpool list -Hp -o name,size,alloc,free`.
func parseZpoolList(text string) map[string]Disk {
	pools := map[string]Disk{}
	for _, line := range lines(text) {
		f := strings.Split(line, "\t")
		if len(f) != 4 {
			continue
		}
		size, okSize := parseUint(f[1])
		alloc, okAlloc := parseUint(f[2])
		free, okFree := parseUint(f[3])
		if okSize && okAlloc && okFree {
			pools[f[0]] = Disk{Total: size, Used: alloc, Avail: free}
		}
	}
	return pools
}
