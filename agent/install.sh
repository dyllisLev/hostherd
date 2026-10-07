#!/bin/sh
# Bootstrap the native, signed Hostherd installer. No Python, jq or persistent
# interpreter is required by the installed agent.
set -eu

fail() { printf '%s\n' "Hostherd: $*" >&2; exit 1; }
server_url=
enrollment_code=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) [ "$#" -ge 2 ] || fail 'missing --url value'; server_url=$2; shift 2 ;;
    --code) [ "$#" -ge 2 ] || fail 'missing --code value'; enrollment_code=$2; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ -n "$server_url" ] && [ -n "$enrollment_code" ] || fail 'usage: install.sh --url https://mcp.example --code CODE'
server_url=${server_url%/}
case "$server_url" in https://*) ;; *) fail 'the server URL must use HTTPS' ;; esac
case "$server_url" in *' '*|*'"'*|*'\'*|*'@'*|*'#'*|*'?'*) fail 'invalid server URL' ;; esac
[ "$(id -u)" = 0 ] || fail 'run this installer as root (sudo sh)'
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'supported systems: systemd Linux and macOS' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail 'supported architectures: amd64 and arm64' ;;
esac
for command in curl base64 sed tr mktemp chmod; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is missing: $command"
done
# macOS ships LibreSSL, which cannot verify our Ed25519 releases. Prefer
# Homebrew OpenSSL 3 when installed; never skip signature verification.
openssl_bin=openssl
if [ "$platform" = darwin ]; then
  for candidate in /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    if [ -x "$candidate" ]; then openssl_bin=$candidate; break; fi
  done
fi
algorithms=$("$openssl_bin" list -public-key-algorithms 2>/dev/null) || fail 'OpenSSL with Ed25519 is required; on macOS run: brew install openssl@3'
case "$algorithms" in *ED25519*) ;; *) fail 'OpenSSL with Ed25519 is required; on macOS run: brew install openssl@3' ;; esac
umask 077
bootstrap_dir=$(mktemp -d /tmp/hostherd-install.XXXXXXXX)
trap 'rm -rf "$bootstrap_dir"' EXIT
trap 'exit 1' HUP INT TERM
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 "$1" -o "$2"; }
fetch "$server_url/downloads/release.pub" "$bootstrap_dir/release.pub"
fetch "$server_url/downloads/manifest.json" "$bootstrap_dir/manifest.json"

# Both envelope fields are base64, so extracting their scalar values cannot
# evaluate shell code. The signed payload itself is never sourced or evaluated.
envelope=$(tr -d '\r\n\t ' < "$bootstrap_dir/manifest.json")
payload=$(printf '%s' "$envelope" | sed -n 's/^{.*"payload":"\([A-Za-z0-9+/=]*\)".*}$/\1/p')
signature=$(printf '%s' "$envelope" | sed -n 's/^{.*"signature":"\([A-Za-z0-9+/=]*\)".*}$/\1/p')
[ -n "$payload" ] && [ -n "$signature" ] || fail 'invalid release envelope'
printf '%s' "$payload" | base64 -d > "$bootstrap_dir/payload.json" || fail 'invalid release payload encoding'
printf '%s' "$signature" | base64 -d > "$bootstrap_dir/signature" || fail 'invalid release signature encoding'
key_kind=$("$openssl_bin" pkey -pubin -in "$bootstrap_dir/release.pub" -text -noout 2>/dev/null | sed -n '/^ED25519 Public-Key:/p')
[ -n "$key_kind" ] || fail 'the release public key must be Ed25519'
"$openssl_bin" pkeyutl -verify -pubin -inkey "$bootstrap_dir/release.pub" -rawin -in "$bootstrap_dir/payload.json" -sigfile "$bootstrap_dir/signature" >/dev/null 2>&1 || fail 'release signature verification failed'

# Release publishing emits ordinary JSON objects with literal HTTPS URLs and
# lowercase hex digests. Only the artifact file name is used: the binary always
# comes from this central's /downloads, whatever address the release was built
# for, and the signed digest pins it. The native installer verifies again.
manifest=$(tr -d '\r\n\t ' < "$bootstrap_dir/payload.json")
artifact=$(printf '%s' "$manifest" | sed -n 's/^.*"'"$platform-$arch"'":\({[^{}]*}\).*$/\1/p')
digest=$(printf '%s' "$artifact" | sed -n 's/^.*"sha256":"\([0-9a-f]\{64\}\)".*$/\1/p')
artifact_url=$(printf '%s' "$artifact" | sed -n 's/^.*"url":"\([^"\\]*\)".*$/\1/p')
[ -n "$digest" ] || fail 'missing signed artifact digest'
[ "${artifact_url##*/}" = "hostherd-$platform-$arch" ] || fail 'unexpected bootstrap artifact name'
fetch "$server_url/downloads/hostherd-$platform-$arch" "$bootstrap_dir/hostherd"
actual_digest=$("$openssl_bin" dgst -sha256 "$bootstrap_dir/hostherd")
actual_digest=${actual_digest##* }
[ "$actual_digest" = "$digest" ] || fail 'agent binary SHA256 verification failed'
chmod 700 "$bootstrap_dir/hostherd"
"$bootstrap_dir/hostherd" install --url "$server_url" --code "$enrollment_code" --binary "$bootstrap_dir/hostherd"
