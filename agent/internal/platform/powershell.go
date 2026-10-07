package platform

import (
	"encoding/base64"
	"unicode/utf16"
)

// JobScript wraps a command so stdin and output are UTF-8 (job_input sends UTF-8;
// the console input default is the ANSI code page, e.g. 949) and the exit code follows
// the last command, as `sh -c` does: a failing native command keeps its code and
// a failing cmdlet exits 1.
func JobScript(command string) string {
	return "$ProgressPreference='SilentlyContinue'\n" +
		"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n" +
		"[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)\n" +
		"$OutputEncoding=[Console]::OutputEncoding\n" +
		command + "\n" +
		"$hostherdSucceeded=$?\n" +
		"if ($hostherdSucceeded) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }\n"
}

// JobCommand is the -Command argument that runs JobScript(command). The script
// travels base64-encoded, which avoids Windows command-line quoting, but is not
// passed with -EncodedCommand: Windows PowerShell 5.1 then writes the error
// stream to redirected stderr as CLIXML instead of text, even with
// -OutputFormat Text.
func JobCommand(command string) string {
	return ". ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + EncodedCommand(JobScript(command)) + "'))))"
}

// EncodedCommand is PowerShell's -EncodedCommand form (UTF-16LE, base64), which
// avoids Windows command-line quoting of the user's script.
func EncodedCommand(script string) string {
	units := utf16.Encode([]rune(script))
	b := make([]byte, len(units)*2)
	for i, u := range units {
		b[2*i], b[2*i+1] = byte(u), byte(u>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}
