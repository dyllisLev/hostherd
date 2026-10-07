package install

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Exercise both macOS artifact selections on Linux too, with real signature
// verification and a harmless shell fixture in place of the Mach-O executable.
func TestDarwinBootstrap(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("bootstrap requires root")
	}
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("OpenSSL unavailable")
	}
	script, err := filepath.Abs("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, arch := range []string{"amd64", "arm64"} {
		for _, mutation := range []string{"none", "signature", "binary"} {
			t.Run(arch+"/"+mutation, func(t *testing.T) {
				dir := t.TempDir()
				binary := []byte("#!/bin/sh\nprintf 'executed' > \"$EXECUTION_MARKER\"\n")
				envelope, key, _ := signedFixture(t, "1.0.0", binary)
				if mutation == "signature" {
					envelope = bytes.Replace(envelope, []byte(`"signature":"`), []byte(`"signature":"AAAA`), 1)
				}
				if mutation == "binary" {
					binary = append(binary, []byte("# tampered\n")...)
				}
				machine := arch
				if arch == "amd64" {
					machine = "x86_64"
				}
				for name, data := range map[string][]byte{
					"manifest.json": envelope, "release.pub": []byte(key), "hostherd-darwin-" + arch: binary,
					"uname": []byte("#!/bin/sh\ncase \"$1\" in -s) echo Darwin ;; -m) echo " + machine + " ;; *) exit 1 ;; esac\n"),
					"curl":  []byte("#!/bin/sh\nset -eu\nwhile [ \"$#\" -gt 0 ]; do\ncase \"$1\" in -o) output=$2; shift 2 ;; https://*) source=${1##*/}; shift ;; *) shift ;; esac\ndone\ncp \"$CURL_FIXTURE/$source\" \"$output\"\n"),
				} {
					if err := os.WriteFile(filepath.Join(dir, name), data, 0700); err != nil {
						t.Fatal(err)
					}
				}
				marker := filepath.Join(dir, "executed")
				cmd := exec.Command("sh", script, "--url", "https://mcp.example", "--code", "fixture")
				cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "CURL_FIXTURE="+dir, "EXECUTION_MARKER="+marker)
				output, err := cmd.CombinedOutput()
				if (err == nil) != (mutation == "none") {
					t.Fatalf("bootstrap: %v: %s", err, output)
				}
				_, err = os.Stat(marker)
				if (err == nil) != (mutation == "none") {
					t.Fatalf("executed unverified binary: %v", err)
				}
			})
		}
	}
}
