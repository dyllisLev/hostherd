# Bootstrap the native, signed Hostherd installer on Windows.
# Run from an elevated (Administrator) PowerShell. Commands run as the user who
# started that PowerShell; add -RunAsSystem to run them as SYSTEM instead.
#
# PowerShell has no Ed25519 verifier. This script checks the downloaded binary
# against the release manifest's SHA-256 before running it; the native
# installer then verifies the manifest's Ed25519 signature and the digest again
# before installing, and pins the public key for later updates.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Code,
  [switch]$RunAsSystem
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$Message) {
  Write-Host "Hostherd: $Message" -ForegroundColor Red
  exit 1
}

$Url = $Url.TrimEnd('/')
if (-not $Url.StartsWith('https://') -or $Url -match '[\s"''\\@#?]') { Fail 'the server URL must be an https:// address' }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'run this installer from an elevated PowerShell (Run as administrator)'
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($architecture) {
  'AMD64' { $arch = 'amd64' }
  'ARM64' { $arch = 'arm64' }
  default { Fail "supported architectures: x64 and ARM64 (found $architecture)" }
}
# Windows PowerShell 5.1 may default to older TLS versions.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$work = Join-Path ([IO.Path]::GetTempPath()) ('hostherd-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $envelope = Invoke-RestMethod -UseBasicParsing -Uri "$Url/downloads/manifest.json"
  if (-not $envelope.payload) { Fail 'invalid release envelope' }
  $manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.payload)) | ConvertFrom-Json
  $artifact = $manifest.artifacts."windows-$arch"
  if (-not $artifact) { Fail "the release has no Windows $arch agent" }
  # Only the file name is used; the binary comes from this central whatever
  # address the release was built for, and the signed digest pins it.
  $name = "hostherd-windows-$arch.exe"
  if (([string]$artifact.url).Split('/')[-1] -ne $name) { Fail 'unexpected bootstrap artifact name' }
  if ($artifact.sha256 -notmatch '^[0-9a-f]{64}$') { Fail 'missing signed artifact digest' }
  $binary = Join-Path $work 'hostherd.exe'
  Invoke-WebRequest -UseBasicParsing -Uri "$Url/downloads/$name" -OutFile $binary
  $actual = (Get-FileHash -Algorithm SHA256 -Path $binary).Hash.ToLowerInvariant()
  if ($actual -ne $artifact.sha256) { Fail 'agent binary SHA256 verification failed' }
  $arguments = @('install', '--url', $Url, '--code', $Code, '--binary', $binary)
  if ($RunAsSystem) { $arguments += '--system' }
  & $binary @arguments
  if ($LASTEXITCODE -ne 0) { Fail "installation failed (exit code $LASTEXITCODE)" }
  Write-Host 'Hostherd: installed. This computer now appears in the Hostherd server list.' -ForegroundColor Green
} finally {
  Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}
