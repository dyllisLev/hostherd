package files

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"hostherd/agent/internal/model"
	"hostherd/agent/internal/store"
)

const TransferChunkBytes = 512 * 1024
const transferIdleTimeout = 15 * time.Minute

type TransferState struct {
	ID         string `json:"id"`
	Generation string `json:"generation"`
	Direction  string `json:"direction"`
	Status     string `json:"status"`
	Size       int64  `json:"size"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256,omitempty"`
}

type fileTransfer struct {
	mu        sync.Mutex
	state     TransferState
	path      string
	temporary string
	overwrite bool
	file      *os.File
	original  os.FileInfo
	digest    hash.Hash
	touched   time.Time
}

// Transfers keeps descriptors in the execution process, so reconnecting the
// communication agent does not invalidate an in-progress file transfer.
type Transfers struct {
	mu         sync.Mutex
	sessions   map[string]*fileTransfer
	active     atomic.Int64
	markers    string
	generation string
}

func NewTransfers(root, generation string) (*Transfers, error) {
	markers := filepath.Join(root, "file-transfers", generation)
	if err := os.MkdirAll(markers, 0700); err != nil {
		return nil, err
	}
	// A restarted runner cannot reuse the preceding process's descriptors.
	// Remove only upload temporary files recorded by that same generation.
	entries, err := os.ReadDir(markers)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		marker := filepath.Join(markers, entry.Name())
		data, err := os.ReadFile(marker)
		if err != nil {
			return nil, err
		}
		var pending struct{ Temporary string }
		if err := json.Unmarshal(data, &pending); err != nil {
			return nil, err
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if store.ValidateID(id) != nil || !filepath.IsAbs(pending.Temporary) || !hasUploadPrefix(filepath.Base(pending.Temporary), id) {
			return nil, errors.New("invalid file transfer cleanup record")
		}
		if err := os.Remove(pending.Temporary); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if err := os.Remove(marker); err != nil {
			return nil, err
		}
	}
	return &Transfers{sessions: map[string]*fileTransfer{}, markers: markers, generation: generation}, nil
}

func hasUploadPrefix(name, id string) bool {
	return strings.HasPrefix(name, ".hostherd-upload-"+id+"-")
}

func transferError(code, message string) error {
	return &model.RPCError{Code: code, Message: message}
}

func transferFileError(err error) error {
	if os.IsNotExist(err) {
		return transferError("FILE_NOT_FOUND", "File or parent directory does not exist. Use the absolute file path on the selected server.")
	}
	if os.IsPermission(err) {
		return transferError("FILE_PERMISSION_DENIED", "The registered execution account cannot access this file or its parent directory.")
	}
	if os.IsExist(err) {
		return transferError("FILE_EXISTS", "The destination already exists. Choose another path, or explicitly request overwrite=true.")
	}
	return transferError("FILE_IO_ERROR", err.Error())
}

// checkDestination returns the file an overwrite replaces, or nil.
func checkDestination(path string, overwrite bool) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, transferFileError(err)
	}
	if !overwrite {
		return nil, transferError("FILE_EXISTS", "The destination already exists. Choose another path, or explicitly request overwrite=true.")
	}
	if !info.Mode().IsRegular() {
		return nil, transferError("INVALID_FILE_PATH", "Upload destination must be a regular file, not a directory, symlink or special file.")
	}
	// Atomic replacement also requires permission to write the existing file.
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return nil, transferFileError(err)
	}
	return info, f.Close()
}

// createUpload creates the temporary upload with the mode a new file gets
// (0666 less the umask) instead of CreateTemp's 0600.
func createUpload(dir, prefix string) (*os.File, error) {
	for {
		f, err := os.OpenFile(filepath.Join(dir, prefix+strconv.FormatUint(rand.Uint64(), 36)), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0666)
		if !os.IsExist(err) {
			return f, err
		}
	}
}

func (m *Transfers) open(raw json.RawMessage) (any, error) {
	var p struct {
		ID        string `json:"id"`
		Direction string `json:"direction"`
		Path      string `json:"path"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if store.ValidateID(p.ID) != nil || validatePath(p.Path) != nil || (p.Direction != "upload" && p.Direction != "download") {
		return nil, transferError("INVALID_TRANSFER", "Use a valid transfer ID, direction and absolute target file path.")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing := m.sessions[p.ID]; existing != nil {
		existing.mu.Lock()
		defer existing.mu.Unlock()
		if existing.path != p.Path || existing.overwrite != p.Overwrite || existing.state.Direction != p.Direction {
			return nil, transferError("TRANSFER_CONFLICT", "Transfer ID was already used with different arguments.")
		}
		return existing.state, nil
	}
	t := &fileTransfer{path: p.Path, overwrite: p.Overwrite, touched: time.Now(), digest: sha256.New(),
		state: TransferState{ID: p.ID, Generation: m.generation, Direction: p.Direction, Status: "running"}}
	if p.Direction == "upload" {
		if _, err := checkDestination(p.Path, p.Overwrite); err != nil {
			return nil, err
		}
		f, err := createUpload(filepath.Dir(p.Path), ".hostherd-upload-"+p.ID+"-")
		if err != nil {
			return nil, transferFileError(err)
		}
		t.file, t.temporary = f, f.Name()
		if err := store.AtomicJSON(filepath.Join(m.markers, p.ID+".json"), struct{ Temporary string }{t.temporary}); err != nil {
			f.Close()
			os.Remove(t.temporary)
			return nil, transferFileError(err)
		}
	} else {
		if err := requireRegularPath(p.Path); err != nil {
			return nil, transferFileError(err)
		}
		f, err := os.Open(p.Path)
		if err != nil {
			return nil, transferFileError(err)
		}
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			f.Close()
			return nil, transferError("INVALID_FILE_PATH", "Download source must be a readable regular file.")
		}
		t.file, t.original, t.state.Size = f, info, info.Size()
	}
	m.sessions[p.ID] = t
	m.active.Add(1)
	return t.state, nil
}

func (m *Transfers) Handle(method string, raw json.RawMessage) (any, error) {
	if method == "file.transfer.open" {
		return m.open(raw)
	}
	var p struct {
		ID         string `json:"id"`
		Generation string `json:"generation"`
		Offset     int64  `json:"offset"`
		Data       string `json:"data"`
		Size       int64  `json:"size"`
		SHA256     string `json:"sha256"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if p.Generation != m.generation {
		return nil, transferError("TRANSFER_NOT_FOUND", "Transfer belongs to another execution generation.")
	}
	m.mu.Lock()
	t := m.sessions[p.ID]
	m.mu.Unlock()
	if t == nil {
		return nil, transferError("TRANSFER_NOT_FOUND", "Transfer expired or its runner restarted. Start a new transfer; do not reuse an expired ID.")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.touched = time.Now()
	if method == "file.transfer.status" {
		return t.state, nil
	}
	if method == "file.transfer.abort" {
		m.finish(t, "cancelled")
		return t.state, nil
	}
	if method == "file.transfer.commit" && t.state.Status == "completed" {
		if p.Size != t.state.Size || p.SHA256 != t.state.SHA256 {
			return nil, transferError("TRANSFER_CONFLICT", "Committed size or checksum differs from this retry.")
		}
		return t.state, nil
	}
	if t.state.Status != "running" {
		return nil, transferError("TRANSFER_CLOSED", "Transfer is no longer running. Inspect its status or start a new transfer.")
	}
	switch method {
	case "file.transfer.write":
		if t.state.Direction != "upload" || p.Offset < 0 || len(p.Data) > base64.StdEncoding.EncodedLen(TransferChunkBytes) {
			return nil, transferError("INVALID_TRANSFER_CHUNK", "Upload chunks must be at most 512 KiB with a nonnegative byte offset.")
		}
		data, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil || len(data) == 0 || len(data) > TransferChunkBytes {
			return nil, transferError("INVALID_TRANSFER_CHUNK", "Provide a nonempty valid base64 chunk of at most 512 KiB.")
		}
		if p.Offset != t.state.Bytes {
			if p.Offset < t.state.Bytes && int64(len(data)) <= t.state.Bytes-p.Offset {
				previous := make([]byte, len(data))
				if _, err := t.file.ReadAt(previous, p.Offset); err == nil && bytes.Equal(previous, data) {
					return t.state, nil // An identical retry cannot duplicate bytes.
				}
			}
			return nil, transferError("TRANSFER_OFFSET", "Chunk offset does not match the accepted bytes. Query transfer status before retrying.")
		}
		n, err := t.file.Write(data)
		if err != nil || n != len(data) {
			m.finish(t, "failed")
			if err == nil {
				err = io.ErrShortWrite
			}
			return nil, transferFileError(err)
		}
		t.digest.Write(data)
		t.state.Bytes += int64(n)
		return t.state, nil
	case "file.transfer.read":
		if t.state.Direction != "download" || p.Offset < 0 || p.Offset > t.state.Size {
			return nil, transferError("INVALID_TRANSFER_CHUNK", "Use a valid download byte offset.")
		}
		info, err := t.file.Stat()
		if err != nil {
			return nil, transferFileError(err)
		}
		if info.Size() != t.original.Size() || !info.ModTime().Equal(t.original.ModTime()) {
			return nil, transferError("FILE_CHANGED", "Source file changed during transfer. Wait until writing finishes, then request a new download.")
		}
		buf := make([]byte, min(int64(TransferChunkBytes), t.state.Size-p.Offset))
		n, err := t.file.ReadAt(buf, p.Offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, transferFileError(err)
		}
		info, err = t.file.Stat()
		if err != nil || n != len(buf) || info.Size() != t.original.Size() || !info.ModTime().Equal(t.original.ModTime()) {
			return nil, transferError("FILE_CHANGED", "Source file changed during transfer. Wait until writing finishes, then request a new download.")
		}
		next := p.Offset + int64(n)
		t.state.Bytes = max(t.state.Bytes, next)
		return map[string]any{"data": base64.StdEncoding.EncodeToString(buf[:n]), "nextOffset": next, "eof": next == t.state.Size}, nil
	case "file.transfer.commit":
		if t.state.Direction != "upload" || p.Size != t.state.Bytes || p.SHA256 != hex.EncodeToString(t.digest.Sum(nil)) {
			m.finish(t, "failed")
			return nil, transferError("CHECKSUM_MISMATCH", "Uploaded size or SHA-256 does not match. Destination was not replaced.")
		}
		if err := t.file.Sync(); err != nil {
			m.finish(t, "failed")
			return nil, transferFileError(err)
		}
		replaced, err := checkDestination(t.path, t.overwrite)
		if err != nil {
			m.finish(t, "failed")
			return nil, err
		}
		if replaced != nil {
			// The new content keeps the replaced file's mode and, if possible, owner.
			if err = t.file.Chmod(replaced.Mode().Perm()); err == nil {
				err = keepOwner(t.file, replaced)
			}
			if err != nil {
				m.finish(t, "failed")
				return nil, transferFileError(err)
			}
		}
		if t.overwrite {
			err = os.Rename(t.temporary, t.path)
		} else {
			// link is atomic and fails if a destination appeared during upload.
			err = os.Link(t.temporary, t.path)
		}
		if err != nil {
			m.finish(t, "failed")
			return nil, transferFileError(err)
		}
		t.state.Size, t.state.SHA256 = p.Size, p.SHA256
		m.finish(t, "completed")
		return t.state, nil
	default:
		return nil, transferError("INVALID_TRANSFER", "Unknown file transfer operation.")
	}
}

// Caller holds the session lock. Completed uploads cannot be undone by abort.
func (m *Transfers) finish(t *fileTransfer, status string) {
	if t.state.Status != "running" {
		return
	}
	if t.file != nil {
		t.file.Close()
		t.file = nil
	}
	if t.temporary != "" {
		if err := os.Remove(t.temporary); err == nil || os.IsNotExist(err) {
			os.Remove(filepath.Join(m.markers, t.state.ID+".json"))
		}
	}
	t.state.Status = status
	m.active.Add(-1)
}

func (m *Transfers) Active() int64 { return m.active.Load() }

func (m *Transfers) Prune(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, t := range m.sessions {
		t.mu.Lock()
		if now.Sub(t.touched) >= transferIdleTimeout && t.state.Status == "running" {
			m.finish(t, "expired")
		}
		if now.Sub(t.touched) >= time.Hour {
			delete(m.sessions, id)
		}
		t.mu.Unlock()
	}
}

func (m *Transfers) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.sessions {
		t.mu.Lock()
		m.finish(t, "interrupted")
		t.mu.Unlock()
	}
}
