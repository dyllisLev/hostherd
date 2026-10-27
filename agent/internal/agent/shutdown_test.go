package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"hostherd/agent/internal/config"
)

func TestShutdownSendsCloseFrame(t *testing.T) {
	type closeResult struct {
		code int
		text string
	}
	closed := make(chan closeResult, 1)
	ready := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.SetCloseHandler(func(code int, text string) error {
			select {
			case closed <- closeResult{code, text}:
			default:
			}
			return nil
		})
		var hello map[string]any
		if err = ws.ReadJSON(&hello); err != nil || hello["type"] != "hello" {
			return
		}
		if err = ws.WriteJSON(map[string]any{"type": "welcome", "cursors": map[string]int64{}}); err != nil {
			return
		}
		close(ready)
		if _, _, err = ws.ReadMessage(); err != nil {
			select {
			case closed <- closeResult{websocket.CloseAbnormalClosure, err.Error()}:
			default:
			}
		}
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	cfg := config.Config{URL: server.URL, Token: "token", ExecutionUser: "root", StateDir: t.TempDir()}
	go func() { done <- connect(ctx, cfg, "", "0.1.3") }()

	select {
	case <-ready:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not finish hello")
	}
	cancel()
	select {
	case result := <-closed:
		if result.code != websocket.CloseGoingAway || result.text != "shutdown" {
			t.Fatalf("close code %d reason %q", result.code, result.text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not send a close frame")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("connect did not return after shutdown")
	}
}
