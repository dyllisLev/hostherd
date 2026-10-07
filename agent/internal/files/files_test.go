package files

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func call(t *testing.T, method string, params any) any {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Handle(method, raw)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return result
}

func callError(t *testing.T, method string, params any) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Handle(method, raw); err == nil {
		t.Fatalf("%s accepted invalid params %s", method, raw)
	}
}

func writeFixture(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

func assertFile(t *testing.T, path string, expected []byte) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, expected) {
		t.Fatalf("file contents differ: got %d bytes, expected %d", len(data), len(expected))
	}
}

func TestReadBoundedPaginationReconstructsBinary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data")
	original := make([]byte, 2*1024*1024+17)
	for i := range original {
		original[i] = byte(i * 137)
	}
	writeFixture(t, path, original, 0600)
	var actual []byte
	offset := int64(0)
	for {
		result := call(t, "file.read", map[string]any{"path": path, "offset": offset, "limit": int64(1 << 50)}).(ReadResult)
		payload, err := json.Marshal(result)
		if err != nil || len(payload) > 1024*1024 {
			t.Fatalf("unbounded response: %d, %v", len(payload), err)
		}
		data, err := base64.StdEncoding.DecodeString(result.Data)
		if err != nil {
			t.Fatal(err)
		}
		if result.Offset != offset || result.NextOffset != offset+int64(len(data)) || result.Size != int64(len(original)) {
			t.Fatalf("incorrect byte offsets: %#v", result)
		}
		actual = append(actual, data...)
		offset = result.NextOffset
		if result.EOF {
			break
		}
		if len(data) == 0 {
			t.Fatal("read made no progress")
		}
	}
	if !bytes.Equal(original, actual) {
		t.Fatal("paginated read did not reproduce file bytes")
	}
	first := call(t, "file.read", map[string]any{"path": path}).(ReadResult)
	if first.NextOffset != 65536 || first.EOF {
		t.Fatalf("unexpected default read: next=%d eof=%v", first.NextOffset, first.EOF)
	}
	beyond := call(t, "file.read", map[string]any{"path": path, "offset": len(original) + 100}).(ReadResult)
	if beyond.Data != "" || !beyond.EOF || beyond.NextOffset != int64(len(original)+100) {
		t.Fatalf("incorrect EOF beyond file: %#v", beyond)
	}
}

func TestCreateOnlyIsExclusiveAndWriteValidatesBeforeTruncating(t *testing.T) {
	path := filepath.Join(t.TempDir(), "exclusive")
	raw, err := json.Marshal(map[string]any{"path": path, "data": "kept", "createOnly": true})
	if err != nil {
		t.Fatal(err)
	}
	var succeeded atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Handle("file.write", raw); err == nil {
				succeeded.Add(1)
			}
		}()
	}
	wg.Wait()
	if succeeded.Load() != 1 {
		t.Fatalf("createOnly had %d winners", succeeded.Load())
	}
	callError(t, "file.write", map[string]any{"path": path, "data": "!bad!", "encoding": "base64"})
	assertFile(t, path, []byte("kept"))
	data := []byte{0, 255, 2, 6, 9}
	call(t, "file.write", map[string]any{"path": path, "data": base64.StdEncoding.EncodeToString(data), "encoding": "base64"})
	assertFile(t, path, data)
}

func TestEditExactlyOncePreservesModeAndSymlink(t *testing.T) {
	dir := t.TempDir()
	path, link := filepath.Join(dir, "target"), filepath.Join(dir, "link")
	writeFixture(t, path, []byte("before unique after"), 0751)
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	call(t, "file.edit", map[string]any{"path": link, "oldText": "unique", "newText": "x"})
	assertFile(t, path, []byte("before x after"))
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0751 {
		t.Fatalf("edit changed permissions: %v, %v", info, err)
	}
	linkInfo, err := os.Lstat(link)
	if err != nil || linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("edit replaced symlink: %v, %v", linkInfo, err)
	}
	callError(t, "file.edit", map[string]any{"path": path, "oldText": "missing", "newText": ""})
	assertFile(t, path, []byte("before x after"))
	writeFixture(t, path, []byte("aaa"), 0751)
	callError(t, "file.edit", map[string]any{"path": path, "oldText": "aa", "newText": "z"})
	assertFile(t, path, []byte("aaa"))
	call(t, "file.edit", map[string]any{"path": path, "oldText": "aaa", "newText": ""})
	assertFile(t, path, nil)
}

func TestListAndDeleteDoNotFollowDirectorySymlinks(t *testing.T) {
	dir, target := t.TempDir(), t.TempDir()
	writeFixture(t, filepath.Join(target, "kept"), []byte("stay"), 0644)
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(dir, "plain"), []byte("x"), 0640)
	result := call(t, "file.list", map[string]any{"path": dir}).(ListResult)
	if len(result.Entries) != 2 || result.Entries[0].Name != "link" || result.Entries[0].Type != "symlink" || result.Entries[1].Mode != 0640 {
		t.Fatalf("unexpected directory entries: %#v", result)
	}
	callError(t, "file.delete", map[string]any{"path": dir})
	call(t, "file.delete", map[string]any{"path": link, "recursive": true})
	assertFile(t, filepath.Join(target, "kept"), []byte("stay"))
	call(t, "file.delete", map[string]any{"path": dir, "recursive": true})
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("recursive delete failed: %v", err)
	}
}

func TestInvalidParameters(t *testing.T) {
	dir := t.TempDir()
	for _, method := range []string{"file.list", "file.read", "file.write", "file.edit", "file.delete", "file.search"} {
		t.Run(method, func(t *testing.T) {
			for _, raw := range []string{"null", "[]", "", "{}", `{"path":"relative"}`, `{"path":"/tmp","unexpected":true}`, `{"path":"/tmp"} {}`} {
				if _, err := Handle(method, json.RawMessage(raw)); err == nil {
					t.Fatalf("accepted invalid params %q", raw)
				}
			}
		})
	}
	callError(t, "file.read", map[string]any{"path": dir, "offset": -1})
	callError(t, "file.read", map[string]any{"path": dir, "limit": -1})
	callError(t, "file.read", map[string]any{"path": dir})
	callError(t, "file.write", map[string]any{"path": filepath.Join(dir, "x"), "data": "", "encoding": "hex"})
	callError(t, "file.edit", map[string]any{"path": filepath.Join(dir, "x"), "oldText": "", "newText": "a"})
	callError(t, "file.search", map[string]any{"path": dir, "query": ""})
	callError(t, "file.search", map[string]any{"path": dir, "query": "a\nb"})
	callError(t, "file.search", map[string]any{"path": dir, "query": "a", "offset": -1})
	callError(t, "file.nope", map[string]any{"path": dir})
}

func TestSearchStreamsLongLinesAndFindsCrossChunkLiteral(t *testing.T) {
	path := filepath.Join(t.TempDir(), "long.txt")
	query := "[literal]*match"
	long := strings.Repeat("x", 8*1024*1024-3) + query + "tail"
	content := "unmatched\n" + long + "\n" + "again " + query + " twice " + query + "\r\n" + query
	writeFixture(t, path, []byte(content), 0600)
	page := call(t, "file.search", map[string]any{"path": path, "query": query, "limit": 1}).(SearchResult)
	if len(page.Matches) != 1 || page.Matches[0].Line != 2 || !page.Matches[0].Truncated || len(page.Matches[0].Text) > 512 || page.EOF || page.NextOffset != 1 {
		t.Fatalf("unexpected first page: %#v", page)
	}
	page = call(t, "file.search", map[string]any{"path": path, "query": query, "offset": page.NextOffset, "limit": 2}).(SearchResult)
	if len(page.Matches) != 2 || page.Matches[0].Line != 3 || page.Matches[1].Line != 4 || !page.EOF || page.NextOffset != 3 {
		t.Fatalf("unexpected final page: %#v", page)
	}
	if strings.HasSuffix(page.Matches[0].Text, "\r") {
		t.Fatal("CRLF preview includes CR")
	}
	// This occurrence straddles an exact reader buffer boundary.
	writeFixture(t, path, []byte(strings.Repeat("x", 65536-4)+query), 0600)
	page = call(t, "file.search", map[string]any{"path": path, "query": query}).(SearchResult)
	if len(page.Matches) != 1 || page.Matches[0].Line != 1 {
		t.Fatalf("lost boundary-spanning match: %#v", page)
	}
}

func TestSearchBinarySymlinksOrderingAndUTF8Preview(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, filepath.Join(dir, "a.txt"), []byte("needle\n"), 0600)
	writeFixture(t, filepath.Join(dir, "b.bin"), []byte("needle\x00\n"), 0600)
	writeFixture(t, filepath.Join(dir, "c.txt"), []byte(strings.Repeat("한", 400)+"needle"), 0600)
	if err := os.Symlink(dir, filepath.Join(dir, "loop")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "a.txt"), filepath.Join(dir, "d-link")); err != nil {
		t.Fatal(err)
	}
	rootLink := filepath.Join(t.TempDir(), "root")
	if err := os.Symlink(dir, rootLink); err != nil {
		t.Fatal(err)
	}
	result := call(t, "file.search", map[string]any{"path": rootLink, "query": "needle"}).(SearchResult)
	if len(result.Matches) != 3 || !result.EOF {
		t.Fatalf("binary or symlink traversal error: %#v", result)
	}
	for i, name := range []string{"a.txt", "c.txt", "d-link"} {
		if result.Matches[i].Path != filepath.Join(rootLink, name) {
			t.Fatalf("unstable ordering or root symlink result: %#v", result)
		}
	}
	if strings.Contains(result.Matches[1].Text, "�") || !result.Matches[1].Truncated {
		t.Fatalf("split UTF8 preview: %#v", result.Matches[1])
	}
}

func TestSearchResponseBytesAndPagination(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 12; i++ {
		dir = filepath.Join(dir, fmt.Sprintf("%02d-%s", i, strings.Repeat("a", 170)))
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "matches.txt")
	writeFixture(t, path, []byte(strings.Repeat("needle "+strings.Repeat("x", 600)+"\n", 1300)), 0600)
	offset := int64(0)
	pages := 0
	for {
		result := call(t, "file.search", map[string]any{"path": path, "query": "needle", "offset": offset, "limit": 5000}).(SearchResult)
		payload, err := json.Marshal(result)
		if err != nil || len(payload) > 1024*1024 {
			t.Fatalf("search response too large: %d, %v", len(payload), err)
		}
		if len(result.Matches) == 0 || len(result.Matches) > 1000 {
			t.Fatalf("page size invalid: %d", len(result.Matches))
		}
		for i, match := range result.Matches {
			if match.Line != offset+int64(i)+1 {
				t.Fatalf("duplicated or lost search result: offset %d, index %d, line %d", offset, i, match.Line)
			}
		}
		offset = result.NextOffset
		pages++
		if result.EOF {
			break
		}
	}
	if offset != 1300 || pages < 3 {
		t.Fatalf("unexpected bounded pages: matches=%d pages=%d", offset, pages)
	}
}
