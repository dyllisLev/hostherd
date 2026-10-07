package metrics

import (
	"testing"
	"time"
)

func TestLinuxParsers(t *testing.T) {
	total, idle, ok := parseProcStat("cpu  100 0 50 800 50 0 0 0 10 0\ncpu0 1 2 3 4 5\n")
	if !ok || total != 1000 || idle != 850 {
		t.Fatalf("proc stat: %d %d %v", total, idle, ok)
	}
	load, procs, ok := parseLoadavg("0.52 0.58 0.59 2/1234 98765\n")
	if !ok || load != [3]float64{0.52, 0.58, 0.59} || procs != 1234 {
		t.Fatalf("loadavg: %v %d %v", load, procs, ok)
	}
	memTotal, memUsed, swapTotal, swapUsed, ok := parseMeminfo("MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n")
	if !ok || memTotal != 1000*1024 || memUsed != 600*1024 || swapTotal != 200*1024 || swapUsed != 150*1024 {
		t.Fatalf("meminfo: %d %d %d %d %v", memTotal, memUsed, swapTotal, swapUsed, ok)
	}
	dev := "Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 6 0 0 0 0 0 0\nvmbr0: 1000 5 0 0 0 0 0 0 2000 6 0 0 0 0 0 0\n"
	rx, tx, ok := parseNetDev(dev, func(name string) bool { return name == "eth0" })
	if !ok || rx != 1000 || tx != 2000 {
		t.Fatalf("net dev: %d %d %v", rx, tx, ok)
	}
}

func TestContainerRootOnZFSDatasetIsKept(t *testing.T) {
	mounts := parseMounts("ssd2t/subvol-102-disk-0 / zfs rw 0 0\nrpool/ROOT/pve-1 / zfs rw 0 0\n")
	if len(mounts) != 2 {
		t.Fatalf("container roots: %+v", mounts)
	}
	host := parseMounts("rpool/ROOT/pve-1 / zfs rw 0 0\nrpool/data/subvol-101-disk-0 /rpool/data/subvol-101-disk-0 zfs rw 0 0\nrpool/var-lib-vz /var/lib/vz zfs rw 0 0\ntank /tank zfs rw 0 0\n")
	if len(host) != 2 || host[0].path != "/" || host[1].path != "/tank" {
		t.Fatalf("ZFS-root host: %+v", host)
	}
}

func TestMountsSkipDuplicatesNetworkAndGuestDatasets(t *testing.T) {
	mounts := parseMounts(`/dev/sda1 / ext4 rw 0 0
/dev/sda1 /var/lib/docker/overlay ext4 rw 0 0
proc /proc proc rw 0 0
tmpfs /run tmpfs rw 0 0
server:/share /mnt/nfs nfs4 rw 0 0
ssd2t /ssd2t zfs rw 0 0
ssd2t/subvol-113-disk-0 /ssd2t/subvol-113-disk-0 zfs rw 0 0
rpool/ROOT/pve-1 /boot/efi\040data vfat rw 0 0
`)
	want := []mount{{"rpool/ROOT/pve-1", "/boot/efi data", "vfat"}, {"/dev/sda1", "/", "ext4"}, {"ssd2t", "/ssd2t", "zfs"}}
	got := map[string]mount{}
	for _, m := range mounts {
		got[m.path] = m
	}
	if len(mounts) != len(want) {
		t.Fatalf("mounts: %+v", mounts)
	}
	for _, m := range want {
		if got[m.path] != m {
			t.Fatalf("missing %+v in %+v", m, mounts)
		}
	}
}

func TestZpoolList(t *testing.T) {
	pools := parseZpoolList("ssd2t\t1992864825344\t285032992768\t1707831832576\nbad line\n")
	if pool := pools["ssd2t"]; len(pools) != 1 || pool.Used != 285032992768 || pool.Avail != 1707831832576 || pool.Total != 1992864825344 {
		t.Fatalf("zpool: %+v", pools)
	}
}

func TestMacParsers(t *testing.T) {
	if load, ok := parseDarwinLoad("{ 1.86 2.03 2.11 }\n"); !ok || load[2] != 2.11 {
		t.Fatalf("load: %v %v", load, ok)
	}
	vm := "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10.\nPages active:                            100.\nPages inactive:                           50.\nPages wired down:                         20.\nPages occupied by compressor:              5.\n\"Translation faults\":                  12345.\n"
	if used, ok := parseVMStat(vm); !ok || used != 125*16384 {
		t.Fatalf("vm_stat: %d %v", used, ok)
	}
	if total, used, ok := parseSwapUsage("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)"); !ok || total != 2048<<20 || used != uint64(1024.5*(1<<20)) {
		t.Fatalf("swap: %d %d %v", total, used, ok)
	}
	if boot, ok := parseBootTime("{ sec = 1727000000, usec = 12 } Sun Sep 22"); !ok || boot != 1727000000 {
		t.Fatalf("boot: %d %v", boot, ok)
	}
	if cpu, procs, ok := parsePSCPU(" 50.0\n 30.0\n  0.0\n", 4); !ok || cpu != 20 || procs != 3 {
		t.Fatalf("ps: %v %d %v", cpu, procs, ok)
	}
	netstat := `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                          100     0       5000      100     0       5000     0
en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff     200     0      70000      150     0      30000     0
en0        1500  192.168.1     192.168.1.10        200     -      70000      150     -      30000     -
en5        1500  <Link#20>                          10     0       1000       10     0        500     0
utun0      1380  <Link#21>                          10     0       9999       10     0       9999     0
`
	if rx, tx, ok := parseNetstat(netstat); !ok || rx != 71000 || tx != 30500 {
		t.Fatalf("netstat: %d %d %v", rx, tx, ok)
	}
}

func TestMacVolumesKeepWritableData(t *testing.T) {
	for _, tc := range []struct {
		fs, path string
		flags    uint32
		skip     bool
	}{
		{"apfs", "/", 0x1, true},
		{"apfs", "/System/Volumes/Data", 0, false},
		{"apfs", "/System/Volumes/VM", 0, true},
		{"apfs", "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain", 0x1, true},
		{"apfs", "/Volumes/Backup", 0, false},
		{"hfs", "/Volumes/Installer", 0x1, true},
		{"devfs", "/dev", 0, true},
	} {
		if got := skipDarwinMount(tc.fs, tc.path, tc.flags); got != tc.skip {
			t.Errorf("%s %s: skip=%v", tc.fs, tc.path, got)
		}
	}
}

func TestCollectorComputesRatesFromSuccessiveReadings(t *testing.T) {
	readings := []raw{
		{cpuTotal: 1000, cpuIdle: 900, hasCPUTimes: true, netRx: 1000, netTx: 500, hasNet: true},
		{cpuTotal: 2000, cpuIdle: 1650, hasCPUTimes: true, netRx: 31000, netTx: 3500, hasNet: true},
	}
	c := &Collector{read: func() raw { r := readings[0]; readings = readings[1:]; return r }}
	start := time.Unix(1000, 0)
	first := c.Collect(start)
	if first.CPU != nil || first.NetRx != nil || first.Disks == nil {
		t.Fatalf("first sample must omit rates: %+v", first)
	}
	second := c.Collect(start.Add(30 * time.Second))
	if second.CPU == nil || *second.CPU != 25 || *second.NetRx != 1000 || *second.NetTx != 100 {
		t.Fatalf("rates: cpu=%v rx=%v tx=%v", second.CPU, second.NetRx, second.NetTx)
	}
}

func TestCollectReadsThisHost(t *testing.T) {
	c := New()
	c.Collect(time.Now())
	time.Sleep(200 * time.Millisecond)
	s := c.Collect(time.Now())
	if s.CPUs < 1 || s.MemTotal == nil || *s.MemTotal == 0 || s.Load1 == nil {
		t.Fatalf("host sample incomplete: %+v", s)
	}
}
