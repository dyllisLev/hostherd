package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"hostherd/agent/internal/files"
	"hostherd/agent/internal/install"
	"hostherd/agent/internal/model"
	"hostherd/agent/internal/platform"
	"hostherd/agent/internal/spool"
	"hostherd/agent/internal/store"
)

type execution struct {
	record  model.Record
	proc    platform.Process
	input   io.WriteCloser
	pty     platform.PTY
	done    chan struct{}
	inputMu sync.Mutex
	stopped bool
}
type Runner struct {
	root, generation, version string
	mu                        sync.Mutex
	active                    map[string]*execution
	activeCount               atomic.Int64
	lock                      *os.File
	transfers                 *files.Transfers
}

func New(root, generation, version string) (*Runner, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("state directory must be absolute")
	}
	if err := store.ValidateGeneration(generation); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "jobs"), 0700); err != nil {
		return nil, err
	}
	dir := filepath.Dir(store.SocketPath(root, generation))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	lock, err := store.Lock(filepath.Join(dir, "runner.lock"), true)
	if err != nil {
		return nil, fmt.Errorf("runner already active or unavailable: %w", err)
	}
	r := &Runner{root: root, generation: generation, version: version, active: map[string]*execution{}, lock: lock}
	// A new owner of this lock means the preceding runner is gone. Never restart
	// arbitrary commands on recovery; preserve their ID and explicit failure.
	records, err := store.List(root)
	if err != nil {
		store.Unlock(lock)
		return nil, err
	}
	for _, record := range records {
		if record.Owner == generation && record.Job.Status == "running" {
			record.Job.Status = "interrupted"
			record.Job.Error = "runner stopped; process continuity cannot be guaranteed"
			record.Job.ErrorCode = "RUNNER_STOPPED"
			record.Job.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
			if err = store.WriteRecord(root, record); err != nil {
				store.Unlock(lock)
				return nil, err
			}
		}
	}
	r.transfers, err = files.NewTransfers(root, generation)
	if err != nil {
		store.Unlock(lock)
		return nil, err
	}
	return r, nil
}

func (r *Runner) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer store.Unlock(r.lock)
	defer r.transfers.Close()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				r.transfers.Prune(now)
			}
		}
	}()
	socket := store.SocketPath(r.root, r.generation)
	if err := os.Remove(socket); err != nil && !os.IsNotExist(err) {
		return err
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer os.Remove(socket)
	if err = platform.SecureSocket(socket); err != nil {
		l.Close()
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, req *http.Request) {
		// Job persistence holds mu during fsync. Liveness must not wait for it.
		active := r.activeCount.Load() + r.transfers.Active()
		writeJSON(w, map[string]any{"ok": true, "protocol": model.Protocol, "version": r.version, "generation": r.generation, "active": active})
	})
	mux.HandleFunc("/rpc", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var request model.Request
		if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 32<<20)).Decode(&request); err != nil {
			writeJSON(w, model.Response{Error: &model.RPCError{Code: "invalid_request", Message: err.Error()}})
			return
		}
		result, err := r.Handle(request.Method, request.Params)
		response := model.Response{ID: request.ID, Result: result}
		if err != nil {
			response.Error = &model.RPCError{Code: "operation_failed", Message: err.Error()}
			var rpcErr *model.RPCError
			if errors.As(err, &rpcErr) {
				response.Error = rpcErr
			}
		}
		writeJSON(w, response)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { <-ctx.Done(); server.Close() }()
	err = server.Serve(l)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (r *Runner) Start(p model.StartParams, kind string) (model.Job, error) {
	if err := store.ValidateID(p.ID); err != nil {
		return model.Job{}, err
	}
	if !filepath.IsAbs(p.Path) {
		return model.Job{}, invalidWorkingDirectory(p.Path, "use an absolute directory path")
	}
	if p.TimeoutMs < 0 {
		return model.Job{}, errors.New("timeoutMs must be nonnegative")
	}
	if kind == "job" && strings.TrimSpace(p.Cmd) == "" {
		return model.Job{}, errors.New("cmd must not be empty")
	}
	for key, value := range p.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return model.Job{}, errors.New("invalid environment entry")
		}
	}
	if p.Cols == 0 {
		p.Cols = 120
	}
	if p.Rows == 0 {
		p.Rows = 30
	}
	hashInput, _ := json.Marshal(struct {
		Kind   string
		Params model.StartParams
	}{kind, p})
	digest := sha256.Sum256(hashInput)
	hash := hex.EncodeToString(digest[:])
	lock, err := store.Lock(filepath.Join(r.root, "jobs.lock"), false)
	if err != nil {
		return model.Job{}, err
	}
	defer store.Unlock(lock)
	previous, err := store.ReadRecord(r.root, p.ID)
	if err == nil {
		if previous.RequestHash != hash {
			return model.Job{}, &model.RPCError{Code: "id_conflict", Message: "job ID was already used with different inputs"}
		}
		return previous.Job, nil
	}
	if !os.IsNotExist(err) {
		return model.Job{}, err
	}
	if _, err = os.Stat(filepath.Join(r.root, "tombstones", p.ID+".json")); err == nil {
		return model.Job{}, &model.RPCError{Code: "job_expired", Message: "job ID belongs to expired history and cannot be executed again"}
	} else if !os.IsNotExist(err) {
		return model.Job{}, err
	}
	// Validate locally within this start RPC, after deduplication. Replaying an
	// accepted job must still work if its original working directory was removed.
	info, err := os.Stat(p.Path)
	if err != nil {
		return model.Job{}, invalidWorkingDirectory(p.Path, err.Error())
	}
	if !info.IsDir() {
		return model.Job{}, invalidWorkingDirectory(p.Path, "the path is a file, not a directory")
	}
	if err = platform.CheckDirectory(p.Path); err != nil { // Permission to enter it as the runner account.
		return model.Job{}, invalidWorkingDirectory(p.Path, err.Error())
	}
	dir := store.JobDir(r.root, p.ID)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return model.Job{}, err
	}
	record := model.Record{Owner: r.generation, RequestHash: hash, Job: model.Job{ID: p.ID, Kind: kind, Path: p.Path, Cmd: p.Cmd, Status: "running", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), RunnerVersion: r.version}}
	if kind == "terminal" {
		record.Job.Cmd = platform.LoginShell()
		record.Job.Cols = p.Cols
		record.Job.Rows = p.Rows
	}
	if err = store.WriteRecord(r.root, record); err != nil {
		return model.Job{}, err
	}
	writer, err := spool.NewWriter(dir)
	if err != nil {
		return r.failStart(record, &model.RPCError{Code: "OUTPUT_STORAGE", Message: err.Error()})
	}
	cmd := platform.Command(p, kind == "terminal")
	e := &execution{record: record, done: make(chan struct{})}
	var output io.ReadCloser
	if kind == "terminal" {
		e.pty, e.proc, err = platform.StartPTY(cmd, p.Cols, p.Rows)
		if err != nil {
			writer.Close()
			return r.failStart(record, err)
		}
		e.input = e.pty
		output = e.pty
	} else {
		inputRead, inputWrite, pipeErr := os.Pipe()
		if pipeErr != nil {
			writer.Close()
			return r.failStart(record, pipeErr)
		}
		outputRead, outputWrite, pipeErr := os.Pipe()
		if pipeErr != nil {
			inputRead.Close()
			inputWrite.Close()
			writer.Close()
			return r.failStart(record, pipeErr)
		}
		cmd.Stdin = inputRead
		cmd.Stdout = outputWrite
		cmd.Stderr = outputWrite
		err = cmd.Start()
		inputRead.Close()
		outputWrite.Close()
		if err != nil {
			inputWrite.Close()
			outputRead.Close()
			writer.Close()
			return r.failStart(record, err)
		}
		e.input = inputWrite
		output = outputRead
		e.proc = platform.Started(cmd)
	}
	e.record.Job.PID = e.proc.Pid()
	r.mu.Lock()
	r.active[p.ID] = e
	r.activeCount.Add(1)
	err = store.WriteRecord(r.root, e.record)
	job := e.record.Job
	r.mu.Unlock()
	if err != nil {
		r.storageFault(e, err)
	}
	captured := make(chan struct{})
	go func() {
		defer close(captured)
		if errors.Is(r.capture(e, output, writer), os.ErrDeadlineExceeded) {
			// Children left running still hold the output. Keep draining so
			// their writes do not fail; it is no longer recorded.
			output.(deadliner).SetReadDeadline(time.Time{})
			go func() { io.Copy(io.Discard, output); output.Close() }()
		} else {
			output.Close()
		}
		if err := writer.Close(); err != nil {
			r.storageFault(e, err)
		}
	}()
	go r.wait(e, output, captured)
	if p.TimeoutMs > 0 {
		go func() {
			timer := time.NewTimer(time.Duration(p.TimeoutMs) * time.Millisecond)
			defer timer.Stop()
			select {
			case <-timer.C:
				r.Cancel(p.ID)
			case <-e.done:
			}
		}()
	}
	return job, nil
}
func invalidWorkingDirectory(path, reason string) error {
	return &model.RPCError{Code: "INVALID_WORKDIR", Message: fmt.Sprintf("Invalid working directory path=%q: %s. Set path to an existing, accessible directory on the target server (for example / or /tmp), not a shell executable. The command was not started.", path, reason)}
}
func (r *Runner) failStart(record model.Record, cause error) (model.Job, error) {
	record.Job.Status = "failed"
	record.Job.Error = cause.Error()
	record.Job.ErrorCode = "START_FAILED"
	var rpcErr *model.RPCError
	if errors.As(cause, &rpcErr) {
		record.Job.ErrorCode = rpcErr.Code
	}
	record.Job.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
	exit := 127
	record.Job.ExitCode = &exit
	if err := store.WriteRecord(r.root, record); err != nil {
		return model.Job{}, err
	}
	return record.Job, nil
}

// capture returns the read error that ended it.
func (r *Runner) capture(e *execution, output io.Reader, writer *spool.Writer) error {
	b := make([]byte, model.ChunkSize)
	for {
		n, readErr := output.Read(b)
		pending := b[:n]
		for len(pending) > 0 {
			written, err := writer.Write(pending)
			pending = pending[written:]
			if err != nil {
				r.storageFault(e, err)
				time.Sleep(time.Second)
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, syscall.EIO) && !errors.Is(readErr, os.ErrClosed) && !errors.Is(readErr, os.ErrDeadlineExceeded) {
				r.storageFault(e, readErr)
			}
			return readErr
		}
	}
}
func (r *Runner) storageFault(e *execution, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e.record.Job.Error = "output storage/runtime fault: " + err.Error()
	e.record.Job.ErrorCode = "OUTPUT_STORAGE"
	store.WriteRecord(r.root, e.record)
}

type deadliner interface{ SetReadDeadline(time.Time) error }

// outputGrace is how long output may stay open after the process exits, for
// example held by a background child that inherited it.
const outputGrace = 2 * time.Second

func (r *Runner) wait(e *execution, output io.Closer, captured <-chan struct{}) {
	err := e.proc.Wait()
	select {
	case <-captured:
	case <-time.After(outputGrace):
		// Record what is already buffered, then finish the job.
		if d, ok := output.(deadliner); !ok || d.SetReadDeadline(time.Now().Add(200*time.Millisecond)) != nil {
			output.Close()
		}
		<-captured
	}
	e.inputMu.Lock()
	if e.input != nil {
		e.input.Close()
		e.input = nil
	}
	e.inputMu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	job := &e.record.Job
	job.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
	code := 0
	job.Status = "completed"
	if err != nil {
		job.Status = "failed"
		var exited interface{ ExitCode() int }
		if errors.As(err, &exited) {
			code = exited.ExitCode()
			job.Signal = platform.ExitSignal(err)
		} else {
			code = -1
			job.Error = err.Error()
		}
	}
	if e.stopped {
		job.Status = "interrupted"
	}
	job.ExitCode = &code
	if err = store.WriteRecord(r.root, e.record); err != nil {
		fmt.Fprintf(os.Stderr, "persist completion %s: %v\n", job.ID, err)
	}
	delete(r.active, job.ID)
	r.activeCount.Add(-1)
	close(e.done)
}
func (r *Runner) getActive(id string) (*execution, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.active[id]
	if e == nil {
		return nil, errors.New("job is not active in this runner")
	}
	return e, nil
}
func (r *Runner) Input(id, data string, eof bool) error {
	e, err := r.getActive(id)
	if err != nil {
		return err
	}
	e.inputMu.Lock()
	defer e.inputMu.Unlock()
	if e.input == nil {
		return errors.New("stdin is closed")
	}
	if data != "" {
		if _, err = io.WriteString(e.input, data); err != nil {
			return err
		}
	}
	if eof {
		if e.pty != nil {
			return errors.New("terminal EOF is sent as a control character")
		}
		err = e.input.Close()
		e.input = nil
		return err
	}
	return nil
}
func (r *Runner) Cancel(id string) error {
	e, err := r.getActive(id)
	if err != nil {
		if record, readErr := store.ReadRecord(r.root, id); readErr == nil && record.Job.Status != "running" {
			return nil
		}
		return err
	}
	r.mu.Lock()
	e.stopped = true
	pid := e.record.Job.PID
	r.mu.Unlock()
	err = platform.Terminate(pid, false)
	go func() {
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		select {
		case <-e.done:
			return
		case <-timer.C:
			platform.Terminate(pid, true)
		}
	}()
	return err
}
func (r *Runner) Resize(id string, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return errors.New("terminal dimensions must be positive")
	}
	e, err := r.getActive(id)
	if err != nil {
		return err
	}
	if e.pty == nil {
		return errors.New("job is not a terminal")
	}
	if err = e.pty.Resize(cols, rows); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	e.record.Job.Cols = cols
	e.record.Job.Rows = rows
	return store.WriteRecord(r.root, e.record)
}
func (r *Runner) Handle(method string, raw json.RawMessage) (any, error) {
	if strings.HasPrefix(method, "file.transfer.") {
		return r.transfers.Handle(method, raw)
	}
	if strings.HasPrefix(method, "file.") {
		return files.Handle(method, raw)
	}
	if method == "job.list" {
		records, err := store.List(r.root)
		if err != nil {
			return nil, err
		}
		jobs := make([]model.Job, 0, len(records))
		for _, record := range records {
			jobs = append(jobs, record.Job)
		}
		return jobs, nil
	}
	if method == "runner.register" {
		// Windows updater, user account: register the next generation's task
		// as this account, which SYSTEM is not allowed to do.
		var p struct {
			Generation string `json:"generation"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := install.RegisterOwnRunner(ctx, r.root, p.Generation); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
	if method == "job.start" || method == "terminal.create" {
		var p model.StartParams
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		kind := "job"
		if method == "terminal.create" {
			kind = "terminal"
		}
		return r.Start(p, kind)
	}
	var p struct {
		ID   string `json:"id"`
		Data string `json:"data"`
		EOF  bool   `json:"eof"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if err := store.ValidateID(p.ID); err != nil {
		return nil, err
	}
	var err error
	switch method {
	case "job.status":
		record, err := store.ReadRecord(r.root, p.ID)
		return record.Job, err
	case "job.input", "terminal.input":
		err = r.Input(p.ID, p.Data, p.EOF)
	case "job.cancel", "terminal.close":
		err = r.Cancel(p.ID)
	case "terminal.resize":
		err = r.Resize(p.ID, p.Cols, p.Rows)
	default:
		return nil, &model.RPCError{Code: "unknown_method", Message: "unknown runner method"}
	}
	return map[string]bool{"ok": true}, err
}
