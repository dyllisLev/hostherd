package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"hostherd/agent/internal/config"
	"hostherd/agent/internal/install"
	"hostherd/agent/internal/ipc"
	"hostherd/agent/internal/metrics"
	"hostherd/agent/internal/model"
	"hostherd/agent/internal/platform"
	"hostherd/agent/internal/spool"
	"hostherd/agent/internal/store"
)

func Run(ctx context.Context, configPath, version string) error {
	c, err := config.Load(configPath)
	if err != nil {
		return err
	}
	marker := filepath.Join(filepath.Dir(c.StateDir), "agent-ready.json")
	if err = os.Remove(marker); err != nil && !os.IsNotExist(err) {
		return err
	}
	readyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		_, err = ipc.Health(readyCtx, c.StateDir, c.Generation)
		if err == nil {
			break
		}
		select {
		case <-readyCtx.Done():
			return fmt.Errorf("active runner unavailable: %w", err)
		case <-time.After(200 * time.Millisecond):
		}
	}
	if err = store.AtomicJSON(marker, map[string]any{"pid": os.Getpid(), "version": version, "generation": c.Generation}); err != nil {
		return err
	}
	defer os.Remove(marker)
	go maintenance(ctx, c)
	delay := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err = connect(ctx, c, configPath, version)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			log.Printf("central connection unavailable: %v", err)
		}
		// A welcome may have persisted a new central URL for this connection.
		if fresh, loadErr := config.Load(configPath); loadErr == nil {
			c.URL = fresh.URL
		}
		if time.Since(started) > 30*time.Second {
			delay = time.Second
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		if delay < 15*time.Second {
			delay = min(delay*2, 15*time.Second)
		}
	}
	return nil
}

// normalizedURL returns scheme://host[/path] without trailing slash, query or
// fragment, or an error when the value is not an absolute HTTP(S) URL.
func normalizedURL(raw string) (*url.URL, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	if (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return nil, "", errors.New("not an absolute HTTP(S) URL")
	}
	return u, strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + strings.TrimRight(u.EscapedPath(), "/"), nil
}

// adoptPublicURL persists a central-announced URL so the next connection uses
// it. It is https only, except that an http deployment may announce http.
func adoptPublicURL(configPath, currentURL, announced string) error {
	current, currentNormal, err := normalizedURL(currentURL)
	if err != nil {
		return err
	}
	next, nextNormal, err := normalizedURL(announced)
	if err != nil {
		return err
	}
	if next.Scheme != "https" && current.Scheme != "http" {
		return errors.New("public URL must use https")
	}
	if nextNormal == currentNormal {
		return nil
	}
	stored, err := config.Load(configPath)
	if err != nil {
		return err
	}
	stored.URL = nextNormal
	if err = config.Save(configPath, stored); err != nil {
		return err
	}
	log.Printf("central URL changed from %s to %s; used from the next connection", currentNormal, nextNormal)
	return nil
}

func maintenance(ctx context.Context, c config.Config) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if c.InstallDir != "" {
				if err := install.CleanupRunners(cleanupCtx, c); err != nil && cleanupCtx.Err() == nil {
					log.Printf("runner cleanup: %v", err)
				}
			}
			cancel()
			if err := pruneCompleted(c.StateDir, time.Now()); err != nil {
				log.Printf("completed record cleanup: %v", err)
			}
		}
	}
}

// Retention removes command/result history only after every output byte has a
// durable central ACK. Small ID tombstones preserve dedup without retaining the
// expired command or output. Live jobs and terminals are never expired here.
func pruneCompleted(root string, now time.Time) error {
	lock, err := store.Lock(filepath.Join(root, "jobs.lock"), false)
	if err != nil {
		return err
	}
	defer store.Unlock(lock)
	// This process is root; the runner opens the same lock as the state owner.
	if err = platform.ShareFileWithStateOwner(lock, root); err != nil {
		return err
	}
	records, err := store.List(root)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.Job.Status == "running" || record.Job.EndedAt == "" {
			continue
		}
		ended, err := time.Parse(time.RFC3339Nano, record.Job.EndedAt)
		if err != nil || now.Sub(ended) < 30*24*time.Hour {
			continue
		}
		dir := store.JobDir(root, record.Job.ID)
		end, err := spool.Size(dir)
		if err != nil {
			return err
		}
		ack, err := spool.Acked(dir)
		if err != nil {
			return err
		}
		if ack < end {
			continue
		}
		tombstones := filepath.Join(root, "tombstones")
		if err = os.Mkdir(tombstones, 0755); err != nil && !os.IsExist(err) {
			return err
		}
		// The runner account owns the state directory; never write through a link it planted.
		if err = store.CheckDir(tombstones); err != nil {
			return err
		}
		// The runner must search this directory to reject expired job IDs.
		if err = platform.ShareDirWithStateOwner(tombstones, root); err != nil {
			return err
		}
		data, _ := json.Marshal(map[string]string{"id": record.Job.ID, "expiredAt": now.UTC().Format(time.RFC3339Nano)})
		if err = store.AtomicWrite(filepath.Join(tombstones, record.Job.ID+".json"), data, 0644); err != nil {
			return err
		}
		if err = os.RemoveAll(dir); err != nil {
			return err
		}
	}
	return nil
}

type streamState struct {
	cursor     int64
	pendingEnd int64
	sentAt     time.Time
	fault      string
}
type connection struct {
	ws         *websocket.Conn
	c          config.Config
	configPath string
	writeMu    sync.Mutex
	mu         sync.Mutex
	streams    map[string]*streamState
	sentStates map[string]string
	settled    map[string]bool
	wakeup     chan struct{}
	health     map[string]runnerHealth
}
type runnerHealth struct {
	checked time.Time
	misses  int
}

// One missed runner probe is not a fault. After a miss the next probe is due
// runnerProbeConfirm later; a second miss means the runner is down or still silent.
const (
	runnerProbeInterval = 5 * time.Second
	runnerProbeConfirm  = time.Second
	runnerProbeTimeout  = time.Second
)

func connect(ctx context.Context, c config.Config, configPath, version string) error {
	u, err := url.Parse(c.URL)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "ws", "wss":
	default:
		return errors.New("central URL must use HTTP(S)")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/agent"
	u.RawQuery = ""
	u.Fragment = ""
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.Token)
	ws, response, err := (&websocket.Dialer{HandshakeTimeout: 15 * time.Second}).DialContext(ctx, u.String(), header)
	if err != nil {
		if response != nil {
			return fmt.Errorf("central handshake HTTP %d", response.StatusCode)
		}
		return err
	}
	defer ws.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn := &connection{ws: ws, c: c, configPath: configPath, streams: map[string]*streamState{}, sentStates: map[string]string{}, settled: map[string]bool{}, wakeup: make(chan struct{}, 1), health: map[string]runnerHealth{}}
	go func() { <-ctx.Done(); ws.Close() }()
	ws.SetReadLimit(32 << 20)
	ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	hostname, _ := os.Hostname()
	if err = conn.send(map[string]any{"type": "hello", "protocol": model.Protocol, "version": version, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "user": c.ExecutionUser, "capabilities": []string{"metrics", "uninstall"}}); err != nil {
		return err
	}
	var welcome struct {
		Type      string           `json:"type"`
		Cursors   map[string]int64 `json:"cursors"`
		PublicURL string           `json:"publicUrl"`
		// Present only when the central accepts metrics reports.
		Metrics *struct {
			IntervalMs int64 `json:"intervalMs"`
		} `json:"metrics"`
	}
	if err = ws.ReadJSON(&welcome); err != nil {
		return err
	}
	if welcome.Type != "welcome" {
		return errors.New("central did not send protocol welcome")
	}
	for id, cursor := range welcome.Cursors {
		if store.ValidateID(id) != nil || cursor < 0 {
			return errors.New("invalid welcome cursor")
		}
		conn.streams[id] = &streamState{cursor: cursor}
	}
	if welcome.PublicURL != "" {
		if err := adoptPublicURL(configPath, c.URL, welcome.PublicURL); err != nil {
			log.Printf("central public URL ignored: %v", err)
		}
	}
	errorsCh := make(chan error, 1)
	if welcome.Metrics != nil && time.Duration(welcome.Metrics.IntervalMs)*time.Millisecond >= minMetricsInterval {
		go conn.reportMetrics(ctx, time.Duration(welcome.Metrics.IntervalMs)*time.Millisecond)
	}
	go func() {
		err := conn.pump(ctx)
		if err != nil {
			select {
			case errorsCh <- err:
			default:
			}
			ws.Close()
		}
	}()
	for {
		var raw json.RawMessage
		if err = ws.ReadJSON(&raw); err != nil {
			select {
			case pumpErr := <-errorsCh:
				return pumpErr
			default:
				return err
			}
		}
		ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		var message struct {
			Type   string `json:"type"`
			JobID  string `json:"jobId"`
			Offset int64  `json:"offset"`
		}
		if err = json.Unmarshal(raw, &message); err != nil {
			return err
		}
		switch message.Type {
		case "request":
			var request model.Request
			if err = json.Unmarshal(raw, &request); err != nil {
				return err
			}
			go conn.respond(ctx, request)
		case "ack":
			if err = conn.ack(message.JobID, message.Offset); err != nil {
				return err
			}
		}
	}
}

// minMetricsInterval bounds how often a central may ask for samples.
var minMetricsInterval = 5 * time.Second

// reportMetrics sends a resource sample each interval. A failed send ends the
// loop; the connection itself detects the broken socket.
func (c *connection) reportMetrics(ctx context.Context, interval time.Duration) {
	collector := metrics.New()
	collector.Collect(time.Now())
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if err := c.send(map[string]any{"type": "metrics", "at": now.UTC().Format(time.RFC3339), "sample": collector.Collect(now)}); err != nil {
				return
			}
		}
	}
}

func (c *connection) send(message any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return c.ws.WriteJSON(message)
}
func (c *connection) ack(id string, offset int64) error {
	if err := store.ValidateID(id); err != nil {
		return err
	}
	c.mu.Lock()
	defer func() {
		c.mu.Unlock()
		select {
		case c.wakeup <- struct{}{}:
		default:
		}
	}()
	s := c.streams[id]
	if s == nil || offset < s.cursor {
		return nil
	}
	if offset > s.pendingEnd && offset != s.cursor {
		return errors.New("unexpected output ACK offset")
	}
	// The central ACK is already durable even if local cleanup fails. Retain
	// its cursor so syncJobs retries cleanup without rereading deleted history.
	s.cursor = offset
	if offset >= s.pendingEnd {
		s.pendingEnd = 0
	}
	if err := spool.Ack(store.JobDir(c.c.StateDir, id), offset); err != nil {
		return c.outputFault(id, s, err)
	}
	return nil
}

// Called with c.mu held. A local spool failure must not disconnect unrelated
// jobs or RPCs. Retry from the centrally durable cursor; report each fault once.
func (c *connection) outputFault(id string, s *streamState, err error) error {
	message := id + ": " + err.Error()
	if s.fault == message {
		return nil
	}
	if err := c.send(map[string]any{"type": "fault", "message": message}); err != nil {
		return err
	}
	s.fault = message
	return nil
}

func (c *connection) pump(ctx context.Context) error {
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		if err := c.syncJobs(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		case <-c.wakeup:
		case <-ping.C:
			if err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				return err
			}
		}
	}
}

// syncJobs runs every pump tick. A finished job whose state was sent and whose
// output is fully ACKed and cleaned up is settled: later ticks skip it without
// reading its files. Each new connection starts unsettled to resend states.
func (c *connection) syncJobs() error {
	ids, err := store.ListIDs(c.c.StateDir)
	if err != nil {
		c.send(map[string]any{"type": "fault", "message": "read job inventory: " + err.Error()})
		return err
	}
	for _, id := range ids {
		if c.settled[id] {
			continue
		}
		record, err := store.ReadRecord(c.c.StateDir, id)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			c.send(map[string]any{"type": "fault", "message": "read job inventory: " + err.Error()})
			return err
		}
		job := record.Job
		if job.Status == "running" {
			health := c.health[record.Owner]
			interval := runnerProbeInterval
			if health.misses > 0 {
				interval = runnerProbeConfirm
			}
			if time.Since(health.checked) > interval {
				ctx, cancel := context.WithTimeout(context.Background(), runnerProbeTimeout)
				_, probeErr := ipc.Health(ctx, c.c.StateDir, record.Owner)
				cancel()
				health.checked = time.Now()
				if probeErr != nil {
					health.misses++
				} else {
					health.misses = 0
				}
				c.health[record.Owner] = health
			}
			if health.misses >= 2 {
				job.Error = "runner unavailable; execution state cannot be confirmed"
				job.ErrorCode = "RUNNER_UNAVAILABLE"
			}
		}
		b, _ := json.Marshal(job)
		if c.sentStates[job.ID] != string(b) {
			if err = c.send(map[string]any{"type": "state", "job": job}); err != nil {
				return err
			}
			c.sentStates[job.ID] = string(b)
			if isRuntimeFault(job) {
				if err = c.send(map[string]any{"type": "fault", "message": job.ID + ": " + job.Error}); err != nil {
					return err
				}
			}
		}
		c.mu.Lock()
		s := c.streams[job.ID]
		if s == nil {
			s = &streamState{}
			c.streams[job.ID] = s
		}
		if s.pendingEnd > s.cursor && time.Since(s.sentAt) < 10*time.Second {
			c.mu.Unlock()
			continue
		}
		dir := store.JobDir(c.c.StateDir, job.ID)
		// Welcome cursors are durable too; persist ACKs even if the prior socket
		// disconnected before its final ACK reached the agent.
		if err = spool.Ack(dir, s.cursor); err != nil {
			err = c.outputFault(job.ID, s, err)
			c.mu.Unlock()
			if err != nil {
				return err
			}
			continue
		}
		data, readErr := spool.Read(dir, s.cursor)
		if readErr != nil {
			err = c.outputFault(job.ID, s, readErr)
			c.mu.Unlock()
			if err != nil {
				return err
			}
			continue
		}
		s.fault = ""
		if len(data) == 0 {
			// A finished job's output no longer grows, so nothing remains.
			if job.Status != "running" {
				c.settled[job.ID] = true
			}
			c.mu.Unlock()
			continue
		}
		offset := s.cursor
		s.pendingEnd = offset + int64(len(data))
		s.sentAt = time.Now()
		c.mu.Unlock()
		if err = c.send(map[string]any{"type": "output", "jobId": job.ID, "offset": offset, "data": base64.StdEncoding.EncodeToString(data)}); err != nil {
			return err
		}
	}
	return nil
}
func isRuntimeFault(job model.Job) bool {
	if job.Error == "" {
		return false
	}
	switch job.ErrorCode {
	case "OUTPUT_STORAGE", "RUNNER_STOPPED", "RUNNER_UNAVAILABLE":
		return true
	}
	return false
}
func (c *connection) respond(ctx context.Context, request model.Request) {
	result, err := c.dispatch(ctx, request)
	response := model.Response{Type: "response", ID: request.ID, Result: result}
	if err != nil {
		response.Result = nil
		response.Error = &model.RPCError{Code: "operation_failed", Message: err.Error()}
		var rpcErr *model.RPCError
		if errors.As(err, &rpcErr) {
			response.Error = rpcErr
		}
	}
	if ctx.Err() == nil {
		if err = c.send(response); err != nil {
			c.ws.Close()
		}
	}
}
func (c *connection) dispatch(ctx context.Context, request model.Request) (any, error) {
	if request.Method == "agent.update" {
		var p struct {
			ManifestURL string `json:"manifestUrl"`
		}
		if err := json.Unmarshal(request.Params, &p); err != nil {
			return nil, err
		}
		if p.ManifestURL == "" {
			return nil, errors.New("manifestUrl is required")
		}
		if err := install.StartUpdate(c.configPath, p.ManifestURL); err != nil {
			return nil, err
		}
		return map[string]bool{"accepted": true}, nil
	}
	if request.Method == "agent.uninstall" {
		// An explicit removal request: the detached uninstaller ends running
		// work and deletes this installation after this reply is sent.
		if err := install.StartUninstall(c.configPath); err != nil {
			return nil, err
		}
		return map[string]bool{"accepted": true}, nil
	}
	generation := c.c.Generation
	if strings.HasPrefix(request.Method, "file.transfer.") && request.Method != "file.transfer.open" {
		var p struct {
			Generation string `json:"generation"`
		}
		if err := json.Unmarshal(request.Params, &p); err != nil {
			return nil, err
		}
		if err := store.ValidateGeneration(p.Generation); err != nil {
			return nil, err
		}
		generation = p.Generation
	}
	if request.Method != "job.start" && request.Method != "terminal.create" && request.Method != "job.list" && !strings.HasPrefix(request.Method, "file.") {
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(request.Params, &p); err != nil {
			return nil, err
		}
		record, err := store.ReadRecord(c.c.StateDir, p.ID)
		if err != nil {
			return nil, err
		}
		generation = record.Owner
		if request.Method == "job.status" {
			return record.Job, nil
		}
	}
	return ipc.Call(ctx, c.c.StateDir, generation, request)
}
