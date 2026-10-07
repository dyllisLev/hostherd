package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"hostherd/agent/internal/model"
)

var validID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
var validGeneration = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)

func ValidateID(id string) error {
	if !validID.MatchString(id) {
		return fmt.Errorf("invalid job ID: UUID required")
	}
	return nil
}
func ValidateGeneration(g string) error {
	if !validGeneration.MatchString(g) {
		return fmt.Errorf("invalid runner generation")
	}
	return nil
}
func JobDir(root, id string) string { return filepath.Join(root, "jobs", id) }
func SocketPath(root, generation string) string {
	return filepath.Join(root, "runners", generation, "runner.sock")
}

func AtomicJSON(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return AtomicWrite(path, b, 0600)
}
func AtomicWrite(path string, b []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = ReplaceFile(tmp, path); err != nil {
		return err
	}
	return SyncDir(filepath.Dir(path))
}

// OpenRegular opens an existing regular file of the runtime state.
func OpenRegular(path string) (*os.File, error) {
	f, err := os.OpenFile(path, readFlags, 0)
	if err != nil {
		return nil, err
	}
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = fmt.Errorf("%s is not a regular file", path)
		}
		return nil, err
	}
	return f, nil
}
func ReadRegular(path string) ([]byte, error) {
	f, err := OpenRegular(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// CheckDir rejects a state directory replaced by a symlink or another file.
func CheckDir(dir string) error {
	info, err := os.Lstat(dir)
	if err == nil && !info.IsDir() {
		err = fmt.Errorf("%s is not a directory", dir)
	}
	return err
}
func ReadRecord(root, id string) (model.Record, error) {
	var r model.Record
	if err := ValidateID(id); err != nil {
		return r, err
	}
	if err := CheckDir(JobDir(root, id)); err != nil {
		return r, err
	}
	b, err := ReadRegular(filepath.Join(JobDir(root, id), "meta.json"))
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(b, &r); err != nil {
		return r, err
	}
	if r.Job.ID != id {
		return r, errors.New("job metadata identity mismatch")
	}
	if err = ValidateGeneration(r.Owner); err != nil {
		return r, err
	}
	return r, nil
}
func WriteRecord(root string, r model.Record) error {
	if err := ValidateID(r.Job.ID); err != nil {
		return err
	}
	return AtomicJSON(filepath.Join(JobDir(root, r.Job.ID), "meta.json"), r)
}

// ListIDs returns job directory names without reading their records.
func ListIDs(root string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root, "jobs"))
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && ValidateID(entry.Name()) == nil {
			ids = append(ids, entry.Name())
		}
	}
	return ids, nil
}
func List(root string) ([]model.Record, error) {
	ids, err := ListIDs(root)
	if err != nil {
		return nil, err
	}
	result := make([]model.Record, 0, len(ids))
	for _, id := range ids {
		r, err := ReadRecord(root, id)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, nil
}
