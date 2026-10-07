package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"hostherd/agent/internal/agent"
	"hostherd/agent/internal/config"
	"hostherd/agent/internal/install"
	"hostherd/agent/internal/platform"
	"hostherd/agent/internal/runner"
)

var version = "0.1.0"

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: hostherd {agent|runner|install|update|uninstall|version}")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	args := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
	switch os.Args[1] {
	case "version", "--version":
		fmt.Println(version)
		return nil
	case "agent":
		path := args.String("config", config.DefaultPath, "root-owned agent configuration")
		if err := args.Parse(os.Args[2:]); err != nil {
			return err
		}
		return runAsService(ctx, func(ctx context.Context) error { return agent.Run(ctx, *path, version) })
	case "runner":
		root := args.String("state-dir", config.DefaultStateDir, "runtime data directory")
		generation := args.String("generation", version, "runner generation")
		if err := args.Parse(os.Args[2:]); err != nil {
			return err
		}
		platform.SetCommandUmask()
		r, err := runner.New(*root, *generation, version)
		if err != nil {
			return err
		}
		return r.Serve(ctx)
	case "install":
		url := args.String("url", "", "central HTTPS URL")
		code := args.String("code", "", "one-time enrollment code")
		binary := args.String("binary", "", "verified binary path")
		system := args.Bool("system", false, "Windows: run commands as SYSTEM instead of the installing user")
		if err := args.Parse(os.Args[2:]); err != nil {
			return err
		}
		if *binary == "" {
			executable, err := os.Executable()
			if err != nil {
				return err
			}
			*binary = executable
		}
		return install.Install(ctx, *url, *code, *binary, install.Options{System: *system})
	case "update":
		path := args.String("config", config.DefaultPath, "root-owned agent configuration")
		manifest := args.String("manifest-url", "", "signed manifest URL")
		if err := args.Parse(os.Args[2:]); err != nil {
			return err
		}
		return install.Update(ctx, *path, *manifest)
	case "uninstall":
		path := args.String("config", config.DefaultPath, "root-owned agent configuration")
		if err := args.Parse(os.Args[2:]); err != nil {
			return err
		}
		return install.Uninstall(ctx, *path)
	default:
		return fmt.Errorf("unknown mode %q", os.Args[1])
	}
}
