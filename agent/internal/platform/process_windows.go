//go:build windows

package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"hostherd/agent/internal/model"
)

// LoginShell prefers PowerShell 7 and falls back to Windows PowerShell 5.1.
func LoginShell() string {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

func Command(p model.StartParams, terminal bool) *exec.Cmd {
	shell := LoginShell()
	var cmd *exec.Cmd
	if terminal {
		cmd = exec.Command(shell, "-NoLogo")
	} else {
		cmd = exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", JobCommand(p.Cmd))
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
	}
	cmd.Dir = p.Path
	// Windows environment names are case-insensitive; later values replace earlier ones.
	names, values := map[string]string{}, map[string]string{}
	set := func(key, val string) {
		upper := strings.ToUpper(key)
		if _, ok := names[upper]; !ok {
			names[upper] = key
		}
		values[upper] = val
	}
	for _, entry := range os.Environ() {
		if key, val, ok := strings.Cut(entry, "="); ok && key != "" {
			set(key, val)
		}
	}
	if terminal {
		set("TERM", "xterm-256color")
		set("COLORTERM", "truecolor")
	}
	for key, val := range p.Env {
		set(key, val)
	}
	for upper, val := range values {
		cmd.Env = append(cmd.Env, names[upper]+"="+val)
	}
	return cmd
}

type exitError struct{ code int }

func (e exitError) Error() string { return "exit status " + strconv.Itoa(e.code) }
func (e exitError) ExitCode() int { return e.code }

// conPTY is a Windows pseudo console (Windows 10 1809 or later).
type conPTY struct {
	console windows.Handle
	input   *os.File // our write end of the console's input
	output  *os.File // our read end of the console's output
	mu      sync.Mutex
	closed  bool
}

func (c *conPTY) Read(b []byte) (int, error)  { return c.output.Read(b) }
func (c *conPTY) Write(b []byte) (int, error) { return c.input.Write(b) }
func (c *conPTY) Resize(cols, rows uint16) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("terminal has ended")
	}
	return windows.ResizePseudoConsole(c.console, windows.Coord{X: int16(cols), Y: int16(rows)})
}

// Close releases our pipe ends; the console itself closes when its shell exits.
func (c *conPTY) Close() error {
	return errors.Join(c.input.Close(), c.output.Close())
}

// closeConsole ends the pseudo console so the output pipe reaches EOF.
func (c *conPTY) closeConsole() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		windows.ClosePseudoConsole(c.console)
	}
}

type conPTYProcess struct {
	pid     int
	process windows.Handle
	pty     *conPTY
}

func (p *conPTYProcess) Pid() int { return p.pid }
func (p *conPTYProcess) Wait() error {
	defer windows.CloseHandle(p.process)
	if _, err := windows.WaitForSingleObject(p.process, windows.INFINITE); err != nil {
		return err
	}
	var code uint32
	err := windows.GetExitCodeProcess(p.process, &code)
	// Output reaches EOF only after the console closes; the runner drains it meanwhile.
	p.pty.closeConsole()
	if err != nil {
		return err
	}
	if code != 0 {
		return exitError{int(code)}
	}
	return nil
}

func environmentBlock(env []string) *uint16 {
	var block []uint16
	for _, entry := range env {
		if strings.IndexByte(entry, 0) >= 0 {
			continue
		}
		block = append(block, utf16.Encode([]rune(entry))...)
		block = append(block, 0)
	}
	block = append(block, 0)
	return &block[0]
}

// StartPTY runs the shell attached to a new pseudo console.
func StartPTY(cmd *exec.Cmd, cols, rows uint16) (PTY, Process, error) {
	inputRead, inputWrite, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	outputRead, outputWrite, err := os.Pipe()
	if err != nil {
		inputRead.Close()
		inputWrite.Close()
		return nil, nil, err
	}
	pty := &conPTY{input: inputWrite, output: outputRead}
	err = windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, windows.Handle(inputRead.Fd()), windows.Handle(outputWrite.Fd()), 0, &pty.console)
	// The console holds its own duplicates of these ends.
	inputRead.Close()
	outputWrite.Close()
	if err != nil {
		pty.Close()
		return nil, nil, fmt.Errorf("create pseudo console (Windows 10 1809 or later is required): %w", err)
	}
	fail := func(err error) (PTY, Process, error) {
		pty.closeConsole()
		pty.Close()
		return nil, nil, err
	}
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return fail(err)
	}
	defer attributes.Delete()
	if err = attributes.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&pty.console)), unsafe.Sizeof(pty.console)); err != nil {
		return fail(err)
	}
	info := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	info.Cb = uint32(unsafe.Sizeof(info))
	application, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		return fail(err)
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(cmd.Args))
	if err != nil {
		return fail(err)
	}
	var dir *uint16
	if cmd.Dir != "" {
		if dir, err = windows.UTF16PtrFromString(cmd.Dir); err != nil {
			return fail(err)
		}
	}
	var process windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err = windows.CreateProcess(application, commandLine, nil, nil, false, flags, environmentBlock(cmd.Env), dir, &info.StartupInfo, &process); err != nil {
		return fail(err)
	}
	windows.CloseHandle(process.Thread)
	return pty, &conPTYProcess{pid: int(process.ProcessId), process: process.Process, pty: pty}, nil
}

// Terminate ends the process and its descendants. Console programs cannot be
// asked to exit across a service boundary, so both steps force termination.
func Terminate(pid int, force bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kill := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/PID", strconv.Itoa(pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := kill.CombinedOutput()
	var exited *exec.ExitError
	if errors.As(err, &exited) && exited.ExitCode() == 128 { // No such process: already gone.
		return nil
	}
	if err != nil {
		return fmt.Errorf("taskkill: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ExitSignal is empty: Windows processes end with exit codes only.
func ExitSignal(error) string { return "" }

// CheckDirectory reports whether the runner account may open path.
func CheckDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return f.Close()
}

// SecureSocket is a no-op: the socket inherits the runtime directory's ACL.
func SecureSocket(string) error { return nil }

// SetCommandUmask has no Windows equivalent.
func SetCommandUmask() {}
