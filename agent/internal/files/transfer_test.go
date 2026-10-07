package files

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"hostherd/agent/internal/model"
)

func transferCall(t *testing.T, m *Transfers, method string, params map[string]any) any {
	t.Helper()
	if method != "open" {
		params["generation"] = "1.0.0"
	}
	raw, _ := json.Marshal(params)
	result, err := m.Handle("file.transfer."+method, raw)
	if err != nil {
		t.Fatal(method, err)
	}
	return result
}

func transferFails(t *testing.T, m *Transfers, method string, params map[string]any, code string) {
	t.Helper()
	if method != "open" {
		params["generation"] = "1.0.0"
	}
	raw, _ := json.Marshal(params)
	_, err := m.Handle("file.transfer."+method, raw)
	var rpcError *model.RPCError
	if !errors.As(err, &rpcError) || rpcError.Code != code {
		t.Fatalf("%s expected %s, got %v", method, code, err)
	}
}

func transferManager(t *testing.T) (*Transfers, string) {
	t.Helper()
	root := t.TempDir()
	m, err := NewTransfers(filepath.Join(root, "runtime"), "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m, root
}

func TestTransferUploadAtomicBytesChecksumAndRetries(t *testing.T) {
	m, root := transferManager(t)
	id := "c401c370-03e5-4f2c-96be-012345678901"
	path := filepath.Join(root, "uploaded.bin")
	data := bytes.Repeat([]byte{0, 1, 255, 128, 42, 10, 13}, 220_000)
	opened := transferCall(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path}).(TransferState)
	if opened.Generation != "1.0.0" || m.Active() != 1 {
		t.Fatal("descriptor must belong to and keep its runner alive", opened)
	}
	for offset := 0; offset < len(data); {
		end := min(offset+TransferChunkBytes, len(data))
		params := map[string]any{"id": id, "offset": offset, "data": base64.StdEncoding.EncodeToString(data[offset:end])}
		accepted := transferCall(t, m, "write", params).(TransferState)
		retried := transferCall(t, m, "write", params).(TransferState)
		if accepted.Bytes != int64(end) || retried.Bytes != accepted.Bytes {
			t.Fatal("identical chunk retry duplicated or lost bytes")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("incomplete upload must not be visible at destination")
		}
		offset = end
	}
	digest := sha256.Sum256(data)
	params := map[string]any{"id": id, "size": len(data), "sha256": hex.EncodeToString(digest[:])}
	committed := transferCall(t, m, "commit", params).(TransferState)
	retried := transferCall(t, m, "commit", params).(TransferState)
	if committed != retried || committed.Status != "completed" || m.Active() != 0 {
		t.Fatal("commit retry must preserve completion", committed, retried)
	}
	assertFile(t, path, data)
	// A new upload gets the mode of any newly created file (0666 less the umask).
	reference := filepath.Join(root, "reference")
	writeFixture(t, reference, nil, 0666)
	want, _ := os.Stat(reference)
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != want.Mode().Perm() {
		t.Fatal("upload mode", info.Mode(), want.Mode(), err)
	}
	transferCall(t, m, "abort", map[string]any{"id": id})
	assertFile(t, path, data)
}

func TestTransferRejectsIncompleteOverwriteAndDestinationRaces(t *testing.T) {
	m, root := transferManager(t)
	path := filepath.Join(root, "existing.txt")
	writeFixture(t, path, []byte("original"), 0600)
	id := "c401c370-03e5-4f2c-96be-012345678902"
	transferFails(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path}, "FILE_EXISTS")
	transferCall(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path, "overwrite": true})
	transferFails(t, m, "write", map[string]any{"id": id, "offset": 10, "data": base64.StdEncoding.EncodeToString([]byte("wrong offset"))}, "TRANSFER_OFFSET")
	transferCall(t, m, "write", map[string]any{"id": id, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("replacement"))})
	assertFile(t, path, []byte("original"))
	transferFails(t, m, "commit", map[string]any{"id": id, "size": 11, "sha256": "incorrect"}, "CHECKSUM_MISMATCH")
	assertFile(t, path, []byte("original"))
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	id = "c401c370-03e5-4f2c-96be-012345678909"
	transferCall(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path, "overwrite": true})
	transferCall(t, m, "write", map[string]any{"id": id, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("replacement"))})
	digest := sha256.Sum256([]byte("replacement"))
	transferCall(t, m, "commit", map[string]any{"id": id, "size": 11, "sha256": hex.EncodeToString(digest[:])})
	assertFile(t, path, []byte("replacement"))
	if info, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0640) {
		t.Fatal("overwrite must keep the existing mode", info.Mode(), err)
	}
	for i, overwrite := range []bool{false, true} {
		id := fmt.Sprintf("c401c370-03e5-4f2c-96be-%012d", i+3)
		path := filepath.Join(root, fmt.Sprintf("race-%d", i))
		transferCall(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path, "overwrite": overwrite})
		writeFixture(t, path, []byte("appeared during upload"), 0600)
		digest := sha256.Sum256(nil)
		params := map[string]any{"id": id, "size": 0, "sha256": hex.EncodeToString(digest[:])}
		if overwrite {
			transferCall(t, m, "commit", params)
			assertFile(t, path, nil)
		} else {
			transferFails(t, m, "commit", params, "FILE_EXISTS")
			assertFile(t, path, []byte("appeared during upload"))
		}
	}
	partials, _ := filepath.Glob(filepath.Join(root, ".hostherd-upload-*"))
	if len(partials) != 0 || m.Active() != 0 {
		t.Fatal("closed uploads left active descriptors or temporary files", partials)
	}
}

func TestTransferDownloadPinnedDescriptorAndChangedSource(t *testing.T) {
	m, root := transferManager(t)
	for i, data := range [][]byte{nil, bytes.Repeat([]byte("binary\x00\xff한글"), 80_000)} {
		id := fmt.Sprintf("c401c370-03e5-4f2c-96be-%012d", i+10)
		path := filepath.Join(root, fmt.Sprintf("source-%d", i))
		writeFixture(t, path, data, 0600)
		state := transferCall(t, m, "open", map[string]any{"id": id, "direction": "download", "path": path}).(TransferState)
		var received []byte
		for {
			part := transferCall(t, m, "read", map[string]any{"id": id, "offset": len(received)}).(map[string]any)
			bytes, err := base64.StdEncoding.DecodeString(part["data"].(string))
			if err != nil {
				t.Fatal(err)
			}
			received = append(received, bytes...)
			if part["eof"].(bool) {
				break
			}
		}
		if state.Size != int64(len(data)) || !bytes.Equal(received, data) {
			t.Fatal("download bytes differ")
		}
		writeFixture(t, path, append(data, 'x'), 0600)
		transferFails(t, m, "read", map[string]any{"id": id, "offset": 0}, "FILE_CHANGED")
		transferCall(t, m, "abort", map[string]any{"id": id})
	}
}

func TestTransferIdleAndRunnerRestartCleanup(t *testing.T) {
	m, root := transferManager(t)
	id := "c401c370-03e5-4f2c-96be-012345678920"
	path := filepath.Join(root, "never-published")
	transferCall(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path})
	m.Prune(time.Now().Add(16 * time.Minute))
	state := transferCall(t, m, "status", map[string]any{"id": id}).(TransferState)
	if state.Status != "expired" || m.Active() != 0 {
		t.Fatal("idle descriptor was not expired", state)
	}
	id = "c401c370-03e5-4f2c-96be-012345678921"
	transferCall(t, m, "open", map[string]any{"id": id, "direction": "upload", "path": path})
	// Simulate a process crash: OS closes its FD, but the cleanup marker remains.
	m.sessions[id].file.Close()
	restarted, err := NewTransfers(filepath.Join(root, "runtime"), "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	partials, _ := filepath.Glob(filepath.Join(root, ".hostherd-upload-*"))
	if len(partials) != 0 {
		t.Fatal("restart did not remove recorded temporary files", partials)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("crashed upload was published")
	}
}
