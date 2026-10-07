package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"hostherd/agent/internal/ipc"
	"hostherd/agent/internal/model"
	"hostherd/agent/internal/spool"
	"hostherd/agent/internal/store"
)

func newTestRunner(t *testing.T, root, generation string) *Runner {
	t.Helper()
	r, err := New(root, generation, generation)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Serve(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, err = ipc.Health(ctx, root, generation)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Cleanup(func() {
		r.mu.Lock()
		ids := make([]string, 0, len(r.active))
		for id := range r.active {
			ids = append(ids, id)
		}
		r.mu.Unlock()
		for _, id := range ids {
			r.Cancel(id)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			r.mu.Lock()
			n := len(r.active)
			r.mu.Unlock()
			if n == 0 || time.Now().After(deadline) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		<-done
	})
	return r
}
func shortRoot(t *testing.T) string {
	t.Helper()
	path, err := os.MkdirTemp("", "mm-run-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(path) })
	return path
}
func testID(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

func TestHealthRemainsResponsiveDuringJobPersistence(t *testing.T) {
	root := shortRoot(t)
	r := newTestRunner(t, root, "1.0.0")
	job, err := r.Start(model.StartParams{ID: testID(790), Path: root, Cmd: "read -r line"}, "job")
	if err != nil {
		t.Fatal(err)
	}
	check := func(want float64) {
		t.Helper()
		// Completion/start persistence holds this mutex while fsync can block.
		// The liveness response must remain available and keep its active count.
		r.mu.Lock()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		health, err := ipc.Health(ctx, root, "1.0.0")
		cancel()
		r.mu.Unlock()
		if err != nil {
			t.Fatalf("healthy runner blocked by job persistence: %v", err)
		}
		if health["active"] != want {
			t.Fatalf("active executions: got %v want %v", health["active"], want)
		}
	}
	check(1)
	if err := r.Input(job.ID, "finished\n", true); err != nil {
		t.Fatal(err)
	}
	waitCompleted(t, root, job.ID)
	check(0)
}

func TestWorkingDirectoryValidationWithinStart(t *testing.T) {
	root := shortRoot(t)
	r := newTestRunner(t, root, "1.0.0")
	marker := filepath.Join(root, "must-not-run")
	paths := []string{"/bin/bash", filepath.Join(root, "missing"), "/bin/bash/child"}
	for i, invalidPath := range paths {
		for k, kind := range []string{"job", "terminal"} {
			p := model.StartParams{ID: testID(800 + i*2 + k), Path: invalidPath, Cmd: "touch " + marker}
			job, err := r.Start(p, kind)
			var rpcErr *model.RPCError
			if !errors.As(err, &rpcErr) || rpcErr.Code != "INVALID_WORKDIR" || job.PID != 0 {
				t.Fatalf("expected directory input error: %+v %v", job, err)
			}
			if !strings.Contains(err.Error(), invalidPath) || !strings.Contains(err.Error(), "command was not started") {
				t.Fatalf("directory error lacks corrective context: %q", err)
			}
			if _, err := store.ReadRecord(root, p.ID); !os.IsNotExist(err) {
				t.Fatalf("validation created a runner job: %v", err)
			}
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("invalid directory ran command: %v", err)
	}
	workdir := filepath.Join(root, "work")
	if err := os.Mkdir(workdir, 0700); err != nil {
		t.Fatal(err)
	}
	p := model.StartParams{ID: testID(810), Path: workdir, Cmd: "printf '%s' \"$PWD\""}
	job, err := r.Start(p, "job")
	if err != nil {
		t.Fatal(err)
	}
	if done := waitCompleted(t, root, job.ID); done.Status != "completed" || readAll(t, root, job.ID) != workdir {
		t.Fatalf("corrected directory did not run normally: %+v", done)
	}
	if err := os.Remove(workdir); err != nil {
		t.Fatal(err)
	}
	duplicate, err := r.Start(p, "job")
	if err != nil || duplicate.ID != job.ID || duplicate.Status != "completed" {
		t.Fatalf("directory validation broke existing job deduplication: %+v %v", duplicate, err)
	}
}

func waitCompleted(t *testing.T, root, id string) model.Job {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		record, err := store.ReadRecord(root, id)
		if err != nil {
			t.Fatal(err)
		}
		if record.Job.Status != "running" {
			return record.Job
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s did not complete: %+v", id, record.Job)
		}
		time.Sleep(15 * time.Millisecond)
	}
}
func readAll(t *testing.T, root, id string) string {
	t.Helper()
	var b strings.Builder
	var offset int64
	for {
		chunk, err := spool.Read(store.JobDir(root, id), offset)
		if err != nil {
			t.Fatal(err)
		}
		if len(chunk) == 0 {
			break
		}
		b.Write(chunk)
		offset += int64(len(chunk))
	}
	return b.String()
}
func waitOutput(t *testing.T, root, id, want string) string {
	t.Helper()
	deadline := time.Now().Add(7 * time.Second)
	for {
		output := readAll(t, root, id)
		if strings.Contains(output, want) {
			return output
		}
		if time.Now().After(deadline) {
			t.Fatalf("output missing %q: %q", want, output)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestFiveIndependentJobsStdinEOFDedupAndGeneration(t *testing.T) {
	root := shortRoot(t)
	old := newTestRunner(t, root, "1.0.0")
	next := newTestRunner(t, root, "1.1.0")
	for i := 1; i <= 5; i++ {
		p := model.StartParams{ID: testID(i), Path: root, Cmd: "cat; printf '\\nfinished:%s' \"$PWD\""}
		job, err := old.Start(p, "job")
		if err != nil || job.Status != "running" {
			t.Fatalf("start %+v %v", job, err)
		}
		duplicate, err := next.Start(p, "job")
		if err != nil || duplicate.PID != job.PID || duplicate.RunnerVersion != "1.0.0" {
			t.Fatalf("generation dedup %+v %v", duplicate, err)
		}
	}
	old.mu.Lock()
	active := len(old.active)
	old.mu.Unlock()
	if active != 5 {
		t.Fatalf("wanted 5 live jobs, got %d", active)
	}
	for i := 1; i <= 5; i++ {
		input := fmt.Sprintf("input-%d", i)
		if err := old.Input(testID(i), input, true); err != nil {
			t.Fatal(err)
		}
		job := waitCompleted(t, root, testID(i))
		if job.Status != "completed" {
			t.Fatalf("%+v", job)
		}
		want := input + "\nfinished:" + root
		if got := readAll(t, root, testID(i)); got != want {
			t.Fatalf("output %q want %q", got, want)
		}
	}
	_, err := next.Start(model.StartParams{ID: testID(1), Path: root, Cmd: "touch should-not-run"}, "job")
	if err == nil {
		t.Fatal("same ID accepted changed command")
	}
	job, err := next.Start(model.StartParams{ID: testID(6), Path: root, Cmd: "printf new-generation"}, "job")
	if err != nil || job.RunnerVersion != "1.1.0" {
		t.Fatal(job, err)
	}
	waitCompleted(t, root, testID(6))
}

func TestFiveTerminalsKeepShellAndResizeInterrupt(t *testing.T) {
	root := shortRoot(t)
	r := newTestRunner(t, root, "1.0.0")
	for i := 10; i < 15; i++ {
		job, err := r.Start(model.StartParams{ID: testID(i), Path: root, Cols: 100, Rows: 25}, "terminal")
		if err != nil || job.Status != "running" {
			t.Fatal(job, err)
		}
	}
	r.mu.Lock()
	active := len(r.active)
	r.mu.Unlock()
	if active != 5 {
		t.Fatalf("wanted 5 live terminals, got %d", active)
	}
	id := testID(10)
	if err := r.Input(id, "stty -echo\r", false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err := r.Input(id, "export HOSTHERD_TEST=persisted; cd /tmp; printf '\\nSTATE:%s:%s\\n' \"$HOSTHERD_TEST\" \"$PWD\"\r", false); err != nil {
		t.Fatal(err)
	}
	waitOutput(t, root, id, "STATE:persisted:/tmp")
	if err := r.Resize(id, 132, 41); err != nil {
		t.Fatal(err)
	}
	if err := r.Input(id, "stty size; printf '\\nSTILL:%s:%s\\n' \"$HOSTHERD_TEST\" \"$PWD\"\r", false); err != nil {
		t.Fatal(err)
	}
	output := waitOutput(t, root, id, "STILL:persisted:/tmp")
	if !strings.Contains(output, "41 132") {
		t.Fatalf("size was not applied: %q", output)
	}
	if err := r.Input(id, "sleep 30\r", false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := r.Input(id, "\x03", false); err != nil {
		t.Fatal(err)
	}
	if err := r.Input(id, "printf '\\nAFTER-INTERRUPT\\n'\r", false); err != nil {
		t.Fatal(err)
	}
	waitOutput(t, root, id, "AFTER-INTERRUPT")
	for i := 10; i < 15; i++ {
		if err := r.Cancel(testID(i)); err != nil {
			t.Fatal(err)
		}
		job := waitCompleted(t, root, testID(i))
		if job.Status != "interrupted" {
			t.Fatalf("terminal close: %+v", job)
		}
	}
}

func TestTimeoutAndRealFileRPC(t *testing.T) {
	root := shortRoot(t)
	r := newTestRunner(t, root, "1.0.0")
	job, err := r.Start(model.StartParams{ID: testID(30), Path: root, Cmd: "sleep 30", TimeoutMs: 100}, "job")
	if err != nil {
		t.Fatal(err)
	}
	completed := waitCompleted(t, root, job.ID)
	if completed.Status != "interrupted" {
		t.Fatal(completed)
	}
	path := filepath.Join(root, "created.txt")
	params, _ := json.Marshal(map[string]any{"path": path, "data": "needle\n", "createOnly": true})
	if _, err := ipc.Call(context.Background(), root, "1.0.0", model.Request{Method: "file.write", Params: params}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "needle\n" {
		t.Fatalf("file RPC result %q %v", data, err)
	}
}
