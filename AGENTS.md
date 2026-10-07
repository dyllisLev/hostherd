# Contributor guide

Notes for people and coding agents working on Hostherd. User documentation is in `README.md` and `docs/`.

## Layout

- `apps/server`: central server (Node.js, TypeScript). Web API, MCP endpoint (`src/mcp.ts`), agent WebSocket hub (`src/hub.ts`), SQLite store, approvals, metrics, notifications. Tests in `apps/server/test`.
- `apps/web`: web console (React, Vite). UI strings live in `src/i18n/en.ts` and `src/i18n/ko.ts`.
- `agent`: Go agent (module `hostherd/agent`, binary `cmd/hostherd`). One executable is the communication agent, the job runner, and the installer/updater. See `agent/README.md` and `agent/internal/install/README.md`.
- `scripts`: release build (`build-release.mjs`, used by the Dockerfile), integration and browser tests.

## Commands

Run from the repository root unless noted:

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Agent tests (Go toolchain from `agent/go.mod`):

```sh
cd agent && go test ./...
```

Integration test against a real agent binary:

```sh
(cd agent && CGO_ENABLED=0 go build -o /tmp/hostherd-agent ./cmd/hostherd)
AGENT_BINARY=/tmp/hostherd-agent npm run test:integration
```

CI also runs `gofmt -l`, `go vet ./...` and cross-compiles the agent for Linux, macOS and Windows on amd64 and arm64.

## Rules

- Every user-facing string in the web console goes through both `en.ts` and `ko.ts`.
- API errors are JSON `{ code, error, params? }`. `error` is English; the web console translates by `code` (the `errors` section of the dictionaries), using `params` for placeholders.
- When you change the protocol between the central server and the agent, update the central server, the agent and the web console together.
- Stopping or restarting the communication agent must not stop runners, jobs or terminals.
- Job output is deleted on the target only after the central server has confirmed it is stored.
- Commands, file operations and terminals run with the real permissions of the server's registered OS account. Do not add paths that bypass it.
- Never put credentials, tokens or signing private keys in the repository, the image or logs.
