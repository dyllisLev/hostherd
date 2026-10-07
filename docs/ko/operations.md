# Hostherd 운영

[English](../operations.md)

아래 명령은 `compose.yaml`과 `.env`가 있는 디렉터리(예: `/opt/hostherd`)에서 실행합니다.

## 중앙 서버 업데이트

```sh
docker compose pull
docker compose up -d
docker compose ps          # "healthy"가 될 때까지 기다립니다
curl -s https://hostherd.example.com/healthz
```

컨테이너를 교체하는 몇 초 동안 웹 콘솔과 MCP를 쓸 수 없습니다. 에이전트는 스스로 다시 연결하며, 대상 서버에서 실행 중이던 작업과 터미널은 계속 실행됩니다. 함께 들어 있는 Caddy를 쓰면 `docker compose pull`이 Caddy 이미지도 함께 업데이트합니다. 업데이트 시점을 직접 정하려면 `.env`의 `HOSTHERD_VERSION`으로 버전을 고정합니다. 데이터베이스 변경은 시작할 때 적용되므로, 이전 버전으로 되돌릴 가능성이 있으면 먼저 [백업](#백업과-복원)합니다.

## 에이전트 업데이트

중앙 이미지마다 그에 맞는 서명된 에이전트 릴리스가 들어 있습니다. 새 에이전트가 있으면 서버 목록에 표시되며, 서버 메뉴의 **에이전트 업데이트**로 하나씩, **일괄 업데이트**로 여러 대를 한꺼번에 업데이트할 수 있습니다. 에이전트는 중앙에서 새 실행 파일을 받아, 설치할 때 받은 키로 서명을 확인한 뒤 스스로 재시작합니다. 실행 중인 작업과 터미널은 끝날 때까지 이전 실행기에서 유지됩니다.

## 백업과 복원

모든 상태는 `hostherd-data` 볼륨에 있습니다. SQLite 데이터베이스, OAuth 키, 토큰, 작업 출력, 진행 중인 파일 전송이 포함됩니다. 가장 간단하게 일관된 백업을 만드는 방법은 컨테이너를 잠시 멈추는 것입니다.

```sh
mkdir -p -m 700 backups
docker compose stop
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" hostherd \
  tar -czf /backup/hostherd-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
docker compose start
```

재시작 후 에이전트는 다시 연결하고, 그동안에도 원격 작업은 계속 실행됩니다. 백업에는 자격 증명이 들어 있으므로 안전한 곳에 보관합니다. 함께 들어 있는 Caddy의 인증서(`hostherd-caddy-data`)는 Caddy가 다시 발급하므로 백업할 필요가 없습니다.

복원할 때는 컨테이너를 멈추고 볼륨 내용을 바꾼 뒤 다시 시작합니다.

```sh
docker compose stop
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" hostherd \
  sh -c 'find /data -mindepth 1 -delete && tar -xzf /backup/hostherd-YYYYMMDD-HHMMSS.tar.gz -C /data --same-owner'
docker compose start
```

백업을 만든 버전과 같거나 더 새로운 Hostherd 버전으로 복원합니다.

## 데이터 보관 기간

| 데이터 | 보관 기간 |
|---|---|
| 끝난 작업과 출력 | 30일(실행 중인 작업과 터미널은 지우지 않음) |
| MCP 요청 로그 | 30일 |
| 승인 처리 기록 | 30일 |
| 리소스 지표 | 원본 48시간, 5분 요약 35일, 1시간 요약 400일 |
| `file_download`가 만든 다운로드 링크 | 완료 후 1시간 |

## AI 클라이언트에서 사용하기

클라이언트를 연결한 뒤([install.md](install.md#7-mcp-클라이언트-연결) 참고) "web-prod-1의 디스크 사용량 확인해 줘", "nginx 오류 로그 마지막 50줄 보여 줘"처럼 평소 말로 요청하면 클라이언트가 아래 도구를 골라 씁니다. 모든 호출은 대상 서버에 등록된 OS 계정으로 실행되며 **요청 로그**에 남고, 명령은 **작업**에도 표시됩니다.

| 도구 | 하는 일 |
|---|---|
| `servers_list` | 등록된 서버의 ID, OS, 실행 계정, 연결 상태와 최근 CPU·메모리·디스크·부하를 보여 줍니다. |
| `server_metrics` | 최근 리소스 수집 값과 1시간~30일 범위의 요약을 보여 줍니다. |
| `job_start` | 작업 디렉터리에서 계정의 로그인 셸(Windows는 PowerShell)로 명령을 실행하고 작업 ID와 첫 출력을 돌려줍니다. 호출이 끝나도 작업은 계속 실행되며 기본 실행 시간 제한은 없습니다. |
| `jobs_list`, `job_status`, `job_output` | 작업 목록, 작업 상태, 저장된 전체 출력을 커서로 나눠 읽습니다. |
| `job_input`, `job_cancel` | 실행 중인 작업의 표준입력에 쓰거나(닫기 포함) 작업과 자식 프로세스를 중지합니다. |
| `file_list`, `file_read`, `file_search` | 디렉터리 목록, 파일을 페이지 단위로 읽기(텍스트, 바이너리는 base64), 텍스트 재귀 검색을 합니다. |
| `file_write`, `file_edit`, `file_delete` | 파일을 만들거나 바꾸고, 텍스트 한 곳을 정확히 바꾸고, 파일이나 디렉터리를 삭제합니다. |
| `image_read` | 저장된 PNG·JPEG 파일을 AI가 볼 수 있는 이미지로 돌려줍니다. 예: `job_start`로 헤드리스 브라우저를 실행해 찍은 스크린샷 |
| `file_upload`, `file_download`, `file_transfer_status`, `file_transfer_cancel` | ChatGPT에 첨부한 파일을 서버로 보내고, 서버 파일의 다운로드 링크(1시간 유효)를 만들고, 큰 전송을 추적하거나 취소합니다. |

호출이 **확인** 규칙에 걸리면([명령 승인](#명령-승인) 참고) 실행되지 않습니다. AI는 승인 링크가 담긴 `APPROVAL_REQUIRED` 결과를 받고, 링크를 사용자에게 보여 준 뒤 승인되면 같은 호출을 다시 보내라는 안내를 받습니다. MCP elicitation을 지원하는 클라이언트는 대신 **이번만 허용**, **항상 허용**, **거부** 중에서 바로 고르도록 묻습니다. 거부하면 `APPROVAL_DENIED`, **차단** 규칙에 걸리면 `COMMAND_BLOCKED`가 돌아오며, 두 경우 모두 AI는 다시 시도하거나 우회하지 말라는 안내를 받습니다.

## 명령 승인

**명령 승인**은 위험한 MCP 호출이 사람의 확인을 기다리게 합니다. 기본 규칙은 삭제(`rm`, `Remove-Item`, `file_delete` 등), 덮어쓰기(리다이렉션, 기존 파일을 바꾸는 `file_write`, `sed -i` 등), 디스크 포맷, 종료·재부팅, Docker·패키지 제거 등을 다룹니다. 규칙마다 **확인**, **허용**, **차단** 중 하나를 고르고, 명령 앞부분이나 정규식으로 사용자 규칙을 추가할 수 있습니다. 대상이 모두 **허용 폴더** 안에 있는 삭제·덮어쓰기는 확인 없이 실행합니다.

확인이 필요한 호출이면 AI가 승인 링크를 받습니다. 웹 콘솔(또는 웹훅 알림의 링크)에서 **이번만 허용**, **항상 허용**, **거부** 중에 고르면, AI가 같은 호출을 다시 보내 실행합니다. 승인은 30분 안에 쓰지 않으면 만료됩니다. 페이지 위쪽의 **명령 승인** 스위치로 규칙을 잃지 않고 모든 확인을 끄고 켤 수 있습니다.

명령 승인은 명령 문자열을 분석해 실수를 막는 장치이며, 보안 경계가 아니고 우회될 수 있습니다. 서버에서 AI가 할 수 있는 일을 실제로 제한하려면 그 서버를 일반 OS 계정으로 등록합니다.

## 웹훅

**설정 → 알림**에서 Slack, Discord, Telegram, 또는 JSON `POST`를 받는 주소로 이벤트를 보냅니다.

- 승인 요청
- 2분 넘게 연결이 끊김, 다시 연결됨
- 에이전트 장애 보고
- CPU·메모리·디스크 사용률 90% 이상
- 작업 실패

일반 웹훅에는 서명 비밀을 지정할 수 있으며, 그러면 Hostherd가 `X-Hostherd-Signature: sha256=<본문의 HMAC-SHA256>`을 보냅니다. **테스트**로 전송을 확인합니다.

## 에이전트 제거

웹 콘솔의 서버 메뉴에서 **등록 삭제**를 고르고 **대상 서버의 에이전트도 제거**를 선택합니다. 대상의 서비스·실행기·설정·작업 기록·실행 파일이 지워지고, 실행 중인 작업과 터미널은 종료됩니다. 서버가 온라인일 때만 선택할 수 있습니다. 제거에 실패해도 등록은 삭제되고, 화면에 수동 제거 명령이 표시됩니다.

오프라인 서버처럼 직접 제거할 때는 웹 콘솔에서 서버 등록을 삭제하고, 실행 중인 작업과 터미널을 먼저 종료한 뒤 대상에서 실행합니다.

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

Windows(관리자 권한 PowerShell):

```powershell
Stop-Service HostherdAgent; sc.exe delete HostherdAgent
Get-ScheduledTask -TaskPath '\Hostherd\' | ForEach-Object { Stop-ScheduledTask -InputObject $_; Unregister-ScheduledTask -InputObject $_ -Confirm:$false }
Remove-Item -Recurse -Force "$env:ProgramData\Hostherd", "$env:ProgramFiles\Hostherd"
```

이전 에이전트를 제거해야 같은 서버를 다시 등록할 수 있습니다. 남아 있으면 설치기가 `already enrolled`로 멈춥니다.

## 문제 해결

### 중앙 서버

```sh
docker compose ps
docker compose logs --tail 200 hostherd
curl -s http://127.0.0.1:3000/healthz
```

- **컨테이너가 `PUBLIC_URL must use HTTPS`로 종료됨**: `.env`에 `https://` 주소를 지정합니다.
- **로그인이나 저장이 출처 오류로 실패함**: `PUBLIC_URL`이 브라우저 주소와 정확히 같아야 하고, 프록시가 `Host`와 `X-Forwarded-Proto`를 전달해야 합니다.
- **터미널이나 실시간 갱신이 안 되고 에이전트가 연결됐다 끊김**: 리버스 프록시가 `/agent`, `/terminal/…`의 WebSocket 업그레이드를 전달하지 않거나 `/api/events`를 버퍼링하고 있습니다. [install.md](install.md#4-https)를 확인합니다.
- **함께 들어 있는 Caddy로 HTTPS가 안 됨**: `docker compose logs caddy`에 인증서를 발급하지 못한 이유가 나옵니다. 대개 DNS 레코드가 아직 이 호스트를 가리키지 않거나, 80·443 포트가 막혀 있거나 다른 서비스가 쓰고 있는 경우입니다.

### 에이전트 오프라인

서버 상세 화면은 오프라인 서버의 상태 확인·재시작 명령을 보여 줍니다. 대상에서 실행합니다(네트워크가 끊겼다면 SSH나 클라우드·가상화 콘솔로 접속). 에이전트를 재시작해도 실행 중인 작업과 터미널은 멈추지 않습니다.

| OS | 상태·로그 | 재시작 |
|---|---|---|
| Linux | `sudo systemctl status hostherd-agent --no-pager`<br>`sudo journalctl -u hostherd-agent -n 50 --no-pager` | `sudo systemctl restart hostherd-agent` |
| macOS | `sudo launchctl print system/io.hostherd.agent`(상태와 마지막 종료 코드, 별도 로그 파일 없음) | `sudo launchctl kickstart -k system/io.hostherd.agent`, 내려간 경우 `sudo launchctl bootstrap system /Library/LaunchDaemons/io.hostherd.agent.plist` |
| Windows(관리자 권한 PowerShell) | `Get-Service HostherdAgent`, 시스템 이벤트 로그의 Service Control Manager 이벤트 | `Restart-Service HostherdAgent` |

에이전트 파일: Linux·macOS는 설정을 `/etc/hostherd`, 작업 기록을 `/var/lib/hostherd`, 실행 파일을 `/opt/hostherd`에 둡니다. Windows는 실행 파일을 `C:\Program Files\Hostherd`, 설정과 작업 기록을 `C:\ProgramData\Hostherd`에 둡니다.

대상이 `PUBLIC_URL`에 HTTPS로 접속할 수 있는지(`curl -sI https://hostherd.example.com/healthz`), 시계가 맞는지도 확인합니다.

## 직접 이미지 빌드

공식 이미지의 에이전트는 배포자의 키로 서명되어 있습니다. 직접 빌드하고 서명하려면 Ed25519 키를 만들고 외부에 노출되지 않게 백업해 둡니다.

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

빌드하는 머신의 아키텍처 하나만 만들려면 `--platform`을 빼고 `--push` 대신 `--load`를 씁니다. 빌드는 타입 검사와 모든 테스트를 실행한 뒤 Linux·macOS·Windows용 에이전트를 컴파일하고 서명합니다. 키는 BuildKit secret으로만 전달되어 이미지에 남지 않으며, 공개키만 `<PUBLIC_URL>/downloads/release.pub`로 공개됩니다.

에이전트는 설치할 때 받은 공개키를 신뢰하고 그 키로 서명된 업데이트만 받습니다. 기존 설치를 공식 이미지와 직접 빌드한 이미지 사이에서 바꾸거나 키를 바꾸면, 설치된 에이전트가 업데이트를 거부합니다. 같은 키를 계속 쓰거나 에이전트를 제거한 뒤 다시 설치합니다. `compose.yaml`의 `image:`를 직접 빌드한 이미지로 바꿉니다.
