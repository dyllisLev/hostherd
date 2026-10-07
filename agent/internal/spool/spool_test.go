//go:build linux || darwin

package spool

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"hostherd/agent/internal/model"
)

func TestACKWhileWriterFinishesKeepsUnacknowledgedTail(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write(bytes.Repeat([]byte("a"), 1744)); err != nil {
		t.Fatal(err)
	}
	// The writer appends its final bytes and closes between Ack's closure
	// check and its size read.
	tail := bytes.Repeat([]byte("b"), 40)
	afterClosedCheck = func() {
		afterClosedCheck = func() {}
		if _, err := w.Write(tail); err != nil {
			t.Error(err)
		}
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	}
	defer func() { afterClosedCheck = func() {} }()
	if err = Ack(dir, 1744); err != nil {
		t.Fatal(err)
	}
	got, err := Read(dir, 1744)
	if err != nil || !bytes.Equal(got, tail) {
		t.Fatalf("unacknowledged tail lost: %q %v", got, err)
	}
	if err = Ack(dir, 1784); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(segment(dir, 0)); !os.IsNotExist(err) {
		t.Fatal("fully acknowledged closed segment remains", err)
	}
}

func TestACKNeverDeletesGrowingSegment(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir)
	if err != nil {
		t.Fatal(err)
	}
	first := bytes.Repeat([]byte("a"), 100)
	if _, err = w.Write(first); err != nil {
		t.Fatal(err)
	}
	got, err := Read(dir, 0)
	if err != nil || !bytes.Equal(got, first) {
		t.Fatalf("initial read: %d %v", len(got), err)
	}
	if err = Ack(dir, 100); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(segment(dir, 0)); err != nil {
		t.Fatal("growing segment deleted", err)
	}
	rest := bytes.Repeat([]byte("b"), model.ChunkSize+77)
	if _, err = w.Write(rest); err != nil {
		t.Fatal(err)
	}
	var restored []byte
	offset := int64(100)
	for {
		b, err := Read(dir, offset)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) == 0 {
			break
		}
		restored = append(restored, b...)
		offset += int64(len(b))
		if err = Ack(dir, offset); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(restored, rest) {
		t.Fatal("append after partial ACK lost bytes")
	}
	if _, err = os.Stat(segment(dir, 0)); !os.IsNotExist(err) {
		t.Fatal("fully ACKed segment remains")
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	if err = Ack(dir, offset); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(segment(dir, 1)); !os.IsNotExist(err) {
		t.Fatal("closed partial segment remains")
	}
}

func TestLargeOutputReplayAndDurableResume(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir)
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.New()
	chunk := make([]byte, model.ChunkSize)
	for i := 0; i < 192; i++ {
		for j := range chunk {
			chunk[j] = byte((i + j) % 251)
		}
		expected.Write(chunk)
		if _, err = w.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	actual := sha256.New()
	var cursor int64
	for {
		b, err := Read(dir, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) == 0 {
			break
		}
		// A lost ACK leaves the identical chunk available for replay.
		again, err := Read(dir, cursor)
		if err != nil || !bytes.Equal(b, again) {
			t.Fatal("replay differs", err)
		}
		actual.Write(b)
		cursor += int64(len(b))
		if err = Ack(dir, cursor); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(actual.Sum(nil), expected.Sum(nil)) {
		t.Fatal("large output checksum mismatch")
	}
	if ack, err := Acked(dir); err != nil || ack != cursor {
		t.Fatal("durable cursor", ack, err)
	}
	if _, err = Read(dir, 0); err == nil {
		t.Fatal("removed history accepted below durable cursor")
	}
}

func TestReadsRejectSymlinksAndFIFOs(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	w, err := NewWriter(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write([]byte("output")); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(segment(dir, 0)); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(secret, segment(dir, 0)); err != nil {
		t.Fatal(err)
	}
	if b, err := Read(dir, 0); err == nil {
		t.Fatalf("read through segment symlink: %q", b)
	}
	if err = os.Remove(filepath.Join(dir, "ack.json")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err = syscall.Mkfifo(filepath.Join(dir, "ack.json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = Acked(dir); err == nil {
		t.Fatal("read a FIFO counter")
	}
	link := filepath.Join(t.TempDir(), "job")
	if err = os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if _, err = Read(link, 0); err == nil {
		t.Fatal("read through a job directory symlink")
	}
}
