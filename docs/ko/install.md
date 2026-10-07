# Hostherd 설치

[English](../install.md)

이 문서는 Hostherd 중앙 서버를 HTTPS 리버스 프록시 뒤에서 Docker Compose로 실행하고, 첫 서버와 MCP 클라이언트를 연결하는 과정을 설명합니다.

## 요구 사항

**중앙 서버**

- [Docker Engine](https://docs.docker.com/engine/install/)과 Compose 플러그인이 설치된 Linux 호스트(amd64 또는 arm64). `docker compose version`이 동작해야 합니다.
- 그 호스트를 가리키는 도메인. 예: `hostherd.example.com`
- 같은 호스트의 HTTPS 리버스 프록시. Hostherd는 `127.0.0.1:3000`에서 일반 HTTP로 동작하며, `PUBLIC_URL`이 `https://`가 아니면 시작하지 않습니다. 프록시는 WebSocket 업그레이드를 전달하고 스트리밍 응답을 버퍼링하지 않아야 합니다. Caddy와 nginx 예시는 아래에 있습니다.
- 사용할 브라우저·MCP 클라이언트·대상 서버에서 들어오는 TCP 443(인증서 발급용 80 포함). 3000 포트는 외부에 열지 않습니다.

**대상 서버**

- systemd를 쓰는 Linux, macOS, 또는 Windows 10 1809·Server 2019 이상. amd64 또는 arm64.
- `PUBLIC_URL`로 나가는 HTTPS 연결. 들어오는 포트는 필요 없습니다.
- Linux: `curl`과 Ed25519를 지원하는 OpenSSL(현재 배포판이면 모두 해당).
- macOS: Homebrew의 OpenSSL 3(`brew install openssl@3`). 기본 LibreSSL로는 서명된 릴리스를 검증할 수 없습니다.

## 1. 디렉터리 준비

```sh
mkdir -p /opt/hostherd && cd /opt/hostherd
curl -fsSLO https://raw.githubusercontent.com/dyllislev/hostherd/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/dyllislev/hostherd/main/.env.example -o .env
```

## 2. `.env` 설정

`.env`를 열어 최소한 `PUBLIC_URL`을 지정합니다.

```sh
PUBLIC_URL=https://hostherd.example.com
```

| 변수 | 기본값 | 의미 |
|---|---|---|
| `PUBLIC_URL` | (필수) | 사용자·MCP 클라이언트·에이전트가 쓰는 HTTPS 주소. 브라우저에 보이는 주소(스킴과 호스트, 끝의 `/` 없이)와 정확히 같아야 하며, 다른 출처의 요청은 거부됩니다. |
| `HOSTHERD_VERSION` | `latest` | 이미지 태그. `0.1.0`처럼 버전을 지정해 고정할 수 있습니다. |
| `HOSTHERD_BIND` | `127.0.0.1` | 컨테이너 포트를 게시할 호스트 주소. |
| `HOSTHERD_PORT` | `3000` | 리버스 프록시가 연결할 호스트 포트. |
| `TRUST_PROXY` | `1` | 클라이언트 IP 주소를 정할 때 신뢰할 프록시(아래 참고). |

컨테이너 안에서 Hostherd는 3000 포트로 동작하고 데이터는 `/data`, 즉 Docker 이름 있는 볼륨 `hostherd-data`에 둡니다. `PORT`, `HOST`, `DATA_DIR`은 지정할 필요가 없습니다.

### TRUST_PROXY

Hostherd는 클라이언트 주소를 `X-Forwarded-For`에서 얻고, 로그인 시도 제한이 이 주소를 기준으로 합니다. 앞에 있는 프록시 수를 알려 줍니다.

- `1`(기본값): 이 문서처럼 리버스 프록시 하나.
- `2`, `3`, …: 리버스 프록시 앞에 CDN이 있는 경우처럼 여러 단계의 프록시.
- 쉼표로 구분한 프록시 주소나 서브넷 목록. 예: `127.0.0.1,172.16.0.0/12`
- `false`: 앞에 아무것도 없음(HTTPS가 필요하므로 권장하지 않음).

값이 너무 크면 클라이언트가 주소를 속일 수 있고, 너무 작으면 모든 클라이언트가 프록시 주소로 보여 같은 시도 제한을 공유합니다.

## 3. 중앙 서버 시작

```sh
docker compose up -d
docker compose ps        # STATUS가 "healthy"가 되어야 합니다
```

처음 시작할 때 Hostherd가 한 번만 쓰는 초기 설정 코드를 출력합니다.

```sh
docker compose logs hostherd | grep "setup token"
```

이 코드는 데이터 볼륨의 `setup-token` 파일에도 저장되며, 관리자 계정을 만들면 삭제됩니다.

## 4. 리버스 프록시 설정

프록시는 모든 요청을 `127.0.0.1:3000`으로 전달합니다. 아래 경로는 별도 처리가 필요하지만, WebSocket과 스트리밍이 동작하면 전체 전달 규칙 하나로 충분합니다.

- `/agent`: 에이전트가 쓰는 WebSocket
- `/terminal/<id>`: 웹 터미널이 쓰는 WebSocket
- `/api/events`: 실시간 갱신용 server-sent events(버퍼링하지 않음)

`Host`, `X-Forwarded-For`, `X-Forwarded-Proto`를 전달합니다. 쉬고 있는 터미널이 끊기지 않도록 읽기 시간 제한을 길게 둡니다. WebSocket 업그레이드 요청의 `Authorization` 헤더도 전달해야 합니다. 에이전트가 이 헤더로 인증합니다. 기본으로 이 헤더를 빼는 프록시가 있으며(예: Zoraxy는 경로에서 WebSocket 사용자 지정 헤더를 켜기 전까지), 이때 에이전트 로그에 `central handshake HTTP 401`이 남습니다.

### Caddy

Caddy는 인증서를 자동으로 발급하며 WebSocket과 스트리밍도 추가 설정 없이 처리합니다.

```caddyfile
hostherd.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

### nginx

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

인증서는 평소 쓰는 도구(예: `certbot --nginx`)로 발급합니다. 프록시가 호스트가 아니라 컨테이너에서 돈다면, 같은 Docker 네트워크에 두고 `http://hostherd:3000`으로 전달하거나, 게시한 포트를 유지하고 호스트 주소로 전달합니다.

외부에서 확인합니다.

```sh
curl https://hostherd.example.com/healthz
# {"status":"ok","version":"…","commit":"…"}
```

## 5. 관리자 계정 만들기

브라우저에서 `PUBLIC_URL`을 열고 초기 설정 코드를 입력한 뒤 관리자 사용자 이름과 비밀번호를 정합니다. 관리자 계정은 하나이며, MCP 클라이언트가 OAuth로 연결할 때도 이 계정으로 로그인합니다.

## 6. 서버 추가

1. 웹 콘솔의 **서버 → 서버 등록**에서 서버 이름을 정하고 **설치 명령 발급**을 누릅니다. 명령에 든 등록 코드는 한 번만 쓸 수 있고 기한이 지나면 만료됩니다.
2. 대상 서버에서 명령을 실행합니다.
   - **Linux·macOS**: 에이전트가 동작할 계정의 터미널에서 명령을 그대로 실행합니다(`sudo`를 사용합니다). macOS는 먼저 같은 터미널에서 `brew install openssl@3`를 실행합니다.
   - **Windows**: **Windows** 탭의 명령을 **관리자 권한 PowerShell**에서 실행합니다.
3. 몇 초 안에 화면에 연결됨으로 표시됩니다.

**명령을 실행하는 OS 계정.** 명령·파일 작업·터미널은 서버마다 하나의 OS 계정이 가진 실제 권한으로 실행됩니다.

- Linux·macOS: 일반 사용자가 `sudo`로 실행하면 그 사용자가 등록됩니다. root 셸에서 직접 실행하면 root로 실행됩니다.
- Windows: 관리자 권한 PowerShell을 연 계정이 등록됩니다. 예약 작업에는 UAC가 적용되지 않으므로 이 계정은 관리자 권한 전체로 실행됩니다. **SYSTEM 권한으로 실행**을 선택하면 SYSTEM으로 실행됩니다.

AI가 할 수 있는 일을 Hostherd가 아니라 운영체제가 제한하게 하려면 서버를 일반 계정으로 등록합니다.

에이전트 자체는 시스템 서비스(Linux `hostherd-agent`, macOS `io.hostherd.agent`, Windows `HostherdAgent`)로 동작하며 자동으로 다시 연결합니다. 에이전트를 재시작하거나 업데이트해도 실행 중인 작업과 터미널은 멈추지 않습니다.

## 7. MCP 클라이언트 연결

MCP 주소는 `<PUBLIC_URL>/mcp`입니다. 예: `https://hostherd.example.com/mcp`. 클라이언트별 정확한 절차와 설정 예시는 웹 콘솔의 **설정 → MCP 연결**에 있습니다.

- **ChatGPT**: 커넥터 설정에서 개발자 모드를 켜고 MCP 주소로 커넥터를 만든 뒤 인증 방식으로 OAuth를 고릅니다. Hostherd 관리자 계정으로 로그인해 접근을 승인합니다.
- **Claude(데스크톱·웹)**: MCP 주소로 사용자 지정 커넥터를 추가하고 로그인해 승인합니다.
- **Claude Code**: `claude mcp add --transport http hostherd https://hostherd.example.com/mcp`를 실행한 뒤 Claude Code에서 `/mcp`로 로그인합니다.
- **Cursor, VS Code 등**: 클라이언트가 지원하면 OAuth를 씁니다. 지원하지 않으면 **설정 → 개인 토큰**에서 토큰을 발급해 `Authorization: Bearer <token>`으로 보냅니다.

연결된 클라이언트는 등록된 모든 서버에 접근할 수 있습니다. 승인한 OAuth 앱과 토큰은 **설정**에서 언제든 폐기할 수 있습니다.

다음: [운영](operations.md)
