// Package files implements file RPCs with the permissions of the agent process.
package files

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultReadLimit = 64 * 1024
	maxReadLimit     = 512 * 1024 // Base64 plus metadata remains below 1 MiB.
)

type Entry struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	Mode       uint32 `json:"mode"`
	ModifiedAt string `json:"modifiedAt"`
}

type ListResult struct {
	Entries []Entry `json:"entries"`
}

type ReadResult struct {
	Data       string `json:"data"`
	Encoding   string `json:"encoding"`
	Offset     int64  `json:"offset"`
	NextOffset int64  `json:"nextOffset"`
	EOF        bool   `json:"eof"`
	Size       int64  `json:"size"`
}

type OKResult struct {
	OK bool `json:"ok"`
}

// Handle dispatches one file RPC. Paths are absolute and are not confined to a
// synthetic home directory; the operating system applies the execution user's
// permissions. It performs no privilege changes.
func Handle(method string, params json.RawMessage) (any, error) {
	switch method {
	case "file.list":
		return list(params)
	case "file.read":
		return read(params)
	case "file.image":
		return readImage(params)
	case "file.write":
		return write(params)
	case "file.edit":
		return edit(params)
	case "file.delete":
		return remove(params)
	case "file.search":
		return search(params)
	default:
		return nil, fmt.Errorf("unknown file method %q", method)
	}
}

func decode(params json.RawMessage, target any) error {
	trimmed := bytes.TrimSpace(params)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("params must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("params must contain exactly one JSON object")
	}
	return nil
}

func validatePath(path string) error {
	if !filepath.IsAbs(path) || strings.ContainsRune(path, '\x00') {
		return errors.New("path must be an absolute path without NUL bytes")
	}
	return nil
}

// Check before opening so an ordinary request for a FIFO cannot block waiting
// for a peer. The opened descriptor is checked again where it will be read.
func requireRegularPath(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("operation requires a regular file")
	}
	return nil
}

func list(raw json.RawMessage) (any, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(p.Path)
	if err != nil {
		return nil, err
	}
	result := ListResult{Entries: make([]Entry, 0, len(entries))}
	for _, entry := range entries {
		info, err := entry.Info() // Lstat semantics retain symlink identity.
		if err != nil {
			return nil, err
		}
		typ := "other"
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			typ = "symlink"
		case info.IsDir():
			typ = "directory"
		case info.Mode().IsRegular():
			typ = "file"
		}
		result.Entries = append(result.Entries, Entry{
			Name: entry.Name(), Type: typ, Size: info.Size(),
			Mode: uint32(info.Mode().Perm()), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
		})
	}
	return result, nil
}

func read(raw json.RawMessage) (any, error) {
	var p struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
		Limit  *int64 `json:"limit"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, err
	}
	if p.Offset < 0 || (p.Limit != nil && *p.Limit < 0) {
		return nil, errors.New("offset and limit must not be negative")
	}
	limit := int64(defaultReadLimit)
	if p.Limit != nil && *p.Limit > 0 {
		limit = min(*p.Limit, int64(maxReadLimit))
	}
	if err := requireRegularPath(p.Path); err != nil {
		return nil, err
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("file.read requires a regular file")
	}
	buf := make([]byte, limit)
	n, err := f.ReadAt(buf, p.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	// A file may grow while read: report the most recent observed size rather
	// than declaring EOF from an out-of-date pre-read stat.
	info, err = f.Stat()
	if err != nil {
		return nil, err
	}
	nextOffset := p.Offset + int64(n)
	return ReadResult{
		Data: base64.StdEncoding.EncodeToString(buf[:n]), Encoding: "base64",
		Offset: p.Offset, NextOffset: nextOffset, EOF: nextOffset >= info.Size(), Size: info.Size(),
	}, nil
}

func write(raw json.RawMessage) (any, error) {
	var p struct {
		Path       string  `json:"path"`
		Data       *string `json:"data"`
		Encoding   string  `json:"encoding"`
		CreateOnly bool    `json:"createOnly"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, err
	}
	if p.Data == nil {
		return nil, errors.New("data is required")
	}
	var data []byte
	switch p.Encoding {
	case "", "utf8":
		data = []byte(*p.Data)
	case "base64":
		var err error
		data, err = base64.StdEncoding.DecodeString(*p.Data)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 data: %w", err)
		}
	default:
		return nil, errors.New("encoding must be utf8 or base64")
	}
	if err := requireRegularPath(p.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if p.CreateOnly {
		flags = os.O_WRONLY | os.O_CREATE | os.O_EXCL
	}
	f, err := os.OpenFile(p.Path, flags, 0666)
	if err != nil {
		return nil, err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return OKResult{OK: true}, nil
}

func edit(raw json.RawMessage) (any, error) {
	var p struct {
		Path    string  `json:"path"`
		OldText *string `json:"oldText"`
		NewText *string `json:"newText"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, err
	}
	if p.OldText == nil || *p.OldText == "" || p.NewText == nil {
		return nil, errors.New("non-empty oldText and newText (which may be empty) are required")
	}
	if err := requireRegularPath(p.Path); err != nil {
		return nil, err
	}
	// Open the target inode once, following normal OS symlink semantics. An
	// in-place edit preserves its mode, owner, hard links and symlink identity.
	f, err := os.OpenFile(p.Path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("file.edit requires a regular file")
	}
	content, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	old := []byte(*p.OldText)
	index := bytes.Index(content, old)
	if index < 0 || bytes.Index(content[index+1:], old) >= 0 {
		return nil, errors.New("oldText must occur exactly once (including overlapping occurrences)")
	}
	replacement := make([]byte, 0, len(content)-len(old)+len(*p.NewText))
	replacement = append(replacement, content[:index]...)
	replacement = append(replacement, *p.NewText...)
	replacement = append(replacement, content[index+len(old):]...)
	if _, err := f.WriteAt(replacement, 0); err != nil {
		return nil, err
	}
	if err := f.Truncate(int64(len(replacement))); err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return OKResult{OK: true}, nil
}

func remove(raw json.RawMessage) (any, error) {
	var p struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, err
	}
	var err error
	if p.Recursive {
		err = os.RemoveAll(p.Path)
	} else {
		err = os.Remove(p.Path)
	}
	if err != nil {
		return nil, err
	}
	return OKResult{OK: true}, nil
}
