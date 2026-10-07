package install

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"hostherd/agent/internal/config"
)

type runnerHealth struct {
	OK       bool   `json:"ok"`
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	Active   *int   `json:"active"`
}

func readRunnerHealth(ctx context.Context, stateDir, generation string) (runnerHealth, error) {
	var state runnerHealth
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(stateDir, "runners", generation, "runner.sock"))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/health", nil)
	resp, err := client.Do(req)
	if err != nil {
		return state, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return state, fmt.Errorf("runner health: HTTP %d", resp.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&state)
	return state, err
}

func waitRunner(ctx context.Context, c config.Config) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return poll(ctx, func() error {
		state, err := readRunnerHealth(ctx, c.StateDir, c.Generation)
		if err != nil {
			return err
		}
		if !state.OK || state.Protocol != 1 || state.Version != c.Version {
			return fmt.Errorf("runner health/version mismatch")
		}
		return nil
	})
}

func poll(ctx context.Context, check func() error) error {
	var last error
	for {
		if last = check(); last == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("startup readiness: %w (last check: %v)", ctx.Err(), last)
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// download fetches a bounded HTTPS response body.
func download(ctx context.Context, client *http.Client, rawURL string, max int64) ([]byte, error) {
	if err := validateHTTPS(rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release metadata download: HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("release metadata too large")
	}
	return b, nil
}

// Options are install-time choices. System runs commands as Windows SYSTEM; on
// Linux and macOS the execution account comes from sudo instead.
type Options struct{ System bool }
