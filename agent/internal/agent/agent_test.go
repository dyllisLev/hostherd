//go:build linux || darwin

package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"hostherd/agent/internal/config"
	"hostherd/agent/internal/ipc"
	"hostherd/agent/internal/model"
	"hostherd/agent/internal/runner"
	"hostherd/agent/internal/spool"
	"hostherd/agent/internal/store"
)

func TestSpoolFaultKeepsConnectionAndOtherJobsAlive(t *testing.T) {
	for _, failure := range []string{"missing-output", "unreadable-ack"} {
		t.Run(failure, func(t *testing.T) {
			base, err := os.MkdirTemp("", "mm-spool-fault-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(base)
			root := filepath.Join(base, "runtime")
			stopRunner := testRuntime(t, root, "1.0.0")
			defer stopRunner()
			id := "66666666-6666-4666-8666-666666666661"
			dir := store.JobDir(root, id)
			if err = os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			job := model.Job{ID: id, Kind: "job", Status: "completed", RunnerVersion: "1.0.0"}
			if err = store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0"}); err != nil {
				t.Fatal(err)
			}
			output := bytes.Repeat([]byte("x"), 1784)
			writer, err := spool.NewWriter(dir)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = writer.Write(output); err != nil {
				t.Fatal(err)
			}
			if err = writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err = spool.Ack(dir, 1744); err != nil {
				t.Fatal(err)
			}
			brokenPath := filepath.Join(dir, "output-00000000000000000000.bin")
			if failure == "unreadable-ack" {
				brokenPath = filepath.Join(dir, "ack.json")
			}
			saved, err := os.ReadFile(brokenPath)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.Remove(brokenPath); err != nil {
				t.Fatal(err)
			}
			if failure == "unreadable-ack" {
				if err = os.Mkdir(brokenPath, 0700); err != nil {
					t.Fatal(err)
				}
			}
			h := &testCentral{outputs: map[string][]byte{id: append([]byte(nil), output[:1744]...)}, jobs: map[string]model.Job{}, responses: map[string]chan model.Response{}}
			server := httptest.NewServer(http.HandlerFunc(h.serve))
			defer server.Close()
			cfg := config.Config{URL: server.URL, Token: "integration-token", ExecutionUser: "root", StateDir: root, Generation: "1.0.0", Version: "1.0.0"}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- connect(ctx, cfg, "", "1.0.0") }()
			defer func() { cancel(); <-done }()
			deadline := time.Now().Add(5 * time.Second)
			for {
				h.mu.Lock()
				faulted := len(h.faults) > 0
				h.mu.Unlock()
				if faulted {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("missing spool fault")
				}
				time.Sleep(10 * time.Millisecond)
			}
			// A real RPC and a second job's output must work on the same socket.
			goodID := "66666666-6666-4666-8666-666666666662"
			h.call(t, "job.start", map[string]any{"id": goodID, "path": root, "cmd": "printf healthy"})
			h.waitOutput(t, goodID, func(b []byte) bool { return string(b) == "healthy" })
			time.Sleep(350 * time.Millisecond) // Multiple retries must neither spam nor skip the missing bytes.
			h.mu.Lock()
			faults := append([]string(nil), h.faults...)
			cursor, connections := len(h.outputs[id]), h.connections
			h.mu.Unlock()
			if len(faults) != 1 || !strings.HasPrefix(faults[0], id+": ") || cursor != 1744 || connections != 1 {
				t.Fatalf("faults=%v cursor=%d connections=%d", faults, cursor, connections)
			}
			// Restore the fixture's exact bytes; retry must resume without reconnect.
			if failure == "unreadable-ack" {
				if err = os.Remove(brokenPath); err != nil {
					t.Fatal(err)
				}
			}
			if err = store.AtomicWrite(brokenPath, saved, 0600); err != nil {
				t.Fatal(err)
			}
			got := h.waitOutput(t, id, func(b []byte) bool { return len(b) == len(output) })
			if !bytes.Equal(got, output) {
				t.Fatal("recovered output differs")
			}
			h.mu.Lock()
			connections = h.connections
			h.mu.Unlock()
			if connections != 1 {
				t.Fatal("spool recovery reconnected")
			}
		})
	}
}

func TestACKCleanupFailureRetainsCentralCursor(t *testing.T) {
	root := t.TempDir()
	id := "77777777-7777-4777-8777-777777777771"
	dir := store.JobDir(root, id)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	job := model.Job{ID: id, Kind: "job", Status: "completed"}
	if err := store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0"}); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]any{"end": 1784, "ack": 1744, "closed": true} {
		if err := store.AtomicJSON(filepath.Join(dir, name+".json"), value); err != nil {
			t.Fatal(err)
		}
	}
	// Make cleanup fail after ack.json has already advanced to the final ACK.
	segment := filepath.Join(dir, "output-00000000000000000000.bin")
	if err := os.Mkdir(segment, 0700); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(segment, "blocker")
	if err := os.WriteFile(blocker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	faults := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			var message struct{ Type, Message string }
			if ws.ReadJSON(&message) != nil {
				return
			}
			if message.Type == "fault" {
				faults <- message.Message
			}
		}
	}))
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	s := &streamState{cursor: 1744, pendingEnd: 1784}
	c := &connection{ws: ws, c: config.Config{StateDir: root}, streams: map[string]*streamState{id: s}, sentStates: map[string]string{}, settled: map[string]bool{}, wakeup: make(chan struct{}, 1)}
	if err = c.ack(id, 1784); err != nil {
		t.Fatal("local cleanup disconnected agent", err)
	}
	if s.cursor != 1784 || s.pendingEnd != 0 {
		t.Fatal("central ACK lost", s)
	}
	if ack, err := spool.Acked(dir); err != nil || ack != 1784 {
		t.Fatal("local ACK", ack, err)
	}
	select {
	case fault := <-faults:
		if !strings.HasPrefix(fault, id+": ") {
			t.Fatal(fault)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup failure not reported")
	}
	if err = os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err = c.syncJobs(); err != nil {
		t.Fatal("cleanup retry failed", err)
	}
	if s.fault != "" {
		t.Fatal("cleanup did not recover", s.fault)
	}
	if _, err = os.Stat(segment); !os.IsNotExist(err) {
		t.Fatal("cleanup did not retry", err)
	}
}

// Idle CPU regression: finished, fully ACKed jobs must not be reread on every
// pump tick, while running jobs keep being polled.
func TestSettledJobsAreNotRescanned(t *testing.T) {
	root := t.TempDir()
	doneID := "77777777-7777-4777-8777-777777777781"
	liveID := "77777777-7777-4777-8777-777777777782"
	for _, job := range []model.Job{{ID: doneID, Kind: "job", Status: "completed"}, {ID: liveID, Kind: "job", Status: "running"}} {
		if err := os.MkdirAll(store.JobDir(root, job.ID), 0700); err != nil {
			t.Fatal(err)
		}
		if err := store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0"}); err != nil {
			t.Fatal(err)
		}
	}
	dir := store.JobDir(root, doneID)
	writer, err := spool.NewWriter(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Write([]byte("done")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	messages := make(chan string, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			var message struct{ Type, JobID string }
			if ws.ReadJSON(&message) != nil {
				return
			}
			messages <- message.Type + " " + message.JobID
		}
	}))
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	streams := map[string]*streamState{doneID: {cursor: 4}}
	c := &connection{ws: ws, c: config.Config{StateDir: root}, streams: streams, sentStates: map[string]string{}, settled: map[string]bool{}, wakeup: make(chan struct{}, 1), health: map[string]runnerHealth{liveID: {checked: time.Now()}}}
	if err = c.syncJobs(); err != nil {
		t.Fatal(err)
	}
	if !c.settled[doneID] || c.settled[liveID] {
		t.Fatal("settled", c.settled)
	}
	if _, err = os.Stat(filepath.Join(dir, "output-00000000000000000000.bin")); !os.IsNotExist(err) {
		t.Fatal("ACKed output kept", err)
	}
	// An unreadable settled record proves it is skipped; the live job still streams.
	if err = os.WriteFile(filepath.Join(dir, "meta.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	live, err := spool.NewWriter(store.JobDir(root, liveID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = live.Write([]byte("more")); err != nil {
		t.Fatal(err)
	}
	if err = c.syncJobs(); err != nil {
		t.Fatal("settled job reread", err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case message := <-messages:
			if message == "output "+liveID {
				return
			}
		case <-deadline:
			t.Fatal("running job not polled")
		}
	}
}

// A single late health reply must not raise RUNNER_UNAVAILABLE. A runner that
// is gone, or that keeps missing the confirming probe, still faults on that probe.
func TestSingleRunnerHealthDelayDoesNotFault(t *testing.T) {
	t.Run("one slow reply", func(t *testing.T) {
		t.Parallel()
		root := shortTemp(t)
		id := "88888888-8888-4888-8888-888888888881"
		var calls sync.Mutex
		var n int
		serveRunnerHealth(t, root, "1.0.0", func(w http.ResponseWriter, r *http.Request) {
			calls.Lock()
			n++
			attempt := n
			calls.Unlock()
			if attempt == 1 {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(2 * time.Second):
				}
			}
			writeRunnerHealth(w)
		})
		c, messages, mu := captureSync(t, root, id)
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		got := snapshotMessages(t, mu, messages)
		if faults := faultMessages(got); len(faults) != 0 {
			t.Fatal("slow reply faulted", faults)
		}
		for _, m := range got {
			if m.Type == "state" && m.Job.ErrorCode != "" {
				t.Fatal("slow reply marked the job", m.Job.ErrorCode)
			}
		}
		if c.health["1.0.0"].misses != 1 {
			t.Fatalf("misses = %d, want 1", c.health["1.0.0"].misses)
		}
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		if c.health["1.0.0"].misses != 1 {
			t.Fatal("pump tick counted as another miss")
		}
		time.Sleep(runnerProbeConfirm + 100*time.Millisecond)
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		if c.health["1.0.0"].misses != 0 {
			t.Fatalf("recovery misses = %d", c.health["1.0.0"].misses)
		}
		if faults := faultMessages(snapshotMessages(t, mu, messages)); len(faults) != 0 {
			t.Fatal("recovery faulted", faults)
		}
	})
	t.Run("dead", func(t *testing.T) {
		t.Parallel()
		root := shortTemp(t)
		id := "88888888-8888-4888-8888-888888888882"
		c, messages, mu := captureSync(t, root, id)
		started := time.Now()
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		if faults := faultMessages(snapshotMessages(t, mu, messages)); len(faults) != 0 {
			t.Fatal("first miss faulted", faults)
		}
		if c.health["1.0.0"].misses != 1 {
			t.Fatalf("misses = %d, want 1", c.health["1.0.0"].misses)
		}
		time.Sleep(runnerProbeConfirm + 100*time.Millisecond)
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		got := snapshotMessages(t, mu, messages)
		faults := faultMessages(got)
		if len(faults) != 1 || faults[0] != id+": runner unavailable; execution state cannot be confirmed" {
			t.Fatal(faults)
		}
		if time.Since(started) > 3*time.Second {
			t.Fatalf("dead runner fault took %s", time.Since(started))
		}
		if !sawUnavailable(got, id) {
			t.Fatal("running job was not marked unavailable", got)
		}
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		if faults := faultMessages(snapshotMessages(t, mu, messages)); len(faults) != 1 {
			t.Fatal("fault repeated", faults)
		}
	})
	t.Run("silent", func(t *testing.T) {
		t.Parallel()
		root := shortTemp(t)
		id := "88888888-8888-4888-8888-888888888883"
		serveRunnerHealth(t, root, "1.0.0", func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		})
		c, messages, mu := captureSync(t, root, id)
		started := time.Now()
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		if faults := faultMessages(snapshotMessages(t, mu, messages)); len(faults) != 0 {
			t.Fatal("first timeout faulted", faults)
		}
		time.Sleep(runnerProbeConfirm + 100*time.Millisecond)
		if err := c.syncJobs(); err != nil {
			t.Fatal(err)
		}
		got := snapshotMessages(t, mu, messages)
		faults := faultMessages(got)
		if len(faults) != 1 || faults[0] != id+": runner unavailable; execution state cannot be confirmed" {
			t.Fatal(faults)
		}
		if !sawUnavailable(got, id) {
			t.Fatal("silent runner was not marked unavailable", got)
		}
		if time.Since(started) > 4*time.Second {
			t.Fatalf("silent runner fault took %s", time.Since(started))
		}
	})
}

func shortTemp(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "rh-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func serveRunnerHealth(t *testing.T, root, generation string, handler http.HandlerFunc) {
	t.Helper()
	sock := store.SocketPath(root, generation)
	if err := os.MkdirAll(filepath.Dir(sock), 0700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
}

func writeRunnerHealth(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": model.Protocol})
}

type captured struct {
	Type    string    `json:"type"`
	Job     model.Job `json:"job"`
	Message string    `json:"message"`
}

func captureSync(t *testing.T, root, id string) (*connection, *[]captured, *sync.Mutex) {
	t.Helper()
	if err := os.MkdirAll(store.JobDir(root, id), 0700); err != nil {
		t.Fatal(err)
	}
	job := model.Job{ID: id, Kind: "job", Status: "running", Path: "/tmp", Cmd: "true"}
	if err := store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0"}); err != nil {
		t.Fatal(err)
	}
	messages := []captured{}
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			var message captured
			if ws.ReadJSON(&message) != nil {
				return
			}
			mu.Lock()
			messages = append(messages, message)
			mu.Unlock()
		}
	}))
	t.Cleanup(server.Close)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	c := &connection{ws: ws, c: config.Config{StateDir: root}, streams: map[string]*streamState{}, sentStates: map[string]string{}, settled: map[string]bool{}, wakeup: make(chan struct{}, 1), health: map[string]runnerHealth{}}
	return c, &messages, &mu
}

func snapshotMessages(t *testing.T, mu *sync.Mutex, messages *[]captured) []captured {
	t.Helper()
	var last []captured
	stableSince := time.Now()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := append([]captured(nil), (*messages)...)
		mu.Unlock()
		if len(got) == len(last) && len(got) > 0 && time.Since(stableSince) >= 150*time.Millisecond {
			return got
		}
		if len(got) != len(last) {
			last = got
			stableSince = time.Now()
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(last) == 0 {
		t.Fatal("no agent messages")
	}
	return last
}

func faultMessages(messages []captured) []string {
	var out []string
	for _, m := range messages {
		if m.Type == "fault" {
			out = append(out, m.Message)
		}
	}
	return out
}

func sawUnavailable(messages []captured, id string) bool {
	for _, m := range messages {
		if m.Type == "state" && m.Job.ID == id && m.Job.ErrorCode == "RUNNER_UNAVAILABLE" {
			return true
		}
	}
	return false
}

type peer struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (p *peer) send(v any) error { p.mu.Lock(); defer p.mu.Unlock(); return p.ws.WriteJSON(v) }

type testCentral struct {
	mu          sync.Mutex
	peer        *peer
	outputs     map[string][]byte
	jobs        map[string]model.Job
	responses   map[string]chan model.Response
	seq         int
	dropACK     bool
	dropped     bool
	connections int
	problem     error
	faults      []string
}

func (h *testCentral) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer integration-token" {
		w.WriteHeader(401)
		return
	}
	ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	p := &peer{ws: ws}
	defer ws.Close()
	var hello map[string]any
	if err = ws.ReadJSON(&hello); err != nil || hello["type"] != "hello" || hello["protocol"] != float64(1) {
		return
	}
	h.mu.Lock()
	cursors := map[string]int64{}
	for id, data := range h.outputs {
		cursors[id] = int64(len(data))
	}
	h.mu.Unlock()
	if err = p.send(map[string]any{"type": "welcome", "cursors": cursors}); err != nil {
		return
	}
	h.mu.Lock()
	h.peer = p
	h.connections++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if h.peer == p {
			h.peer = nil
		}
		h.mu.Unlock()
	}()
	for {
		var raw json.RawMessage
		if err = ws.ReadJSON(&raw); err != nil {
			return
		}
		var msg struct {
			Type    string    `json:"type"`
			Job     model.Job `json:"job"`
			JobID   string    `json:"jobId"`
			Offset  int64     `json:"offset"`
			Data    string    `json:"data"`
			Message string    `json:"message"`
		}
		if err = json.Unmarshal(raw, &msg); err != nil {
			return
		}
		switch msg.Type {
		case "fault":
			h.mu.Lock()
			h.faults = append(h.faults, msg.Message)
			h.mu.Unlock()
		case "state":
			h.mu.Lock()
			h.jobs[msg.Job.ID] = msg.Job
			h.mu.Unlock()
		case "response":
			var response model.Response
			if err = json.Unmarshal(raw, &response); err != nil {
				return
			}
			h.mu.Lock()
			ch := h.responses[response.ID]
			h.mu.Unlock()
			if ch != nil {
				select {
				case ch <- response:
				default:
				}
			}
		case "output":
			data, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil {
				return
			}
			h.mu.Lock()
			existing := h.outputs[msg.JobID]
			if msg.Offset > int64(len(existing)) {
				h.problem = fmt.Errorf("output gap %d > %d", msg.Offset, len(existing))
				h.mu.Unlock()
				return
			}
			if msg.Offset == int64(len(existing)) {
				existing = append(existing, data...)
				h.outputs[msg.JobID] = existing
			}
			drop := h.dropACK && !h.dropped
			if drop {
				h.dropped = true
			}
			end := len(existing)
			h.mu.Unlock()
			if drop {
				return
			}
			if err = p.send(map[string]any{"type": "ack", "jobId": msg.JobID, "offset": end}); err != nil {
				return
			}
		}
	}
}
func (h *testCentral) call(t *testing.T, method string, params any) any {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	for {
		h.mu.Lock()
		p := h.peer
		h.seq++
		id := fmt.Sprint(h.seq)
		ch := make(chan model.Response, 1)
		h.responses[id] = ch
		h.mu.Unlock()
		if p != nil {
			if err := p.send(map[string]any{"type": "request", "id": id, "method": method, "params": params}); err == nil {
				select {
				case response := <-ch:
					h.mu.Lock()
					delete(h.responses, id)
					h.mu.Unlock()
					if response.Error != nil {
						t.Fatalf("%s: %s", method, response.Error.Message)
					}
					return response.Result
				case <-time.After(time.Second):
				}
			}
		}
		h.mu.Lock()
		delete(h.responses, id)
		h.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("central request timed out: %s", method)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
func (h *testCentral) waitOutput(t *testing.T, id string, predicate func([]byte) bool) []byte {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for {
		h.mu.Lock()
		data := h.outputs[id]
		matched := predicate(data)
		size := len(data)
		if matched {
			data = append([]byte(nil), data...)
		}
		problem := h.problem
		h.mu.Unlock()
		if problem != nil {
			t.Fatal(problem)
		}
		if matched {
			return data
		}
		if time.Now().After(deadline) {
			t.Fatalf("output predicate timed out for %s: %d bytes", id, size)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
func testRuntime(t *testing.T, root, generation string) context.CancelFunc {
	t.Helper()
	r, err := runner.New(root, generation, generation)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go r.Serve(ctx)
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
	return cancel
}

func TestFileTransferRoutesToOwningRunnerAfterUpdate(t *testing.T) {
	root, err := os.MkdirTemp("", "mm-transfer-route-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	oldCancel := testRuntime(t, root, "1.0.0")
	defer oldCancel()
	newCancel := testRuntime(t, root, "1.0.1")
	defer newCancel()
	c := &connection{c: config.Config{StateDir: root, Generation: "1.0.0"}}
	id := "c401c370-03e5-4f2c-96be-012345678930"
	call := func(method string, params map[string]any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(params)
		result, err := c.dispatch(context.Background(), model.Request{Method: "file.transfer." + method, Params: raw})
		if err != nil {
			t.Fatal(err)
		}
		return result.(map[string]any)
	}
	opened := call("open", map[string]any{"id": id, "direction": "upload", "path": filepath.Join(root, "destination")})
	c.c.Generation = "1.0.1"
	state := call("write", map[string]any{"id": id, "generation": opened["generation"], "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("same transfer"))})
	if state["generation"] != "1.0.0" || state["bytes"] != float64(13) {
		t.Fatal("update rerouted a transfer to the new runner", state)
	}
	oldHealth, err := ipc.Health(context.Background(), root, "1.0.0")
	if err != nil || oldHealth["active"] != float64(1) {
		t.Fatal("in-progress file transfer must prevent retiring its runner", oldHealth, err)
	}
	call("abort", map[string]any{"id": id, "generation": "1.0.0"})
	oldHealth, err = ipc.Health(context.Background(), root, "1.0.0")
	if err != nil || oldHealth["active"] != float64(0) {
		t.Fatal("closed transfer must release the runner", oldHealth, err)
	}
}

func TestReconnectACKResumeAndOldGenerationRouting(t *testing.T) {
	base, err := os.MkdirTemp("", "mm-agent-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	root := filepath.Join(base, "runtime")
	stopOld := testRuntime(t, root, "1.0.0")
	defer stopOld()
	h := &testCentral{outputs: map[string][]byte{}, jobs: map[string]model.Job{}, responses: map[string]chan model.Response{}, dropACK: true}
	server := httptest.NewServer(http.HandlerFunc(h.serve))
	defer server.Close()
	defer func() {
		h.mu.Lock()
		if h.peer != nil {
			h.peer.ws.Close()
		}
		h.mu.Unlock()
	}()
	cfg := config.Config{URL: server.URL, Token: "integration-token", ExecutionUser: "root", StateDir: root, Generation: "1.0.0", Version: "1.0.0"}
	configPath := filepath.Join(base, "config.json")
	if err = config.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	startAgent := func(version string) (context.CancelFunc, chan error) {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { defer close(done); done <- Run(ctx, configPath, version) }()
		return cancel, done
	}
	cancelAgent, agentDone := startAgent("1.0.0")
	defer func() { cancelAgent(); <-agentDone }()
	id := "11111111-1111-4111-8111-111111111111"
	terminalID := "22222222-2222-4222-8222-222222222222"
	params := map[string]any{"id": id, "path": root, "cmd": "printf x >> side-effect; head -c 4194304 /dev/zero | tr '\\000' A; cat; printf ':done'"}
	h.call(t, "job.start", params)
	data := h.waitOutput(t, id, func(b []byte) bool { return len(b) >= 4194304 })
	if len(data) != 4194304 || strings.Trim(string(data), "A") != "" {
		t.Fatal("large output changed during ACK loss/reconnect")
	}
	h.call(t, "job.start", params) // Repeating the same accepted ID must not run again.
	sideEffect, err := os.ReadFile(filepath.Join(root, "side-effect"))
	if err != nil || string(sideEffect) != "x" {
		t.Fatalf("duplicate execution: %q %v", sideEffect, err)
	}
	h.call(t, "terminal.create", map[string]any{"id": terminalID, "path": root, "cols": 80, "rows": 24})
	h.call(t, "terminal.input", map[string]any{"id": terminalID, "data": "stty -echo\r"})
	time.Sleep(100 * time.Millisecond)
	h.call(t, "terminal.input", map[string]any{"id": terminalID, "data": "export SAVED=kept; cd /tmp; printf '\\nREADY-PTY\\n'\r"})
	h.waitOutput(t, terminalID, func(b []byte) bool { return strings.Contains(string(b), "READY-PTY") })
	// Communication shutdown neither owns nor terminates job/PTY processes.
	cancelAgent()
	if err = <-agentDone; err != nil {
		t.Fatal(err)
	}
	oldRecord, err := store.ReadRecord(root, id)
	if err != nil || oldRecord.Job.Status != "running" {
		t.Fatal(oldRecord, err)
	}
	stopNext := testRuntime(t, root, "1.1.0")
	defer stopNext()
	cfg.Generation = "1.1.0"
	cfg.Version = "1.1.0"
	if err = config.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	cancelAgent, agentDone = startAgent("1.1.0")
	h.call(t, "terminal.resize", map[string]any{"id": terminalID, "cols": 121, "rows": 37})
	h.call(t, "terminal.input", map[string]any{"id": terminalID, "data": "printf '\\nRESTORED:%s:%s\\n' \"$SAVED\" \"$PWD\"; stty size\r"})
	terminal := h.waitOutput(t, terminalID, func(b []byte) bool {
		return strings.Contains(string(b), "RESTORED:kept:/tmp") && strings.Contains(string(b), "37 121")
	})
	_ = terminal
	h.call(t, "job.input", map[string]any{"id": id, "data": "input-after-restart", "eof": true})
	data = h.waitOutput(t, id, func(b []byte) bool { return strings.HasSuffix(string(b), "input-after-restart:done") })
	if len(data) != 4194304+len("input-after-restart:done") {
		t.Fatalf("output length %d", len(data))
	}
	newID := "33333333-3333-4333-8333-333333333333"
	h.call(t, "job.start", map[string]any{"id": newID, "path": root, "cmd": "printf new"})
	h.waitOutput(t, newID, func(b []byte) bool { return string(b) == "new" })
	record, err := store.ReadRecord(root, newID)
	if err != nil || record.Owner != "1.1.0" {
		t.Fatal(record, err)
	}
	h.call(t, "terminal.close", map[string]any{"id": terminalID})
	deadline := time.Now().Add(6 * time.Second)
	for {
		record, err = store.ReadRecord(root, terminalID)
		if err == nil && record.Job.Status != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not close")
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.mu.Lock()
	dropped, connections := h.dropped, h.connections
	h.mu.Unlock()
	if !dropped || connections < 3 {
		t.Fatalf("expected lost ACK + reconnect + agent restart, connections=%d dropped=%v", connections, dropped)
	}
}

func TestRetentionKeepsLiveAndUnacknowledgedOutput(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	ids := []string{"44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442", "44444444-4444-4444-8444-444444444443", "44444444-4444-4444-8444-444444444444"}
	for index, id := range ids {
		dir := store.JobDir(root, id)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		job := model.Job{ID: id, Kind: "job", Path: "/tmp", Cmd: "expired-secret-command", Status: "completed", StartedAt: now.Add(-32 * 24 * time.Hour).Format(time.RFC3339Nano), EndedAt: now.Add(-31 * 24 * time.Hour).Format(time.RFC3339Nano), RunnerVersion: "1.0.0"}
		if index == 1 {
			job.Status = "running"
			job.EndedAt = ""
			job.Kind = "terminal"
		}
		if index == 3 {
			job.EndedAt = now.Add(-time.Hour).Format(time.RFC3339Nano)
		}
		if err := store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0", RequestHash: "hash"}); err != nil {
			t.Fatal(err)
		}
		writer, err := spool.NewWriter(dir)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Write([]byte("saved-output")); err != nil {
			t.Fatal(err)
		}
		if index != 1 {
			if err = writer.Close(); err != nil {
				t.Fatal(err)
			}
		}
		if index != 2 {
			if err = spool.Ack(dir, int64(len("saved-output"))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := pruneCompleted(root, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.JobDir(root, ids[0])); !os.IsNotExist(err) {
		t.Fatal("expired synchronized job retained", err)
	}
	tombstone, err := os.ReadFile(filepath.Join(root, "tombstones", ids[0]+".json"))
	if err != nil || strings.Contains(string(tombstone), "secret") {
		t.Fatal("bad dedup tombstone", err)
	}
	for _, id := range ids[1:] {
		if _, err := store.ReadRecord(root, id); err != nil {
			t.Fatal("live, recent or unacknowledged job was removed", id, err)
		}
	}
}

func TestReconnectKeepsJobFailuresSeparateFromRuntimeFaults(t *testing.T) {
	base, err := os.MkdirTemp("", "mm-fault-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	root := filepath.Join(base, "runtime")
	stopRunner := testRuntime(t, root, "1.0.0")
	defer stopRunner()
	cases := []struct {
		id, code, message string
		runtime           bool
	}{
		{"55555555-5555-4555-8555-555555555551", "", "fork/exec /bin/bash: not a directory", false},
		{"55555555-5555-4555-8555-555555555552", "START_FAILED", "fork/exec /bin/bash: permission denied", false},
		{"55555555-5555-4555-8555-555555555553", "OUTPUT_STORAGE", "output storage/runtime fault: disk full", true},
		{"55555555-5555-4555-8555-555555555554", "RUNNER_STOPPED", "runner stopped; process continuity cannot be guaranteed", true},
	}
	for _, tc := range cases {
		if err := os.MkdirAll(store.JobDir(root, tc.id), 0700); err != nil {
			t.Fatal(err)
		}
		job := model.Job{ID: tc.id, Kind: "job", Path: "/tmp", Cmd: "true", Status: "failed", Error: tc.message, ErrorCode: tc.code, RunnerVersion: "1.0.0"}
		if err := store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0", RequestHash: "fixture"}); err != nil {
			t.Fatal(err)
		}
	}
	h := &testCentral{outputs: map[string][]byte{}, jobs: map[string]model.Job{}, responses: map[string]chan model.Response{}}
	server := httptest.NewServer(http.HandlerFunc(h.serve))
	defer server.Close()
	cfg := config.Config{URL: server.URL, Token: "integration-token", ExecutionUser: "root", StateDir: root, Generation: "1.0.0", Version: "1.0.0"}
	configPath := filepath.Join(base, "config.json")
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- Run(ctx, configPath, "1.0.0") }()
		deadline := time.Now().Add(5 * time.Second)
		for {
			h.mu.Lock()
			ready := len(h.jobs) == len(cases) && len(h.faults) >= 2*attempt
			h.mu.Unlock()
			if ready || time.Now().After(deadline) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		h.mu.Lock()
		faults := append([]string(nil), h.faults...)
		jobs := len(h.jobs)
		h.mu.Unlock()
		if jobs != len(cases) || len(faults) != 2*attempt {
			t.Fatalf("jobs=%d faults=%v", jobs, faults)
		}
		for _, fault := range faults {
			if !strings.HasPrefix(fault, cases[2].id+": ") && !strings.HasPrefix(fault, cases[3].id+": ") {
				t.Fatalf("ordinary job failure became server fault: %s", fault)
			}
		}
	}
}

func TestRetentionLeavesSharedStateToRunnerAccount(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root, like the communication agent")
	}
	root := t.TempDir()
	const uid, gid = 65534, 65534
	if err := os.Chown(root, uid, gid); err != nil {
		t.Fatal(err)
	}
	// The root agent may create the lock before the runner's first job.
	if err := os.WriteFile(filepath.Join(root, "jobs.lock"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	id := "66666666-6666-4666-8666-666666666661"
	now := time.Now().UTC()
	dir := store.JobDir(root, id)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	job := model.Job{ID: id, Kind: "job", Path: "/tmp", Cmd: "true", Status: "completed", StartedAt: now.Add(-32 * 24 * time.Hour).Format(time.RFC3339Nano), EndedAt: now.Add(-31 * 24 * time.Hour).Format(time.RFC3339Nano), RunnerVersion: "1.0.0"}
	if err := store.WriteRecord(root, model.Record{Job: job, Owner: "1.0.0", RequestHash: "hash"}); err != nil {
		t.Fatal(err)
	}
	writer, err := spool.NewWriter(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err = spool.Ack(dir, 0); err != nil {
		t.Fatal(err)
	}
	if err = pruneCompleted(root, now); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"jobs.lock", "tombstones"} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if s := info.Sys().(*syscall.Stat_t); s.Uid != uid || s.Gid != gid {
			t.Fatalf("%s owned by %d:%d; runner account cannot use it", name, s.Uid, s.Gid)
		}
	}
}

func TestWelcomePublicURLIsPersistedForNextConnection(t *testing.T) {
	for _, tc := range []struct {
		name, current, announced, want string
	}{
		{"changed", "https://old.example", "https://new.example/", "https://new.example"},
		{"same origin", "https://new.example", "https://NEW.example/", "https://new.example"},
		{"http rejected from https", "https://old.example", "http://new.example", "https://old.example"},
		{"relative rejected", "https://old.example", "/new", "https://old.example"},
		{"other scheme rejected", "https://old.example", "ftp://new.example", "https://old.example"},
		{"http allowed from http", "http://127.0.0.1:1", "http://127.0.0.1:2", "http://127.0.0.1:2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			c := config.Config{URL: tc.current, Token: "secret", StateDir: "/x/runtime", Generation: "1.0.0"}
			if err := config.Save(path, c); err != nil {
				t.Fatal(err)
			}
			adoptPublicURL(path, tc.current, tc.announced)
			loaded, err := config.Load(path)
			if err != nil || loaded.URL != tc.want || loaded.Token != "secret" {
				t.Fatalf("stored config %+v: %v", loaded, err)
			}
			if info, _ := os.Stat(path); info.Mode().Perm() != 0600 {
				t.Fatal("config permissions changed")
			}
		})
	}
}

func TestMetricsAreReportedOnlyWhenTheCentralAsks(t *testing.T) {
	previous := minMetricsInterval
	minMetricsInterval = 10 * time.Millisecond
	defer func() { minMetricsInterval = previous }()
	for _, tc := range []struct {
		name    string
		welcome map[string]any
		want    bool
	}{
		{"accepted", map[string]any{"type": "welcome", "cursors": map[string]int64{}, "metrics": map[string]any{"intervalMs": 50}}, true},
		{"not requested", map[string]any{"type": "welcome", "cursors": map[string]int64{}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			capabilities := make(chan []string, 1)
			samples := make(chan map[string]any, 4)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer ws.Close()
				var hello struct{ Capabilities []string }
				if ws.ReadJSON(&hello) != nil {
					return
				}
				capabilities <- hello.Capabilities
				ws.WriteJSON(tc.welcome)
				for {
					var message struct {
						Type   string
						Sample map[string]any
					}
					if ws.ReadJSON(&message) != nil {
						return
					}
					if message.Type == "metrics" {
						samples <- message.Sample
					}
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				connect(ctx, config.Config{URL: server.URL, Token: "t", StateDir: t.TempDir()}, "", "test")
				close(done)
			}()
			defer func() { cancel(); <-done }()
			if got := <-capabilities; len(got) != 2 || got[0] != "metrics" || got[1] != "uninstall" {
				t.Fatalf("capabilities %v", got)
			}
			select {
			case sample := <-samples:
				if !tc.want {
					t.Fatalf("unrequested sample %v", sample)
				}
				if _, ok := sample["cpus"]; !ok {
					t.Fatalf("sample without cpus: %v", sample)
				}
			case <-time.After(500 * time.Millisecond):
				if tc.want {
					t.Fatal("no metrics sample")
				}
			}
		})
	}
}
