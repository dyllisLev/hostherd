# Native installation and updates

The installer supports systemd Linux and launchd macOS, each on amd64 and arm64.
The bootstrap requires `sh`, curl, base64, and OpenSSL with Ed25519 support; installed processes are
Go executables. `install.sh --url HTTPS_ORIGIN --code CODE` checks a release
signature and executable digest before executing the native installer.

`manifest.json` is a JSON envelope with base64 `payload` and `signature` fields.
The signature is Ed25519 over the exact decoded UTF-8 payload bytes. The payload
is JSON, for example:

```json
{
  "version": "0.1.0",
  "protocol": 1,
  "artifacts": {
    "linux-amd64": {
      "url": "https://mcp.example/downloads/hostherd-linux-amd64",
      "sha256": "64 lowercase hexadecimal digits"
    },
    "linux-arm64": {
      "url": "https://mcp.example/downloads/hostherd-linux-arm64",
      "sha256": "64 lowercase hexadecimal digits"
    }
  }
}
```

The publisher emits `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`,
`windows-amd64` and `windows-arm64`. A manifest may list a subset;
installation/update requires an artifact for the current OS/architecture and
validates all supplied artifacts. Artifact URLs must be literal unescaped HTTPS
URLs, but only their file name (`hostherd-{os}-{arch}[.exe]`) is used: the
bootstrap scripts download it from the given central's `/downloads/`, and the
updater from the directory of the manifest URL, so one signed release serves any
central address.
`release.pub` is a PKIX `PUBLIC KEY` PEM containing an Ed25519 public key. Initial
installation trusts the HTTPS origin and pins this key in the root-only config.
Subsequent updates use that stored key; downloading a different public key cannot
authorize an update. Versions use `major.minor.patch[-prerelease]`; one version
names one immutable executable. Downgrades are rejected, same-version requests
are idempotent, and protocol 1 is required.

The native CLI calls `Install(ctx, url, code, binaryPath)` or
`Update(ctx, configPath, manifestURL)`. `StartUpdate` runs the latter in a new
transient root service (systemd on Linux, launchd on macOS) so restarting the communication agent does not
terminate its updater. Files installed:

Initial installation detects the execution account from `SUDO_USER`; a direct
root invocation uses root. The native installer verifies that the account exists
before enrollment and reports its canonical name to central. The CGO-free macOS
binary resolves directory-service accounts with `dscacheutil` rather than relying
on `/etc/passwd`.

- `/etc/hostherd/config.json`: root-owned mode 0600, includes the enrollment token.
- `/opt/hostherd/releases/VERSION/hostherd`: verified, immutable binary, mode 0755.
- `/opt/hostherd/current`: atomically replaced link used by the communication unit.
- `/var/lib/hostherd/runtime`: mode 0700, owned by the enrolled execution account.
- `hostherd-agent.service`: root communication process; independent runner units
  `hostherd-runner-VERSION.service` execute as the enrolled numeric UID/GID.

Updates start the candidate runner, verify its local health/protocol/version,
switch the config and link, then restart the communication unit. Readiness is a
root-only `agent-ready.json` next to the runtime directory containing the active
service PID, version and generation. Central connectivity is not a startup
requirement. Failure restores the previous selection and communication service;
all runner services survive rollback so any accepted work remains attached.

`CleanupRunners` shares the update lock and stops only older generations whose
local health explicitly reports zero active executions. It removes their unit
and release binary, never the runtime state, completion records or output spool.
Failed/unreachable and newer candidate runners are retained for diagnosis.
Runner services restart after a failure (systemd `Restart=on-failure`, launchd
`KeepAlive` on unsuccessful exit); the restarted runner marks the jobs of its
generation interrupted and never reruns them. Stopping a runner ends only the
runner process (systemd `KillMode=process`, launchd `AbandonProcessGroup`), so
daemons started by commands survive retirement; explicit removal cancels running
jobs and terminals itself first.

## Removal

`StartUninstall` (from the `agent.uninstall` RPC) starts `hostherd uninstall`
outside the communication service, as `StartUpdate` does: a systemd transient
unit, a one-shot launchd job, or on Windows a detached copy in
`%SystemRoot%\Temp` that deletes itself. `Uninstall` waits briefly for the RPC
reply, cancels running jobs and terminals through their runners, stops and
deletes the communication unit and then every runner unit, and removes the
config, runtime and install directories. Unlike `CleanupRunners`, it is an
explicit request to end work and delete the output spool.

## Restart policy

The communication service restarts after any exit that was not an explicit
stop: systemd `Restart=always` (`RestartSec=3`), launchd `KeepAlive` true
(`ThrottleInterval` 3), and Windows recovery actions with
`FailureActionsOnNonCrashFailures` (the service also reports a non-zero exit
whenever the agent ends without a stop request). `systemctl stop`,
`launchctl bootout` and a service stop still keep it stopped, so update,
rollback and removal are unchanged. Runner units restart on failure (see
above). The communication service definition names only the `current` link and
config path, so it is version independent and rollback keeps it.

Tests use real signatures and digest verification, a local Unix health socket,
temporary files and fake systemd/launchctl/curl commands. They do not change host services.

## macOS

Run `brew install openssl@3` as a regular user before the web-generated sudo
installation command. The bootstrap selects Homebrew OpenSSL at
`/opt/homebrew/opt/openssl@3/bin/openssl` or
`/usr/local/opt/openssl@3/bin/openssl`, then falls back to PATH only if neither
exists. It requires Ed25519 verification and uses OpenSSL for SHA256 too, so GNU
coreutils are not required. Installed Go processes need no Homebrew runtime.

The config, release and runtime paths above also apply to macOS. Service plists
are `/Library/LaunchDaemons/io.hostherd.agent.plist` and
`/Library/LaunchDaemons/io.hostherd.runner.VERSION.plist`. The communication daemon
runs as root; runners use the enrolled account and its home directory. A launchd
update job runs independently of both. Only the communication daemon restarts
during activation/rollback; busy runners of previous generations remain registered.

For diagnosis, use `sudo launchctl print system/io.hostherd.agent` and
`sudo launchctl print system/io.hostherd.runner.VERSION`. Restart only communication
with `sudo launchctl kickstart -k system/io.hostherd.agent`. Do not boot out a busy
runner. macOS privacy controls still apply to protected folders; allow the runner
executable access in System Settings when needed. Sleep can suspend connectivity
and execution, and reboot does not preserve active jobs.

The Linux-hosted suite tests macOS bootstrap artifact selection/signature checks
and launchd lifecycle commands using mocks. Cross-compilation confirms both
Mach-O architectures; actual launchd, user permissions and PTY behavior require
running the Go suite and install/update checks on a Mac.
