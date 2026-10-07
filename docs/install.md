# Installing Hostherd

[한국어](ko/install.md)

This guide sets up the Hostherd central server with Docker Compose behind HTTPS, then connects your first server and an MCP client. The standard setup in `compose.yaml` includes an optional Caddy proxy that obtains the certificate for you; you can use your own reverse proxy instead.

## Requirements

**Central server**

- A Linux host (amd64 or arm64) with [Docker Engine](https://docs.docker.com/engine/install/) and the Compose plugin (`docker compose version` should work).
- A domain name pointing at that host, for example `hostherd.example.com`.
- HTTPS in front of Hostherd. Hostherd itself speaks plain HTTP on `127.0.0.1:3000` and refuses to start unless `PUBLIC_URL` is `https://`. Either use the bundled Caddy proxy (default, step 4A) or your own reverse proxy (step 4B).
- Inbound TCP 443 (and 80 for certificate issuance) open to the browsers, MCP clients and target servers that will use it. Port 3000 should stay closed to the outside.

**Target servers**

- Linux with systemd, macOS, or Windows 10 1809 / Server 2019 or later; amd64 or arm64.
- Outbound HTTPS to `PUBLIC_URL`. No inbound ports.
- Linux: `curl` and an OpenSSL with Ed25519 support (any current distribution).
- macOS: OpenSSL 3 from Homebrew (`brew install openssl@3`), because the built-in LibreSSL cannot verify the signed release.

## 1. Prepare a directory

```sh
mkdir -p /opt/hostherd && cd /opt/hostherd
curl -fsSLO https://raw.githubusercontent.com/dyllislev/hostherd/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/dyllislev/hostherd/main/Caddyfile
curl -fsSL https://raw.githubusercontent.com/dyllislev/hostherd/main/.env.example -o .env
```

`compose.yaml` is the standard setup and explains every setting in comments. `Caddyfile` is only used by the bundled proxy.

## 2. Configure `.env`

Open `.env` and set at least `PUBLIC_URL`:

```sh
PUBLIC_URL=https://hostherd.example.com
```

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `caddy` | `caddy` runs the bundled HTTPS proxy (step 4A). Leave it empty when you use your own reverse proxy (step 4B). |
| `PUBLIC_URL` | (required) | The HTTPS address users, MCP clients and agents use. It must match exactly what the browser shows (scheme and host, no trailing slash); requests from another origin are rejected. |
| `HOSTHERD_VERSION` | `latest` | Image tag. Set a version such as `0.1.0` to pin it. |
| `HOSTHERD_BIND` | `127.0.0.1` | Host address the container port is published on. |
| `HOSTHERD_PORT` | `3000` | Host port the reverse proxy connects to. |
| `TRUST_PROXY` | `1` | Which proxies to trust for the client IP address (see below). |

Inside the container Hostherd listens on port 3000 and keeps its data in `/data`, which is the named Docker volume `hostherd-data`. You do not need to set `PORT`, `HOST` or `DATA_DIR`.

### TRUST_PROXY

Hostherd takes the client address from `X-Forwarded-For`, and the login rate limit is based on it. Tell it how many proxies sit in front:

- `1` (default): one reverse proxy, as in this guide.
- `2`, `3`, …: a chain of proxies, for example a CDN in front of your reverse proxy.
- A comma-separated list of proxy addresses or subnets, for example `127.0.0.1,172.16.0.0/12`.
- `false`: nothing in front (not recommended, since HTTPS is required).

If the value is too high, clients can spoof their address; if it is too low, all clients appear to come from the proxy and share one rate limit.

## 3. Start the central server

```sh
docker compose up -d
docker compose ps        # STATUS should become "healthy"
```

On the first start Hostherd prints a one-time setup token:

```sh
docker compose logs hostherd | grep "setup token"
```

The token is also stored in the data volume as `setup-token` and is deleted once the admin account exists.

## 4. HTTPS

### 4A. Bundled Caddy (default)

With `COMPOSE_PROFILES=caddy`, `docker compose up -d` also starts Caddy. It serves `PUBLIC_URL`, obtains and renews a Let's Encrypt certificate, redirects HTTP to HTTPS and passes WebSockets, streaming and headers to Hostherd. You only need:

- a DNS record for the host in `PUBLIC_URL` pointing at this server,
- ports 80 and 443 free on this host and reachable from the internet (80 is used for certificate issuance).

Check the certificate and the proxy:

```sh
docker compose logs caddy | grep -i certificate
curl https://hostherd.example.com/healthz
```

Certificates are kept in the `hostherd-caddy-data` volume. To use your own Caddy options (for example an internal CA or a DNS challenge), edit `Caddyfile` and run `docker compose restart caddy`.

### 4B. Your own reverse proxy

Set `COMPOSE_PROFILES=` (empty) in `.env` and run `docker compose up -d` again; only Hostherd runs and listens on `127.0.0.1:3000`.

The proxy forwards everything to `127.0.0.1:3000`. These paths need special handling, and a catch-all rule covers them as long as WebSockets and streaming work:

- `/agent`: WebSocket used by agents.
- `/terminal/<id>`: WebSocket used by web terminals.
- `/api/events`: server-sent events for live updates (do not buffer).

Pass `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. Use long read timeouts so idle terminals stay connected. The proxy must also forward the `Authorization` header on WebSocket upgrades: agents authenticate with it. Some proxies drop it by default (for example Zoraxy, until custom WebSocket headers are enabled for the route); agents then log `central handshake HTTP 401`.

#### Caddy on the host

Caddy obtains certificates automatically and handles WebSockets and streaming without extra settings.

```caddyfile
hostherd.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

#### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name hostherd.example.com;

    ssl_certificate     /etc/letsencrypt/live/hostherd.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hostherd.example.com/privkey.pem;

    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}

server {
    listen 80;
    server_name hostherd.example.com;
    return 301 https://$host$request_uri;
}
```

Obtain the certificate with your usual tool (for example `certbot --nginx`). If your proxy runs in a container instead of on the host, either put it on the same Docker network and proxy to `http://hostherd:3000`, or keep the published port and proxy to the host address.

Check it from outside:

```sh
curl https://hostherd.example.com/healthz
# {"status":"ok","version":"…","commit":"…"}
```

## 5. Create the admin account

Open `PUBLIC_URL` in a browser, enter the setup token, and choose the admin username and password. There is a single admin account; it is also the account you sign in with when an MCP client connects through OAuth.

## 6. Add a server

1. In the web console go to **Servers → Add server**, give the server a name and select **Get install command**. The enrollment code in it works once and expires.
2. Run the command on the target server:
   - **Linux and macOS**: in a terminal, as the account the agent should act as, run the command as shown (it uses `sudo`). On macOS run `brew install openssl@3` in the same terminal first.
   - **Windows**: run the command from the **Windows** tab in an **Administrator PowerShell**.
3. The page shows the server as connected within a few seconds.

**Which OS account runs commands.** Commands, file operations and terminals run with the real permissions of one OS account per server:

- Linux and macOS: if a regular user runs the command with `sudo`, that user is registered. If you run it directly from a root shell, commands run as root.
- Windows: the account that opened the Administrator PowerShell is registered. Scheduled tasks are not subject to UAC, so this account runs with full administrator rights. Tick **Run as SYSTEM** to run as SYSTEM instead.

Register servers with a regular account when you want the operating system, not Hostherd, to limit what an AI can do.

The agent itself runs as a system service (`hostherd-agent` on Linux, `io.hostherd.agent` on macOS, `HostherdAgent` on Windows) and reconnects automatically. Restarting or updating the agent does not stop running jobs or terminals.

## 7. Connect an MCP client

The MCP address is `<PUBLIC_URL>/mcp`, for example `https://hostherd.example.com/mcp`. **Settings → MCP** in the web console shows the exact steps and configuration snippets for each client.

- **ChatGPT**: enable developer mode in the connector settings, create a connector with the MCP URL and choose OAuth. Sign in with the Hostherd admin account and approve access.
- **Claude (desktop and web)**: add a custom connector with the MCP URL, then sign in and approve.
- **Claude Code**: `claude mcp add --transport http hostherd https://hostherd.example.com/mcp`, then run `/mcp` in Claude Code to sign in.
- **Cursor, VS Code and other clients**: use OAuth if the client supports it. Otherwise issue a token in **Settings → Personal tokens** and send it as `Authorization: Bearer <token>`.

A connected client can reach every registered server. Approved OAuth apps and tokens can be revoked in **Settings** at any time.

Next: [Operations](operations.md).
