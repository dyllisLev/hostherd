package install

import (
	"encoding/xml"
	"testing"

	"hostherd/agent/internal/config"
)

func TestRunnerTaskXMLForUserAndSystem(t *testing.T) {
	c := config.Config{StateDir: `C:\ProgramData\Hostherd\runtime`, Generation: "1.0.0", ExecutionUser: `PC-01\Jane & "Doe"`}
	var task struct {
		Principal struct {
			UserID    string `xml:"UserId"`
			LogonType string `xml:"LogonType"`
			RunLevel  string `xml:"RunLevel"`
		} `xml:"Principals>Principal"`
		Command   string `xml:"Actions>Exec>Command"`
		Arguments string `xml:"Actions>Exec>Arguments"`
		Limit     string `xml:"Settings>ExecutionTimeLimit"`
		Boot      string `xml:"Triggers>BootTrigger>Enabled"`
	}
	user := runnerTaskXML(c, "S-1-5-21-1-2-3-1001", `C:\Program Files\Hostherd\releases\1.0.0\hostherd.exe`, `runner --state-dir C:\ProgramData\Hostherd\runtime --generation 1.0.0`)
	// The declaration says UTF-16 because schtasks reads the file as UTF-16; parse the body here.
	body := user[len(`<?xml version="1.0" encoding="UTF-16"?>`):]
	if err := xml.Unmarshal([]byte(body), &task); err != nil {
		t.Fatalf("invalid task XML: %v\n%s", err, user)
	}
	if task.Principal.UserID != "S-1-5-21-1-2-3-1001" || task.Principal.LogonType != "S4U" || task.Principal.RunLevel != "LeastPrivilege" {
		t.Fatalf("user principal %+v", task.Principal)
	}
	if task.Command != `C:\Program Files\Hostherd\releases\1.0.0\hostherd.exe` || task.Limit != "PT0S" || task.Boot != "true" {
		t.Fatalf("task %+v", task)
	}
	system := runnerTaskXML(c, windowsSystemSID, `C:\h.exe`, "runner")
	task.Principal.LogonType = ""
	if err := xml.Unmarshal([]byte(system[len(`<?xml version="1.0" encoding="UTF-16"?>`):]), &task); err != nil {
		t.Fatal(err)
	}
	if task.Principal.UserID != windowsSystemSID || task.Principal.LogonType != "" || task.Principal.RunLevel != "HighestAvailable" {
		t.Fatalf("system principal %+v", task.Principal)
	}
}
