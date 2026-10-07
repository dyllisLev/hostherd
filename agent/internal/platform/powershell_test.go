package platform

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestEncodedCommandIsUTF16LittleEndianBase64(t *testing.T) {
	script := `Write-Output "한글 & 'quotes'"`
	raw, err := base64.StdEncoding.DecodeString(EncodedCommand(script))
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("decode: %v", err)
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	if got := string(utf16.Decode(units)); got != script {
		t.Fatalf("round trip %q", got)
	}
}

func TestJobScriptKeepsTheLastCommandsExitStatus(t *testing.T) {
	script := JobScript("git status")
	lines := strings.Split(strings.TrimSpace(script), "\n")
	if lines[4] != "git status" || !strings.HasPrefix(lines[5], "$hostherdSucceeded=$?") {
		t.Fatalf("the user command must be followed directly by the status capture:\n%s", script)
	}
	if !strings.Contains(script, "elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }") || !strings.Contains(script, "UTF8Encoding]::new($false)") {
		t.Fatalf("exit status or UTF-8 setup missing:\n%s", script)
	}
	// job_input sends UTF-8; the console input default is the ANSI code page.
	if !strings.Contains(script, "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)\n") {
		t.Fatalf("UTF-8 stdin setup missing:\n%s", script)
	}
}

func TestJobCommandRunsTheEncodedJobScriptInTheCurrentScope(t *testing.T) {
	command := JobCommand(`Write-Output "한글"`)
	prefix := ". ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"
	if !strings.HasPrefix(command, prefix) || !strings.HasSuffix(command, "'))))") {
		t.Fatalf("unexpected bootstrap: %s", command)
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(command, prefix), "'))))")
	if encoded != EncodedCommand(JobScript(`Write-Output "한글"`)) || strings.ContainsAny(encoded, "'\\\"") {
		t.Fatalf("payload must be the encoded job script without quote characters")
	}
}
