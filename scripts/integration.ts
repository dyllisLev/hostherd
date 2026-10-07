import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { createApp } from '../apps/server/src/app.js';

const binary = path.resolve(process.env.AGENT_BINARY ?? '/tmp/hostherd-agent-dev');
const root = await mkdtemp(path.join(tmpdir(), 'hostherd-e2e-'));
const dataDir = path.join(root, 'central');
const runtime = path.join(root, 'runtime');
const files = path.join(root, 'files');
await mkdir(files);
const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
function child(mode: string, args: string[]) {
  const p = spawn(binary, [mode, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout?.on('data', b => void appendFile(path.join(root, `${mode}.log`), b));
  p.stderr?.on('data', b => void appendFile(path.join(root, `${mode}.log`), b));
  return p;
}
async function stop(p?: ChildProcess) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill('SIGTERM');
  await until(() => p.exitCode !== null || p.signalCode !== null, 'child exit', 10_000);
}
let app = await createApp({ dataDir, publicUrl: base });
// Command approval holds deletes and edits; this fixture folder is pre-approved like a user-allowed folder.
app.approvals.addFolder(null, files);
let agent: ChildProcess | undefined;
let runner: ChildProcess | undefined;
let client: Client | undefined;
let cookie = '';
let pat = '';
let serverId = '';
const report: Record<string, unknown> = {};
async function api(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + route, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(value)}`);
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return value;
}
async function connectMcp() {
  client = new Client({ name: 'hostherd-native-integration', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pat}` } } }));
}
async function tool(name: string, args: Record<string, unknown>) {
  const result = await client!.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse((result.content as { text: string }[])[0].text);
}
async function output(id: string) {
  try { return (await readFile(app.store.outputPath(id))).toString('utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function rss(pid: number) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
}
try {
  await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve));
  await api('/api/setup', 'POST', { username: 'integration', password: 'local-integration-password', setupToken: (await readFile(path.join(dataDir, 'setup-token'), 'utf8')).trim() });
  pat = (await api('/api/tokens', 'POST', { name: 'native integration' })).token;
  const enrollment = await api('/api/enrollments', 'POST', { name: 'Native integration target' });
  const enrolled = await api('/api/agent/enroll', 'POST', { code: enrollment.code, hostname: 'native-fixture', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' });
  serverId = enrolled.serverId;
  const configFile = path.join(root, 'config.json');
  await writeFile(configFile, JSON.stringify({ url: base, token: enrolled.token, serverId, executionUser: 'root', stateDir: runtime, generation: '0.1.0', version: '0.1.0' }), { mode: 0o600 });
  runner = child('runner', ['--state-dir', runtime, '--generation', '0.1.0']);
  agent = child('agent', ['--config', configFile]);
  await until(() => app.hub.online(serverId), 'native agent connects');
  await connectMcp();
  const listed = await client!.listTools();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/mcp-guidance-after.json', JSON.stringify({ serverInstructions: client!.getInstructions(), jobStart: listed.tools.find(t => t.name === 'job_start') }, null, 2) + '\n');
  const invalid = await client!.callTool({ name: 'job_start', arguments: { serverId, path: '/bin/bash', cmd: `touch '${path.join(files, 'must-not-run')}'`, requestId: randomUUID() } });
  assert.equal(invalid.isError, true);
  const failure = JSON.parse((invalid.content as { text: string }[])[0].text);
  assert.equal(failure.code, 'INVALID_WORKDIR');
  assert.match(failure.error, /command was not started/);
  assert.equal(app.store.job(failure.jobId).status, 'failed');
  assert.equal(app.store.server(serverId).fault, null);
  await assert.rejects(readFile(path.join(files, 'must-not-run')), { code: 'ENOENT' });
  report.invalidWorkingDirectory = { code: failure.code, commandStarted: false, serverFault: null, failedHistoryRetained: true };
  const initial = await tool('job_start', { serverId, path: files, cmd: 'pwd; printf "안녕하세요\\n"', waitMs: 1000, requestId: randomUUID() });
  await until(() => app.store.job(initial.jobId).status === 'completed', 'initial command completes');
  assert.equal(await output(initial.jobId), `${files}\n안녕하세요\n`);
  report.command = 'absolute path and UTF-8 output passed';

  const file = path.join(files, 'sample.txt');
  await tool('file_write', { serverId, path: file, data: 'first\nneedle\n', createOnly: true });
  assert.equal((await tool('file_read', { serverId, path: file })).text, 'first\nneedle\n');
  await tool('file_edit', { serverId, path: file, oldText: 'first', newText: 'changed' });
  assert.ok((await tool('file_search', { serverId, path: files, query: 'needle' })).matches.length > 0);
  assert.ok((await tool('file_list', { serverId, path: files })).entries.some((e: { name: string }) => e.name === 'sample.txt'));
  await tool('file_delete', { serverId, path: file });
  report.files = 'list/read/write/edit/search/delete passed';

  // Execute the documented headless capture workflow, then receive actual MCP
  // image content. Noise makes the PNG exceed the former 2 MiB WS frame limit.
  const htmlFile = path.join(files, 'image-fixture.html');
  const imageFile = path.join(files, 'screenshot.png');
  await writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>body{margin:24px;font-family:sans-serif}canvas{display:block}</style><h1>Hostherd screenshot integration</h1><canvas width="1200" height="700"></canvas><script>const c=document.querySelector('canvas').getContext('2d');const im=c.createImageData(1200,700);let x=123;for(let i=0;i<im.data.length;i+=4){for(let j=0;j<3;j++){x=(Math.imul(x,1664525)+1013904223)|0;im.data[i+j]=x>>>24;}im.data[i+3]=255;}c.putImageData(im,0,0);document.body.id='ready';</script>`);
  const capture = await tool('job_start', { serverId, path: path.resolve('.'), cmd: `npx --no-install playwright screenshot --channel=chrome --viewport-size='1280,900' --wait-for-selector='#ready' 'file://${htmlFile}' '${imageFile}'`, waitMs: 5000 });
  await until(() => ['completed', 'failed'].includes(app.store.job(capture.jobId).status), 'headless screenshot completes');
  assert.equal(app.store.job(capture.jobId).exitCode, 0, await output(capture.jobId));
  const originalImage = await readFile(imageFile);
  assert.ok(originalImage.length > 2 * 1024 * 1024, 'image must exercise the larger authenticated WS frame');
  const imageResult = await client!.callTool({ name: 'image_read', arguments: { serverId, path: imageFile } });
  assert.notEqual(imageResult.isError, true);
  const imageBlocks = imageResult.content as { type: string; data?: string; mimeType?: string; text?: string }[];
  const imageBlock = imageBlocks.find(c => c.type === 'image')!;
  const imageMetadata = JSON.parse(imageBlocks.find(c => c.type === 'text')!.text!);
  const receivedImage = Buffer.from(imageBlock.data!, 'base64');
  assert.deepEqual(receivedImage, originalImage);
  assert.equal(imageBlock.mimeType, 'image/png');
  assert.equal(imageMetadata.width, 1280); assert.equal(imageMetadata.height, 900);
  assert.ok(app.hub.online(serverId)); assert.equal(app.store.server(serverId).fault, null);
  const invalidImage = await client!.callTool({ name: 'image_read', arguments: { serverId, path: htmlFile } });
  assert.equal(invalidImage.isError, true);
  assert.equal(JSON.parse((invalidImage.content as { text: string }[])[0].text).code, 'INVALID_IMAGE');
  await writeFile('artifacts/image-integration.png', receivedImage);
  await writeFile('artifacts/image-tool-schema.json', JSON.stringify({ instructions: client!.getInstructions(), tool: listed.tools.find(t => t.name === 'image_read') }, null, 2));
  report.image = { headlessCapture: 'completed', bytes: receivedImage.length, width: 1280, height: 900, mimeType: 'image/png', sha256: createHash('sha256').update(receivedImage).digest('hex'), originalBytesPreserved: true, invalidImageRejected: true };

  const transferFile = path.join(files, 'transfer-source.bin');
  const uploadedFile = path.join(files, '첨부파일-received.bin');
  const originalBytes = Buffer.alloc(32 * 1024 * 1024 + 71);
  for (let i = 0; i < originalBytes.length; i++) originalBytes[i] = (i * 37 + 19) % 256;
  await writeFile(transferFile, originalBytes);
  const originalHash = createHash('sha256').update(originalBytes).digest('hex');
  async function finishTransfer(state: any) {
    await until(async () => {
      if (state.status === 'running') state = await tool('file_transfer_status', { transferId: state.transferId });
      return state.status !== 'running';
    }, 'file transfer completes', 120_000);
    assert.equal(state.status, 'completed'); return state;
  }
  const download = await finishTransfer(await tool('file_download', { serverId, path: transferFile, waitMs: 0, requestId: randomUUID() }));
  const downloadResponse = await fetch(download.downloadUrl);
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get('content-disposition')!, /attachment/);
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), originalBytes);
  assert.equal(download.size, originalBytes.length); assert.equal(download.sha256, originalHash);
  const upload = await finishTransfer(await tool('file_upload', { serverId, path: uploadedFile, file: { download_url: download.downloadUrl, file_id: 'file-native-integration', file_name: 'source.bin', mime_type: 'application/octet-stream' }, waitMs: 0, requestId: randomUUID() }));
  assert.equal(upload.size, originalBytes.length); assert.equal(upload.sha256, originalHash);
  assert.deepEqual(await readFile(uploadedFile), originalBytes);
  const protectedFile = await client!.callTool({ name: 'file_upload', arguments: { serverId, path: uploadedFile, file: { download_url: download.downloadUrl, file_id: 'file-existing' }, waitMs: 5000 } });
  assert.equal(protectedFile.isError, true);
  assert.equal(JSON.parse((protectedFile.content as { text: string }[])[0].text).code, 'FILE_EXISTS');
  assert.deepEqual(await readFile(uploadedFile), originalBytes);
  const linked = await client!.callTool({ name: 'file_transfer_status', arguments: { transferId: download.transferId } });
  assert.equal((linked.content as { type: string; uri?: string }[]).find(block => block.type === 'resource_link')!.uri, download.downloadUrl);
  assert.ok(JSON.stringify(linked).length < 4000);
  await writeFile('artifacts/file-transfer-tool-schemas.json', JSON.stringify({ instructions: client!.getInstructions(), tools: listed.tools.filter(t => ['file_upload', 'file_download', 'file_transfer_status', 'file_transfer_cancel'].includes(t.name)) }, null, 2));
  report.fileTransfer = { bytes: originalBytes.length, sha256: originalHash, upload: 'completed', download: 'completed', originalBytesPreserved: true, overwriteProtected: true, metadataOnlyInModelContext: true, rssKiB: { agent: await rss(agent.pid!), runner: await rss(runner.pid!) } };

  const jobs = await Promise.all(Array.from({ length: 5 }, () => tool('job_start', { serverId, path: files, cmd: 'read line; printf "received:%s\\n" "$line"', waitMs: 0, requestId: randomUUID() })));
  const terminals = await Promise.all(Array.from({ length: 5 }, () => api('/api/terminals', 'POST', { serverId, path: root, cols: 100, rows: 30 })));
  assert.ok(app.store.jobs('job').filter(j => j.status === 'running').length >= 5);
  assert.equal(app.store.jobs('terminal').filter(j => j.status === 'running').length, 5);
  const pids = [...jobs, ...terminals].map(j => app.store.job(j.id).pid);
  const terminal = terminals[0];
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/terminal/${terminal.id}`, { headers: { Cookie: cookie, Origin: base } });
  ws.on('error', () => {});
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'input', data: `cd '${files}'\nexport HOSTHERD_TEST=kept\nprintf 'TERMINAL_READY\\n'\n` }));
  ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 42 }));
  await until(async () => (await output(terminal.id)).includes('TERMINAL_READY'), 'terminal input');
  ws.close(); await once(ws, 'close');

  const detached = await tool('job_start', { serverId, path: files, cmd: 'printf "before\\n"; sleep 2; printf "during\\n"; sleep 2; printf "after\\n"', waitMs: 0 });
  await stop(agent);
  await until(() => !app.hub.online(serverId), 'agent disconnect');
  await sleep(4500);
  assert.equal(runner.exitCode, null);
  agent = child('agent', ['--config', configFile]);
  await until(() => app.hub.online(serverId), 'agent reconnect');
  await until(() => app.store.job(detached.id).outputBytes === 20, 'offline output resumes');
  assert.equal(await output(detached.id), 'before\nduring\nafter\n');
  assert.deepEqual([...jobs, ...terminals].map(j => app.store.job(j.id).pid), pids);
  report.agentRestart = '10 process IDs preserved; offline output recovered exactly';

  await client!.close(); client = undefined;
  await app.close();
  app = await createApp({ dataDir, publicUrl: base });
  await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve));
  await until(() => app.hub.online(serverId), 'central reconnect');
  await connectMcp();
  assert.deepEqual([...jobs, ...terminals].map(j => app.store.job(j.id).pid), pids);
  await app.hub.rpc(serverId, 'terminal.input', { id: terminal.id, data: "printf 'KEPT:%s:%s\\n' \"$PWD\" \"$HOSTHERD_TEST\"\nstty size\n" });
  await until(async () => (await output(terminal.id)).includes(`KEPT:${files}:kept`) && (await output(terminal.id)).includes('42 132'), 'terminal state after central restart');
  report.centralRestart = 'jobs/terminals, shell cwd/env, resize and authentication persisted';
  assert.deepEqual(Buffer.from(await (await fetch(download.downloadUrl)).arrayBuffer()), originalBytes);
  await tool('file_transfer_cancel', { transferId: download.transferId });
  assert.equal((await fetch(download.downloadUrl)).status, 404);
  assert.deepEqual(await readFile(transferFile), originalBytes);
  Object.assign(report.fileTransfer as object, { downloadSurvivesCentralRestart: true, linkRevoked: true });

  const before = { agent: await rss(agent.pid!), runner: await rss(runner.pid!) };
  const samples = [];
  for (const size of [16, 32].map(mib => mib * 1024 * 1024)) {
    const large = await tool('job_start', { serverId, path: files, cmd: `head -c ${size} /dev/zero`, waitMs: 0 });
    await until(() => app.store.job(large.id).outputBytes === size && app.store.job(large.id).status === 'completed', 'large output completes', 120_000);
    const bytes = await readFile(app.store.outputPath(large.id));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(Buffer.alloc(size)).digest('hex'));
    samples.push({ bytes: size, agent: await rss(agent.pid!), runner: await rss(runner.pid!) });
  }
  report.largeOutput = { sha256Matched: true, rssKiB: { before, samples } };

  for (const job of jobs) await tool('job_input', { jobId: job.id, data: 'finished\n', eof: true });
  await until(() => jobs.every(j => app.store.job(j.id).status === 'completed'), 'stdin and EOF complete jobs');
  assert.equal(await output(jobs[0].id), 'received:finished\n');
  for (const term of terminals) await api(`/api/terminals/${term.id}/close`, 'POST', {});
  await until(() => terminals.every(t => app.store.job(t.id).status !== 'running'), 'terminals explicitly closed');
  report.stdinEof = 'passed';
  report.concurrentJobs = 5; report.concurrentTerminals = 5;
  await mkdir(path.resolve('artifacts'), { recursive: true });
  await writeFile(path.resolve('artifacts/native-integration.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Integration failed. Diagnostic files: ${root}`);
  throw error;
} finally {
  // Only this fixture's jobs and processes are affected.
  if (serverId && app.hub.online(serverId)) {
    for (const job of app.store.jobs().filter(j => j.status === 'running')) await app.hub.rpc(serverId, job.kind === 'terminal' ? 'terminal.close' : 'job.cancel', { id: job.id }).catch(() => {});
  }
  await client?.close();
  await stop(agent); await stop(runner); await app.close();
  if (report.stdinEof === 'passed') await rm(root, { recursive: true, force: true });
}
