package install

import (
	"strings"

	"hostherd/agent/internal/config"
)

// windowsSystemSID is LocalSystem (S-1-5-18).
const windowsSystemSID = "S-1-5-18"

// runnerTaskXML defines a boot-started runner. A user account uses S4U, which
// needs no stored password; its processes run with the user's standard token and
// have no network credentials. SYSTEM runs with its full token.
func runnerTaskXML(c config.Config, sid, binary, arguments string) string {
	escape := func(value string) string {
		var b strings.Builder
		xmlEscape(&b, value)
		return b.String()
	}
	principal := `<UserId>` + escape(sid) + `</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel>`
	if sid == windowsSystemSID {
		principal = `<UserId>` + windowsSystemSID + `</UserId><RunLevel>HighestAvailable</RunLevel>`
	}
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Hostherd runner ` + escape(c.Generation) + ` for ` + escape(c.ExecutionUser) + `</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals><Principal id="Runner">` + principal + `</Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Runner"><Exec><Command>` + escape(binary) + `</Command><Arguments>` + escape(arguments) + `</Arguments></Exec></Actions>
</Task>
`
}

func xmlEscape(b *strings.Builder, value string) {
	for _, r := range value {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		default:
			b.WriteRune(r)
		}
	}
}
