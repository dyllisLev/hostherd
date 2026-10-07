package install

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"hostherd/agent/internal/ipc"
	"hostherd/agent/internal/model"
	"hostherd/agent/internal/store"
)

// replyDelay lets the communication agent send its accepted reply before the
// uninstaller stops it. Tests shorten it.
var replyDelay = 2 * time.Second

// stopRunningWork ends running jobs and terminals through their runners before
// the services stop: a launchd runner abandons its process group and ending a
// Windows task does not reach its descendants. Removal continues regardless.
func stopRunningWork(ctx context.Context, stateDir string) {
	ids, err := store.ListIDs(stateDir)
	if err != nil {
		log.Printf("list jobs: %v", err)
		return
	}
	var stopping []string
	for _, id := range ids {
		record, err := store.ReadRecord(stateDir, id)
		if err != nil || record.Job.Status != "running" {
			continue
		}
		method := "job.cancel"
		if record.Job.Kind == "terminal" {
			method = "terminal.close"
		}
		params, _ := json.Marshal(map[string]string{"id": id})
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err = ipc.Call(callCtx, stateDir, record.Owner, model.Request{Type: "request", ID: id, Method: method, Params: params})
		cancel()
		if err != nil {
			log.Printf("stop %s %s: %v", record.Job.Kind, id, err)
			continue
		}
		stopping = append(stopping, id)
	}
	// A runner forces termination 3 seconds after its first attempt.
	deadline := time.Now().Add(6 * time.Second)
	for len(stopping) > 0 && time.Now().Before(deadline) && ctx.Err() == nil {
		time.Sleep(250 * time.Millisecond)
		remaining := stopping[:0]
		for _, id := range stopping {
			if record, err := store.ReadRecord(stateDir, id); err == nil && record.Job.Status == "running" {
				remaining = append(remaining, id)
			}
		}
		stopping = remaining
	}
}

func waitReply(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(replyDelay):
		return nil
	}
}
