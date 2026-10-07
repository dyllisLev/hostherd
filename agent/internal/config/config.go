package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"hostherd/agent/internal/store"
)

type Config struct {
	URL           string `json:"url"`
	Token         string `json:"token"`
	ServerID      string `json:"serverId"`
	ExecutionUser string `json:"executionUser"`
	StateDir      string `json:"stateDir"`
	Generation    string `json:"generation"`
	Version       string `json:"version"`
	PublicKey     string `json:"publicKey"`
	InstallDir    string `json:"installDir"`
}

func Load(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.URL == "" || c.Token == "" || c.StateDir == "" || c.Generation == "" {
		return c, fmt.Errorf("incomplete agent configuration")
	}
	return c, nil
}

func Save(path string, c Config) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
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
	if err = store.ReplaceFile(tmp, path); err != nil {
		return err
	}
	return store.SyncDir(filepath.Dir(path))
}
