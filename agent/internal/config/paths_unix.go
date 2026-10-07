//go:build !windows

package config

const (
	DefaultPath     = "/etc/hostherd/config.json"
	DefaultStateDir = "/var/lib/hostherd/runtime"
)
