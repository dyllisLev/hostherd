# 유지보수자용 개발·운영 환경

이 문서는 Hostherd를 직접 개발하고 운영하는 유지보수자를 위한 메모입니다. 일반 사용자의 설치·운영 방법은 [docs/ko/install.md](../ko/install.md)와 [docs/ko/operations.md](../ko/operations.md)를 봅니다.

저장소가 공개되어 있으므로 IP 주소, 토큰, 서명 키 내용은 이 문서에 적지 않습니다.

## 한눈에 보기

| 구분 | 서버 (Hostherd 등록 이름) | 위치 | 역할 |
|---|---|---|---|
| 개발 | `dev(nuc)` (hostname `dev`, Ubuntu 24.04, amd64) | `/workspace/hostherd` | 소스 작업, 테스트, 이미지 빌드(Komodo Build) |
| 운영 | `OCI1` (hostname `instance-oci1`, Ubuntu 24.04, arm64) | `/etc/komodo/stacks/hostherd` | 중앙 서버 컨테이너 실행 (`https://hostherd.oci1.hmini.me`) |

두 서버 모두 Hostherd 에이전트(`hostherd-agent.service`, `hostherd-runner-<버전>.service`)가 설치되어 있어 Hostherd 자신으로 관리됩니다.

## 개발 환경: dev(nuc)

- 작업 경로: `/workspace/hostherd` (`origin` = `https://github.com/dyllisLev/hostherd.git`)
- 브랜치별 작업은 `/workspace/hostherd-wt-*` 같은 git worktree를 따로 만들어 진행합니다.
- 설치된 도구: Node.js 22, npm 11, Docker 29. Go는 호스트에 없으므로 에이전트 테스트는 Docker로 돌립니다.

자주 쓰는 명령(저장소 루트에서):

```sh
npm ci
npm run build
npm run typecheck && npm test

# 로컬 개발 서버 (데이터는 .local/data, .gitignore 대상)
HOST=127.0.0.1 PORT=3000 PUBLIC_URL=http://127.0.0.1:3000 DATA_DIR="$PWD/.local/data" npm run dev

# 에이전트 테스트 (Go가 호스트에 없으므로 컨테이너 사용)
docker run --rm -v "$PWD/agent:/src" -w /src golang:1.27.1-bookworm go test ./...
```

CI(`.github/workflows/ci.yml`)는 Node 24로 build·typecheck·test를, 에이전트는 gofmt·go vet·go test·6개 플랫폼 크로스 컴파일을 확인합니다. 운영 이미지는 Node 24 기반이므로 dev의 Node 22와 버전이 다르다는 점에 유의합니다.

## 빌드와 배포 흐름

운영 배포는 GitHub Actions의 `release.yml`(태그 → GHCR)이 아니라 **Komodo**로 이뤄집니다.

1. `main`에 머지합니다.
2. Komodo Build `hostherd`가 dev(nuc)의 Komodo Periphery(`/etc/komodo/builds/hostherd`, `main` 브랜치)에서 `Dockerfile`로 이미지를 빌드합니다. 에이전트 서명 키는 이 빌드 디렉터리에 BuildKit secret(`AGENT_SIGNING_KEY_B64`)용으로 따로 보관되어 있고, 저장소나 이미지에는 들어가지 않습니다.
3. 결과 이미지는 사설 레지스트리 `registry.nuc.hmini.me/dyllislev/hostherd:latest`로 푸시됩니다. 이미지 라벨 `org.opencontainers.image.revision`에 커밋 SHA가 들어갑니다.
4. OCI1의 Komodo Stack `hostherd`(UI에서 정의, 파일은 `/etc/komodo/stacks/hostherd/compose.yaml`, `.env`)를 재배포해 새 이미지를 받습니다.

운영 중인 커밋 확인:

```sh
docker inspect hostherd-central-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

## 운영 환경: OCI1

- 컨테이너: `hostherd-central-1` (compose 프로젝트 `hostherd`, 서비스 `central`)
- 이미지: `registry.nuc.hmini.me/dyllislev/hostherd:${TAG:-latest}`
- 포트: `127.0.0.1:18431 → 3000`. 외부 HTTPS는 OCI1의 **Zoraxy** 리버스 프록시가 `hostherd.oci1.hmini.me`로 받아 이 포트로 넘깁니다(설정 `/opt/zoraxy/conf/proxy/hostherd.oci1.hmini.me.config`). 표준 compose의 Caddy는 쓰지 않습니다.
- 환경 변수: `.env`의 `PUBLIC_URL=https://hostherd.oci1.hmini.me`
- 데이터: 바인드 마운트 `/srv/hostherd/data → /data` (`hostherd.sqlite`, `metrics.sqlite`, `outputs/`, `file-transfers/`, `backups/`). SQLite와 에이전트 연결이 한 프로세스에 있으므로 인스턴스는 하나만 띄웁니다.
- 헬스체크: 컨테이너 안에서 `http://127.0.0.1:3000/healthz`

### 배포 전 백업과 롤백 관례

지금까지의 배포는 다음 순서로 진행했습니다.

1. `/root/hostherd-backups/<날짜>-pre-<커밋>/`에 `compose.yaml`과 `.env`를 복사하고, 필요하면 `/srv/hostherd/data/hostherd.sqlite.bak-<시각>`으로 DB를 백업합니다.
2. 기존 이미지를 `registry.nuc.hmini.me/dyllislev/hostherd:rollback-<이전 커밋>`으로 태그해 둡니다.
3. `/root/hostherd-deploy-watch-<커밋>.sh` 감시 스크립트를 띄운 뒤 배포합니다. 새 이미지가 5분 안에 안정적으로 healthy가 되지 않거나 재시작이 반복되면, rollback 태그를 `latest`로 되돌리고 `docker compose -p hostherd up -d --pull never`로 자동 롤백합니다.

수동 롤백:

```sh
cd /etc/komodo/stacks/hostherd
docker tag registry.nuc.hmini.me/dyllislev/hostherd:rollback-<커밋> registry.nuc.hmini.me/dyllislev/hostherd:latest
docker compose -p hostherd up -d --pull never
```

## 에이전트

- 대상 서버의 에이전트 실행 파일은 `/opt/hostherd/current`(→ `/opt/hostherd/releases/<버전>/hostherd`), 설정은 `/etc/hostherd/config.json`입니다.
- 새 중앙 이미지에는 맞는 버전의 서명된 에이전트가 들어 있고, 웹 콘솔의 **Update agent** / **Update all**로 올립니다.
