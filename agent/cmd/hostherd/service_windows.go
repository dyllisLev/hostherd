//go:build windows

package main

import (
	"context"

	"golang.org/x/sys/windows/svc"
	"hostherd/agent/internal/install"
)

// runAsService answers the Windows service control manager when started as the
// agent service; from a console it runs directly.
func runAsService(ctx context.Context, run func(context.Context) error) error {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return run(ctx)
	}
	return svc.Run(install.AgentService, &handler{ctx: ctx, run: run})
}

type handler struct {
	ctx context.Context
	run func(context.Context) error
	err error
}

func (h *handler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case h.err = <-done:
			status <- svc.Status{State: svc.StopPending}
			// The agent ends by itself only on a failure or an outside signal.
			// A non-zero exit lets the recovery actions restart it either way.
			return true, 1
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				h.err = <-done
				return false, 0
			}
		}
	}
}
