//go:build linux || darwin

package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"hostherd/agent/internal/model"
)

func TestBackgroundChildDoesNotHoldJobOpen(t *testing.T) {
	root := shortRoot(t)
	r := newTestRunner(t, root, "1.0.0")
	start := time.Now()
	job, err := r.Start(model.StartParams{ID: testID(80), Path: root, Cmd: "printf before; sleep 30 & printf after"}, "job")
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Kill(-job.PID, syscall.SIGKILL)
	if job = waitCompleted(t, root, testID(80)); job.Status != "completed" || time.Since(start) > 6*time.Second {
		t.Fatalf("%+v after %v", job, time.Since(start))
	}
	if got := readAll(t, root, testID(80)); got != "beforeafter" {
		t.Fatalf("output %q", got)
	}
}

func TestTerminalEndsWithDisownedChild(t *testing.T) {
	root := shortRoot(t)
	r := newTestRunner(t, root, "1.0.0")
	if _, err := r.Start(model.StartParams{ID: testID(81), Path: root}, "terminal"); err != nil {
		t.Fatal(err)
	}
	if err := r.Input(testID(81), "sleep 30 & echo $! > child.pid; printf '\\nLEFT\\n'; exit\r", false); err != nil {
		t.Fatal(err)
	}
	defer func() {
		var pid int
		if b, err := os.ReadFile(filepath.Join(root, "child.pid")); err == nil {
			if fmt.Sscan(string(b), &pid); pid > 0 {
				syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	}()
	waitOutput(t, root, testID(81), "LEFT")
	if job := waitCompleted(t, root, testID(81)); job.Status == "running" {
		t.Fatalf("%+v", job)
	}
}
