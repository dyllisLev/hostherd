// Package spool stores output in fixed-size disk segments. Only centrally durable
// ACKed segments are removed; memory usage is independent of accumulated output.
package spool

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"hostherd/agent/internal/model"
	"hostherd/agent/internal/store"
)

func segment(dir string, index int64) string {
	return filepath.Join(dir, fmt.Sprintf("output-%020d.bin", index))
}
func counter(dir, name string) (int64, error) {
	b, err := store.ReadRegular(filepath.Join(dir, name+".json"))
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var n int64
	err = json.Unmarshal(b, &n)
	return n, err
}
func Size(dir string) (int64, error)  { return counter(dir, "end") }
func Acked(dir string) (int64, error) { return counter(dir, "ack") }

type Writer struct {
	dir string
	end int64
}

func NewWriter(dir string) (*Writer, error) {
	end, err := Size(dir)
	if err != nil {
		return nil, err
	}
	return &Writer{dir: dir, end: end}, nil
}
func (w *Writer) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		start := w.end
		remaining := model.ChunkSize - int(start%model.ChunkSize)
		n := min(len(p), remaining)
		f, err := os.OpenFile(segment(w.dir, start/model.ChunkSize), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return written, err
		}
		count, err := f.WriteAt(p[:n], start%model.ChunkSize)
		if err == nil && count != n {
			err = io.ErrShortWrite
		}
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return written, err
		}
		if closeErr != nil {
			return written, closeErr
		}
		if err = store.AtomicJSON(filepath.Join(w.dir, "end.json"), start+int64(n)); err != nil {
			return written, err
		}
		w.end += int64(n)
		written += n
		p = p[n:]
	}
	return written, nil
}
func (w *Writer) Close() error { return store.AtomicJSON(filepath.Join(w.dir, "closed.json"), true) }

func Read(dir string, offset int64) ([]byte, error) {
	if offset < 0 {
		return nil, fmt.Errorf("negative output offset")
	}
	if err := store.CheckDir(dir); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	end, err := Size(dir)
	if err != nil {
		return nil, err
	}
	if offset >= end {
		return nil, nil
	}
	acked, err := Acked(dir)
	if err != nil {
		return nil, err
	}
	if offset < acked {
		return nil, fmt.Errorf("output before durable ACK %d is no longer available", acked)
	}
	n := min(int64(model.ChunkSize)-offset%model.ChunkSize, end-offset)
	f, err := store.OpenRegular(segment(dir, offset/model.ChunkSize))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b := make([]byte, n)
	count, err := f.ReadAt(b, offset%model.ChunkSize)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if int64(count) != n {
		return nil, io.ErrUnexpectedEOF
	}
	return b, nil
}

var afterClosedCheck = func() {} // Test hook.

func Ack(dir string, offset int64) error {
	if err := store.CheckDir(dir); err != nil && !os.IsNotExist(err) {
		return err
	}
	previous, err := Acked(dir)
	if err != nil {
		return err
	}
	if offset < previous {
		return nil
	}
	// Observe closure BEFORE reading end. Otherwise the writer can append and
	// close after our size snapshot, making a partial ACK delete its final bytes.
	_, closedErr := os.Stat(filepath.Join(dir, "closed.json"))
	if closedErr != nil && !os.IsNotExist(closedErr) {
		return closedErr
	}
	afterClosedCheck()
	end, err := Size(dir)
	if err != nil {
		return err
	}
	if offset > end {
		return fmt.Errorf("ACK %d exceeds output size %d", offset, end)
	}
	if offset > previous {
		if err = store.AtomicJSON(filepath.Join(dir, "ack.json"), offset); err != nil {
			return err
		}
	}
	// The currently growing partial segment must remain until its writer closes.
	for index := previous / model.ChunkSize; index < offset/model.ChunkSize; index++ {
		if err = os.Remove(segment(dir, index)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if closedErr == nil && offset == end && offset%model.ChunkSize != 0 {
		if err = os.Remove(segment(dir, offset/model.ChunkSize)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
