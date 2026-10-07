import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The agent has its own version, raised only when agent code changes, so a
// central-only release does not offer every server an identical update.
const agentVersion = /^var version = "([^"]+)"$/m.exec(await readFile(path.join(root, 'agent/cmd/hostherd/main.go'), 'utf8'))?.[1];
const version = process.env.RELEASE_VERSION ?? agentVersion;
// Agents and the install scripts use only each artifact URL's file name and
// download it from the central they talk to, so the base address is a placeholder.
const publicUrl = 'https://hostherd.invalid';
const output = path.resolve(process.env.RELEASE_DIR ?? path.join(root, 'releases'));
if (!process.env.SIGNING_KEY_FILE) throw new Error('Set SIGNING_KEY_FILE to the private Ed25519 release key file');
if (!version || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
const key = createPrivateKey(await readFile(process.env.SIGNING_KEY_FILE));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release signing key must be Ed25519');
await mkdir(output, { recursive: true });
const artifacts = {};
for (const os of ['linux', 'darwin', 'windows']) {
  for (const arch of ['amd64', 'arm64']) {
    const name = `hostherd-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
    const build = spawnSync(process.env.GO_BINARY ?? 'go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', path.join(output, name), './cmd/hostherd'], {
      cwd: path.join(root, 'agent'), env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch }, stdio: 'inherit'
    });
    if (build.status !== 0) throw new Error(`Go build failed for ${os}-${arch}: ${build.error?.message ?? build.status}`);
    const bytes = await readFile(path.join(output, name));
    artifacts[`${os}-${arch}`] = { url: `${publicUrl}/downloads/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
const payload = Buffer.from(JSON.stringify({ version, protocol: 1, artifacts }));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n');
await writeFile(path.join(output, 'release.pub'), createPublicKey(key).export({ format: 'pem', type: 'spki' }));
await copyFile(path.join(root, 'agent/install.sh'), path.join(output, 'install.sh'));
await copyFile(path.join(root, 'agent/install.ps1'), path.join(output, 'install.ps1'));
console.log(`Built signed Hostherd ${version} release: ${output}`);
