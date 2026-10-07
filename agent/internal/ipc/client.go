package ipc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"

	"hostherd/agent/internal/model"
	"hostherd/agent/internal/store"
)

func client(root, generation string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", store.SocketPath(root, generation))
	}, DisableKeepAlives: true}}
}
func Call(ctx context.Context, root, generation string, request model.Request) (any, error) {
	if err := store.ValidateGeneration(generation); err != nil {
		return nil, err
	}
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://runner/rpc", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := client(root, generation).Do(req)
	if err != nil {
		return nil, &model.RPCError{Code: "runtime_unavailable", Message: err.Error()}
	}
	defer response.Body.Close()
	var result model.Response
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.Error != nil {
		return nil, result.Error
	}
	return result.Result, nil
}
func Health(ctx context.Context, root, generation string) (map[string]any, error) {
	if err := store.ValidateGeneration(generation); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "http://runner/health", nil)
	if err != nil {
		return nil, err
	}
	response, err := client(root, generation).Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result["ok"] != true || result["protocol"] != float64(model.Protocol) {
		return nil, errors.New("incompatible runner protocol")
	}
	return result, nil
}
