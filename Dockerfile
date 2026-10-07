# syntax=docker/dockerfile:1.7
# Hostherd central image. It is only produced when the type check, the tests
# and the agent tests pass.
#
# The same build compiles the six agent targets (Linux, macOS, Windows x
# amd64, arm64) and signs their release manifest with an Ed25519 key. The key
# arrives only as the BuildKit secret AGENT_SIGNING_KEY_B64 (the PEM file
# encoded as one base64 line) and never ends up in a layer.
#
# Every build, test and agent stage runs on $BUILDPLATFORM, so a multi-arch
# build (linux/amd64,linux/arm64) does that work once, natively, and only the
# small target-specific stages differ per platform. No QEMU emulation is needed.
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --secret id=AGENT_SIGNING_KEY_B64,env=AGENT_SIGNING_KEY_B64 \
#     --build-arg APP_COMMIT=$(git rev-parse HEAD) -t hostherd .
ARG NODE_IMAGE=node:24-bookworm-slim
ARG GO_IMAGE=golang:1.27.1-bookworm

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --foreground-scripts
COPY apps apps
RUN npm run build

FROM build AS test
COPY scripts scripts
RUN --network=none npm run typecheck && npm test && touch /tmp/tests-passed

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS agent
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent ./
RUN --network=none go test ./... && touch /tmp/agent-tests-passed

FROM build AS agent-release
COPY --from=agent /usr/local/go /usr/local/go
COPY --from=agent /go/pkg/mod /root/go/pkg/mod
ENV PATH=/usr/local/go/bin:$PATH GOPROXY=off
COPY agent agent
COPY scripts/build-release.mjs scripts/build-release.mjs
RUN --mount=type=secret,id=AGENT_SIGNING_KEY_B64,required=true \
    --mount=type=tmpfs,target=/run/signing \
    base64 -d /run/secrets/AGENT_SIGNING_KEY_B64 > /run/signing/key.pem \
 && SIGNING_KEY_FILE=/run/signing/key.pem RELEASE_DIR=/app/releases node scripts/build-release.mjs

FROM build AS production-deps
ARG TARGETARCH
RUN npm prune --omit=dev && mkdir /app/empty-data
# JavaScript is platform independent. Install the package's published native
# addon for the target architecture without emulating the whole Node toolchain.
# Node calls amd64 "x64".
RUN cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js --arch="$(case "$TARGETARCH" in amd64) echo x64 ;; *) echo "$TARGETARCH" ;; esac)" --verbose
RUN node -e "const b=require('fs').readFileSync('node_modules/better-sqlite3/build/Release/better_sqlite3.node'); if(b.readUInt16LE(18)!==({arm64:183,amd64:62}[process.env.TARGETARCH])) throw Error('Incorrect SQLite addon architecture')"

FROM ${NODE_IMAGE}
ARG APP_COMMIT=development
LABEL org.opencontainers.image.title="Hostherd" \
      org.opencontainers.image.description="MCP gateway and web console for running commands, files and terminals on your servers" \
      org.opencontainers.image.licenses="Elastic-2.0" \
      org.opencontainers.image.revision=$APP_COMMIT
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data RELEASE_DIR=/app/releases WEB_DIR=/app/apps/web/dist APP_COMMIT=$APP_COMMIT
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=agent-release /app/releases ./releases
COPY --from=test /tmp/tests-passed /tmp/tests-passed
COPY --from=agent /tmp/agent-tests-passed /tmp/agent-tests-passed
COPY --from=production-deps --chown=node:node /app/empty-data /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
