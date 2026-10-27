//go:build linux || darwin

package store

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestReadRecordRejectsLinksAndFIFOs(t *testing.T) {
	root := t.TempDir()
	id := "00000000-0000-4000-8000-000000000001"
	secret := filepath.Join(t.TempDir(), "meta.json")
	if err := os.WriteFile(secret, []byte(`{"owner":"1.0.0","job":{"id":"`+id+`"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(JobDir(root, id), 0700); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(JobDir(root, id), "meta.json")
	if err := os.Symlink(secret, meta); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRecord(root, id); err == nil {
		t.Fatal("followed a meta.json symlink")
	}
	os.Remove(meta)
	if err := syscall.Mkfifo(meta, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRecord(root, id); err == nil {
		t.Fatal("read a FIFO")
	}
	os.Remove(meta)
	if err := os.Link(secret, meta); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRecord(root, id); err == nil {
		t.Fatal("followed a meta.json hard link")
	}
	os.RemoveAll(JobDir(root, id))
	if err := os.Symlink(filepath.Dir(secret), JobDir(root, id)); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRecord(root, id); err == nil {
		t.Fatal("followed a job directory symlink")
	}
}

// Replacing meta.json between open and fstat unlinks the opened inode (nlink 0).
// The read must retry and return the replaced file.
func TestReadRecordRetriesReplaceDuringStat(t *testing.T) {
	root := t.TempDir()
	id := "00000000-0000-4000-8000-000000000002"
	if err := os.MkdirAll(JobDir(root, id), 0700); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(JobDir(root, id), "meta.json")
	original := []byte(`{"owner":"1.0.0","job":{"id":"` + id + `","status":"running"}}`)
	if err := os.WriteFile(meta, original, 0600); err != nil {
		t.Fatal(err)
	}
	replaced := []byte(`{"owner":"1.0.0","job":{"id":"` + id + `","status":"completed"}}`)
	beforeRegularStat = func() {
		beforeRegularStat = func() {}
		if err := AtomicWrite(meta, replaced, 0600); err != nil {
			t.Error(err)
		}
	}
	defer func() { beforeRegularStat = func() {} }()
	got, err := ReadRecord(root, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Job.Status != "completed" {
		t.Fatalf("status %q, want the replaced file", got.Job.Status)
	}
}
