//go:build linux || darwin

package files

import (
	"encoding/json"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestSpecialFileRequestsDoNotWaitForFIFOPeer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fifo")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"file.read", "file.image", "file.write", "file.edit"} {
		t.Run(method, func(t *testing.T) {
			params := map[string]any{"path": path}
			switch method {
			case "file.write":
				params["data"] = "data"
			case "file.edit":
				params["oldText"], params["newText"] = "old", "new"
			}
			raw, err := json.Marshal(params)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := Handle(method, raw)
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("special file should return an error")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("RPC blocked waiting for a FIFO peer")
			}
		})
	}
	result := call(t, "file.search", map[string]any{"path": filepath.Dir(path), "query": "needle"}).(SearchResult)
	if len(result.Matches) != 0 || !result.EOF {
		t.Fatalf("search did not skip FIFO: %#v", result)
	}
}
