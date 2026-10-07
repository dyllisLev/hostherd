# Hostherd native agent

One Go executable provides a root communication agent, independent execution
runner generations, and the privileged installer/updater. Linux, macOS and
Windows amd64/arm64 are supported. OS-specific process/PTY code lives in `internal/platform`, service
installation in `internal/install`; the JSON protocol has no service-manager dependency.

Build a local, unsigned binary with `CGO_ENABLED=0 go build -o hostherd ./cmd/hostherd`
within `agent/`. Signed release binaries, the manifest and the bootstrap scripts
come from `scripts/build-release.mjs`, which the container image build runs.
Run `go test -race ./...` and `go vet ./...` within `agent/`.

For a local integration environment, run these as separate processes:

```sh
hostherd runner --state-dir /tmp/hostherd-test/runtime --generation 0.1.0
hostherd agent --config /tmp/hostherd-test/config.json
```

The config uses `url`, `token`, `serverId`, `executionUser`, `stateDir`,
`generation`, `version`, `publicKey` (PEM), and `installDir`. Local integration
may omit `publicKey` and `installDir`; the production installer provides both.
The communication process verifies runner readiness before announcing its local
ready marker, and then reconnects to the central service independently of jobs.
Runtime Unix sockets use `stateDir/runners/generation/runner.sock` and mode 0600.

Ordinary jobs use a separate process group and a merged stdout/stderr pipe.
A job ends 2 seconds after its shell exits even if a background child still
holds the output (Linux terminals likewise); output written until then is kept
and later output of that child is discarded. Commands, terminals and files use
umask 022; runtime state is created with explicit private modes.
`path` is an absolute working directory for each job; shell state does not carry
between jobs. PTYs run the account's login shell, keep its state until explicit
close, and accept native terminal control characters and resize operations.
The installer runs the entire runtime as the enrolled account, so commands,
files and terminal operations share its real OS permissions. The communication
agent alone can read the root-owned enrollment token.

All runner generations share a job-ID acceptance journal. A repeated ID with
the same inputs returns the existing job; changed inputs produce an ID conflict.
Accepted jobs are never restarted automatically. A runner restarted after a
failure marks the records it was running interrupted; missing runners are
reported as faults without claiming that all remote processes stopped.

Output is stored in 64 KiB disk segments with durable byte counters. Transmission
uses at most 64 KiB per chunk and waits for the central durable ACK before
advancing each stream. ACKed full segments are deleted; a growing partial segment
remains until full or closed. Capturing output uses a fixed buffer. A temporary
storage failure blocks capture and reports a fault instead of discarding data.
No application limit is imposed on output size, job count, or terminal count.

Completed job and closed terminal records expire after 30 days only if all output
has been centrally acknowledged. Running sessions and unacknowledged output are
retained. Small expired-ID tombstones prevent those IDs from starting again and
do not retain the expired command, result, or output. Central retention is
implemented separately by the central service.

See [installer and release format](internal/install/README.md) and
[file RPC behavior](internal/files/README.md) for their exact contracts.
