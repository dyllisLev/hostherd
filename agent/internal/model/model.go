package model

import "encoding/json"

const Protocol = 1
const ChunkSize = 64 * 1024

type Job struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Path          string `json:"path"`
	Cmd           string `json:"cmd"`
	Status        string `json:"status"`
	StartedAt     string `json:"startedAt"`
	EndedAt       string `json:"endedAt,omitempty"`
	ExitCode      *int   `json:"exitCode,omitempty"`
	Signal        string `json:"signal,omitempty"`
	Error         string `json:"error,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
	PID           int    `json:"pid,omitempty"`
	Cols          uint16 `json:"cols,omitempty"`
	Rows          uint16 `json:"rows,omitempty"`
	RunnerVersion string `json:"runnerVersion"`
}

type Record struct {
	Job         Job    `json:"job"`
	Owner       string `json:"owner"`
	RequestHash string `json:"requestHash"`
}

type Request struct {
	Type   string          `json:"type,omitempty"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return e.Message }

type Response struct {
	Type   string    `json:"type,omitempty"`
	ID     string    `json:"id,omitempty"`
	Result any       `json:"result,omitempty"`
	Error  *RPCError `json:"error,omitempty"`
}

type StartParams struct {
	ID        string            `json:"id"`
	Path      string            `json:"path"`
	Cmd       string            `json:"cmd"`
	Env       map[string]string `json:"env,omitempty"`
	TimeoutMs int64             `json:"timeoutMs,omitempty"`
	Cols      uint16            `json:"cols,omitempty"`
	Rows      uint16            `json:"rows,omitempty"`
}
