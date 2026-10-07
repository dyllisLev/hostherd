# Operating Hostherd

[한국어](ko/operations.md)

Commands below run in the directory that holds `compose.yaml` and `.env` (for example `/opt/hostherd`).

## Updating the central server

```sh
docker compose pull
docker compose up -d
docker compose ps          # wait for "healthy"
curl -s https://hostherd.example.com/healthz
```

The web console and MCP are unavailable for a few seconds while the container is replaced. Agents reconnect on their own, and jobs and terminals that were running on target servers keep running. `docker compose pull` also updates the bundled Caddy image when it is enabled. Pin a version with `HOSTHERD_VERSION` in `.env` if you prefer to update deliberately. Database changes are applied on start; take a [backup](#backup-and-restore) first if you may want to go back to an older version.

## Updating agents

Each central image contains the matching signed agent release. When an agent is behind, the server list marks it, and you can update it from the server's menu (**Update agent**) or update several at once with **Update all**. The agent downloads the new binary from the central server, checks its signature against the key it was installed with, and restarts itself. Running jobs and terminals stay on the previous runner until they finish.

## Backup and restore

All state lives in the `hostherd-data` volume: the SQLite databases, OAuth keys, tokens, job output and pending file transfers. The simplest consistent backup stops the container for a moment:

```sh
mkdir -p -m 700 backups
docker compose stop
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" hostherd \
  tar -czf /backup/hostherd-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
docker compose start
```

Agents reconnect after the restart, and remote jobs keep running meanwhile. Keep backups somewhere private: they contain credentials. The bundled Caddy's certificates (`hostherd-caddy-data`) need no backup; Caddy obtains them again.

To restore, stop the container, replace the volume contents, and start it again:

```sh
docker compose stop
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" hostherd \
  sh -c 'find /data -mindepth 1 -delete && tar -xzf /backup/hostherd-YYYYMMDD-HHMMSS.tar.gz -C /data --same-owner'
docker compose start
```

Restore with the same or a newer Hostherd version than the one that made the backup.

## Data retention

| Data | Kept for |
|---|---|
| Finished jobs and their output | 30 days (running jobs and terminals are never removed) |
| MCP request log | 30 days |
| Approval history | 30 days |
| Resource metrics | raw samples 48 hours, 5-minute summaries 35 days, hourly summaries 400 days |
| Download links created by `file_download` | 1 hour after completion |

## Using Hostherd from an AI client

Once a client is connected (see [install.md](install.md#7-connect-an-mcp-client)), ask it in plain language, for example "check disk usage on web-prod-1" or "show me the last 50 lines of the nginx error log". The client picks the tools below. Every call runs on the target server as that server's registered OS account and appears in **Request logs**; commands also appear in **Jobs**.

| Tool | What it does |
|---|---|
| `servers_list` | Lists registered servers with their IDs, OS, run-as account, connection status and latest CPU, memory, disk and load. |
| `server_metrics` | Latest resource sample and a summary over 1 hour to 30 days. |
| `job_start` | Runs a shell command in a working directory with the account's login shell (PowerShell on Windows) and returns a job ID and the first output. Jobs keep running after the call returns and have no default time limit. |
| `jobs_list`, `job_status`, `job_output` | Lists jobs, reads a job's state, and pages through its full saved output with a cursor. |
| `job_input`, `job_cancel` | Writes to a running job's standard input (optionally closing it), or stops a job and its child processes. |
| `file_list`, `file_read`, `file_search` | Lists a directory, reads a file page by page (text, or base64 for binary files), and searches text recursively. |
| `file_write`, `file_edit`, `file_delete` | Creates or replaces a file, replaces exactly one occurrence of a text, or deletes a file or directory. |
| `image_read` | Returns a saved PNG or JPEG file as an image the AI can see, for example a screenshot taken with a headless browser through `job_start`. |
| `file_upload`, `file_download`, `file_transfer_status`, `file_transfer_cancel` | Sends a file attached in ChatGPT to a server, creates a download link (valid for 1 hour) for a server file, tracks large transfers and cancels them. |

When a call matches a **Confirm** rule (see [Command approvals](#command-approvals)), it does not run. The AI gets an `APPROVAL_REQUIRED` result with an approval link and is told to show you the link and retry the identical call after you approve. Clients that support MCP elicitation instead ask you directly with **Allow once**, **Always allow** and **Deny**. A denied call returns `APPROVAL_DENIED` and a call matching a **Block** rule returns `COMMAND_BLOCKED`; in both cases the AI is told not to retry or work around it.

## Command approvals

**Approvals** lets risky MCP calls wait for a human. Built-in rules cover deletes (`rm`, `Remove-Item`, `file_delete`, …), overwrites (redirection, `file_write` replacing a file, `sed -i`, …), disk formatting, shutdown and reboot, Docker and package removal, and more. Each rule is set to **Confirm**, **Allow** or **Block**, and you can add your own rules by command prefix or regular expression. Deletes and overwrites entirely inside an **allowed folder** run without asking.

When a call needs confirmation, the AI receives an approval link. Choose **Allow once**, **Always allow** or **Deny** in the web console (or open the link from a webhook notification), then the AI retries the same call. An approval expires if it is not used within 30 minutes. The **Command approval** switch at the top of the page turns all checks off and on without losing your rules.

Approvals analyze command text to catch mistakes. They are not a security boundary and can be bypassed. To actually limit what an AI can do on a server, register that server with a regular OS account.

## Webhooks

**Settings → Notifications** sends events to Slack, Discord, Telegram or any URL that accepts a JSON `POST`:

- approval requested
- server disconnected for more than 2 minutes, and reconnected
- agent fault reported
- CPU, memory or disk usage at 90% or more
- job failed

For generic webhooks you can set a signing secret; Hostherd then sends `X-Hostherd-Signature: sha256=<HMAC-SHA256 of the body>`. Use **Test** to check delivery.

## Uninstalling an agent

In the web console, choose **Remove server** from the server's menu and select **Also uninstall the agent from the server**. This removes the service, runners, configuration, job records and binaries on the target, and stops its running jobs and terminals. The option needs the server to be online. If removal fails, the registration is still deleted and the console shows the manual commands.

To remove an agent by hand (for example an offline server), remove the server in the web console, stop its running jobs and terminals, and run on the target:

Linux:

```sh
sudo systemctl stop hostherd-agent.service 'hostherd-runner-*.service'
sudo rm -f /etc/systemd/system/hostherd-agent.service /etc/systemd/system/hostherd-runner-*.service /etc/systemd/system/multi-user.target.wants/hostherd-*.service
sudo systemctl daemon-reload
sudo rm -rf /etc/hostherd /var/lib/hostherd /opt/hostherd
```

macOS:

```sh
sudo launchctl bootout system/io.hostherd.agent
for f in /Library/LaunchDaemons/io.hostherd.runner.*.plist; do sudo launchctl bootout "system/$(basename "$f" .plist)"; done
sudo rm -f /Library/LaunchDaemons/io.hostherd.agent.plist /Library/LaunchDaemons/io.hostherd.runner.*.plist
sudo rm -rf /etc/hostherd /var/lib/hostherd /opt/hostherd
```

Windows (Administrator PowerShell):

```powershell
Stop-Service HostherdAgent; sc.exe delete HostherdAgent
Get-ScheduledTask -TaskPath '\Hostherd\' | ForEach-Object { Stop-ScheduledTask -InputObject $_; Unregister-ScheduledTask -InputObject $_ -Confirm:$false }
Remove-Item -Recurse -Force "$env:ProgramData\Hostherd", "$env:ProgramFiles\Hostherd"
```

A server can only be registered again after its existing agent has been removed; otherwise the installer stops with `already enrolled`.

## Troubleshooting

### Central server

```sh
docker compose ps
docker compose logs --tail 200 hostherd
curl -s http://127.0.0.1:3000/healthz
```

- **Container exits with `PUBLIC_URL must use HTTPS`**: set an `https://` address in `.env`.
- **Login or saving fails with an origin error**: `PUBLIC_URL` must match the address in the browser exactly, and the proxy must pass `Host` and `X-Forwarded-Proto`.
- **Terminals or live updates do not work, agents connect and drop**: the reverse proxy is not passing WebSocket upgrades for `/agent` and `/terminal/…`, or is buffering `/api/events`. See [install.md](install.md#4-https).
- **No HTTPS with the bundled Caddy**: `docker compose logs caddy` shows why the certificate was not issued. Usually the DNS record does not point at this host yet, or ports 80/443 are blocked or used by another service.

### Agent offline

The server detail page shows status and restart commands for an offline server. Run them on the target (through SSH or your provider's console if the network is down). Restarting the agent does not stop running jobs or terminals.

| OS | Status and logs | Restart |
|---|---|---|
| Linux | `sudo systemctl status hostherd-agent --no-pager`<br>`sudo journalctl -u hostherd-agent -n 50 --no-pager` | `sudo systemctl restart hostherd-agent` |
| macOS | `sudo launchctl print system/io.hostherd.agent` (state and last exit code; there is no log file) | `sudo launchctl kickstart -k system/io.hostherd.agent`, or if it was unloaded `sudo launchctl bootstrap system /Library/LaunchDaemons/io.hostherd.agent.plist` |
| Windows (Administrator PowerShell) | `Get-Service HostherdAgent` and Service Control Manager events in the System event log | `Restart-Service HostherdAgent` |

Agent files: Linux and macOS keep configuration in `/etc/hostherd`, job records in `/var/lib/hostherd` and binaries in `/opt/hostherd`. Windows keeps binaries in `C:\Program Files\Hostherd` and configuration and job records in `C:\ProgramData\Hostherd`.

Also check that the target can reach `PUBLIC_URL` over HTTPS (`curl -sI https://hostherd.example.com/healthz`) and that its clock is correct.

## Building your own image

The official image's agents are signed with the publisher's key. To build and sign your own, create an Ed25519 key and keep it private and backed up:

```sh
openssl genpkey -algorithm ed25519 -out hostherd-signing.pem
chmod 600 hostherd-signing.pem
export AGENT_SIGNING_KEY_B64=$(base64 < hostherd-signing.pem | tr -d '\n')

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --secret id=AGENT_SIGNING_KEY_B64,env=AGENT_SIGNING_KEY_B64 \
  --build-arg APP_COMMIT=$(git rev-parse HEAD) \
  -t registry.example.com/hostherd:custom --push .
```

For a single-architecture image on the build machine, drop `--platform` and replace `--push` with `--load`. The build runs the type check and all tests, then compiles and signs the agents for Linux, macOS and Windows. The key is passed as a BuildKit secret and is not stored in the image; only the public key is published at `<PUBLIC_URL>/downloads/release.pub`.

Agents trust the public key they were installed with and only accept updates signed by it. If you switch an existing installation between the official image and your own (or change keys), installed agents will refuse updates: keep using the same key, or uninstall and reinstall the agents. Set `image:` in `compose.yaml` to your image.
