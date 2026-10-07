import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { attachmentUrl, openAttachment, publicAddress } from '../src/file-source.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('attachment fetch validates URLs, pins public addresses and rejects private redirects', async t => {
  const id = randomUUID(), token = 'a'.repeat(43), route = `/files/download/${id}/${token}`;
  const fixture = createServer((req, res) => {
    if (req.url === route) { res.writeHead(302, { Location: 'https://127.0.0.1/private?secret=do-not-leak' }); res.end(); }
    else { res.writeHead(403); res.end(); }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.100.100.200', '::1', '::ffff:127.0.0.1', 'fd00::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const url of ['file:///etc/passwd', 'sandbox:/mnt/data/a.zip', 'http://example.com/a', 'https://user:password@example.com/a', base + '/healthz']) {
    assert.throws(() => attachmentUrl(url, base), { code: 'ATTACHMENT_URL_REJECTED' });
  }
  for (const url of ['https://127.1/a', 'https://[::1]/a', base + route]) {
    await assert.rejects(openAttachment(url, new AbortController().signal, base), { code: 'ATTACHMENT_URL_REJECTED' });
  }
  await assert.rejects(openAttachment(base + route.replace(token, 'b'.repeat(43)), new AbortController().signal, base), error => {
    assert.match((error as Error).message, /HTTP 403/); assert.doesNotMatch((error as Error).message, /secret=|127\.0\.0\.1/); return true;
  });
});

test('native MCP attachment upload and downloadable links transfer large bytes, enforce overwrite, expiry and revocation', async t => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-transfer-'));
  let app = await createApp({ dataDir: dir, publicUrl: base });
  await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const tokenResponse = await fetch(base + '/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'transfer test' }) });
  const pat = await tokenResponse.json() as { token: string };
  const enrollment = app.store.enrollment('File target', 'root');
  const credentials = app.store.enroll(enrollment.code, { hostname: 'fixture', version: '1.0.0', os: 'linux', arch: 'amd64' });
  const serverId = credentials.serverId;
  const payload = Buffer.alloc(8 * 1024 * 1024 + 71);
  for (let i = 0; i < payload.length; i++) payload[i] = i * 37 % 256;
  const sourcePath = '/tmp/보고서-샘플.bin';
  const files = new Map<string, Buffer>([[sourcePath, payload]]);
  const sessions = new Map<string, { id: string; generation: string; direction: string; path: string; status: string; size: number; bytes: number; chunks: Buffer[]; sha256?: string }>();
  const methods: string[] = [];
  let slowWriteReached = false;
  let ws: WebSocket;
  async function connectAgent() {
    ws = new WebSocket(base.replace('http:', 'ws:') + '/agent', { headers: { Authorization: 'Bearer ' + credentials.token } });
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'request') return;
      methods.push(message.method);
      const p = message.params;
      const reply = (result: unknown) => {
        // The real runner returns metadata only; its buffered file bytes are private.
        if (result && typeof result === 'object' && 'chunks' in result) {
          const { chunks: _chunks, ...metadata } = result; result = metadata;
        }
        ws.send(JSON.stringify({ type: 'response', id: message.id, result }));
      };
      const fail = (code: string) => ws.send(JSON.stringify({ type: 'response', id: message.id, error: { code, message: code } }));
      if (message.method === 'file.transfer.open') {
        if (p.direction === 'upload' && files.has(p.path) && !p.overwrite) return fail('FILE_EXISTS');
        if (p.direction === 'download' && !files.has(p.path)) return fail('FILE_NOT_FOUND');
        const state = { id: p.id, generation: '1.0.0', direction: p.direction, path: p.path, status: 'running', size: p.direction === 'download' ? files.get(p.path)!.length : 0, bytes: 0, chunks: [] as Buffer[] };
        sessions.set(p.id, state); reply(state); return;
      }
      const session = sessions.get(p.id);
      if (!session || p.generation !== session.generation) return fail('TRANSFER_NOT_FOUND');
      if (message.method === 'file.transfer.read') {
        const data = files.get(session.path)!.subarray(p.offset, p.offset + 512 * 1024);
        session.bytes = p.offset + data.length;
        reply({ data: data.toString('base64'), nextOffset: session.bytes, eof: session.bytes === session.size }); return;
      }
      if (message.method === 'file.transfer.write') {
        assert.equal(p.offset, session.bytes);
        const data = Buffer.from(p.data, 'base64'); assert.ok(data.length <= 512 * 1024);
        session.chunks.push(data); session.bytes += data.length;
        if (session.path === '/tmp/cancelled.bin') {
          slowWriteReached = true; setTimeout(() => reply(session), 500);
        } else reply(session);
        return;
      }
      if (message.method === 'file.transfer.commit') {
        const data = Buffer.concat(session.chunks);
        assert.equal(data.length, p.size); assert.equal(digest(data), p.sha256);
        files.set(session.path, data); session.status = 'completed'; session.sha256 = p.sha256; session.size = data.length; session.chunks = [];
        if (session.path === '/tmp/commit-response-lost.bin') fail('EXECUTION_UNKNOWN');
        else reply(session);
        return;
      }
      if (message.method === 'file.transfer.abort') {
        if (session.status === 'running') session.status = 'cancelled';
        session.chunks = []; reply(session); return;
      }
      if (message.method === 'file.transfer.status') { reply(session); return; }
      fail('UNEXPECTED_METHOD');
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '1.0.0', user: 'root' }));
    for (let i = 0; i < 100 && !app.hub.online(serverId); i++) await delay(10);
    assert.ok(app.hub.online(serverId));
  }
  await connectAgent();
  let client: Client;
  async function connectClient() {
    client = new Client({ name: 'native-file-transfer-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + pat.token } } }));
  }
  await connectClient();
  t.after(() => client.close());
  async function call(name: string, args: object, expectedError = false) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    assert.equal(Boolean(result.isError), expectedError, JSON.stringify(result));
    return { result, state: JSON.parse((result.content as { text: string }[])[0].text) };
  }
  async function complete(state: any) {
    for (let i = 0; state.status === 'running' && i < 500; i++) {
      await delay(10); state = (await call('file_transfer_status', { transferId: state.transferId })).state;
    }
    assert.equal(state.status, 'completed'); return state;
  }
  const tools = await client.listTools();
  const uploadTool = tools.tools.find(tool => tool.name === 'file_upload')!;
  assert.deepEqual(uploadTool._meta?.['openai/fileParams'], ['file']);
  const fileSchema = uploadTool.inputSchema.properties!.file as any;
  assert.deepEqual(Object.keys(fileSchema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(fileSchema.required.sort(), ['download_url', 'file_id']);
  assert.equal(uploadTool.inputSchema.properties!.overwrite && (uploadTool.inputSchema.properties!.overwrite as any).default, false);
  assert.match(client.getInstructions()!, /file_upload.*file_download.*file_transfer_status/);
  const downloadRequest = { serverId, path: sourcePath, waitMs: 0, requestId: randomUUID() };
  const initial = await call('file_download', downloadRequest);
  assert.equal(initial.state.status, 'running');
  const download = await complete(initial.state);
  assert.equal(download.size, payload.length); assert.equal(download.sha256, digest(payload));
  const listed = await call('file_transfer_status', { transferId: download.transferId });
  assert.deepEqual((listed.result.content as any[]).find(item => item.type === 'resource_link'), { type: 'resource_link', uri: download.downloadUrl, name: '보고서-샘플.bin', mimeType: 'application/octet-stream', size: payload.length });
  assert.ok(JSON.stringify(listed.result).length < 4000, 'file bytes must not enter model context');
  const response = await fetch(download.downloadUrl);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition')!, /attachment;.*filename\*/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  const head = await fetch(download.downloadUrl, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(payload.length));
  const ranged = await fetch(download.downloadUrl, { headers: { Range: 'bytes=10-29' } });
  assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), payload.subarray(10, 30));
  const tampered = new URL(download.downloadUrl); tampered.pathname = tampered.pathname.slice(0, -1) + (tampered.pathname.endsWith('a') ? 'b' : 'a');
  assert.equal((await fetch(tampered)).status, 404);
  const duplicate = await call('file_download', downloadRequest);
  assert.equal(duplicate.state.transferId, download.transferId);
  const conflict = await call('file_download', { ...downloadRequest, path: '/other' }, true);
  assert.equal(conflict.state.code, 'REQUEST_CONFLICT');
  const uploadRequest = { serverId, path: '/tmp/upload.bin', file: { download_url: download.downloadUrl, file_id: 'file-test-native' }, waitMs: 0, requestId: randomUUID() };
  const upload = await complete((await call('file_upload', uploadRequest)).state);
  assert.equal(upload.size, payload.length); assert.equal(upload.sha256, digest(payload));
  assert.deepEqual(files.get('/tmp/upload.bin'), payload);
  assert.equal((await call('file_upload', uploadRequest)).state.transferId, upload.transferId);
  assert.equal((await call('file_upload', { ...uploadRequest, requestId: randomUUID(), waitMs: 60000 }, true)).state.code, 'FILE_EXISTS', 'waits above the cap are clamped, not rejected');
  assert.deepEqual(files.get('/tmp/upload.bin'), payload);
  const protectedUrl = await call('file_upload', { ...uploadRequest, file: { download_url: 'https://127.0.0.1/metadata?secret=do-not-leak', file_id: 'private' }, path: '/tmp/private', requestId: randomUUID(), waitMs: 5000 }, true);
  assert.equal(protectedUrl.state.code, 'ATTACHMENT_URL_REJECTED'); assert.ok(!files.has('/tmp/private'));
  const slow = (await call('file_upload', { ...uploadRequest, path: '/tmp/cancelled.bin', requestId: randomUUID() })).state;
  for (let i = 0; !slowWriteReached && i < 100; i++) await delay(10);
  assert.ok(slowWriteReached);
  const cancelled = await call('file_transfer_cancel', { transferId: slow.transferId });
  assert.equal(cancelled.state.status, 'cancelled'); assert.ok(!files.has('/tmp/cancelled.bin'));
  const uncertain = (await call('file_upload', { ...uploadRequest, path: '/tmp/commit-response-lost.bin', requestId: randomUUID(), waitMs: 5000 })).state;
  assert.equal(uncertain.status, 'unknown'); assert.equal(uncertain.errorCode, 'TRANSFER_COMMIT_UNKNOWN');
  assert.deepEqual(files.get('/tmp/commit-response-lost.bin'), payload);
  assert.ok([...sessions.values()].every(session => session.status !== 'running'), 'finished and failed transfers release remote descriptors');
  assert.ok(methods.filter(method => method === 'file.transfer.write').length > 1);

  // Completed snapshots and signing key must survive a central process restart.
  await client.close(); await app.close();
  app = await createApp({ dataDir: dir, publicUrl: base });
  await new Promise<void>(resolve => app.server.listen(port, '127.0.0.1', resolve));
  await connectAgent(); await connectClient();
  const reconciled = (await call('file_transfer_status', { transferId: uncertain.transferId })).state;
  assert.equal(reconciled.status, 'completed'); assert.equal(reconciled.sha256, digest(payload));
  assert.deepEqual(Buffer.from(await (await fetch(download.downloadUrl)).arrayBuffer()), payload);
  await call('file_transfer_cancel', { transferId: download.transferId });
  assert.equal((await fetch(download.downloadUrl)).status, 404);
  assert.deepEqual(files.get(sourcePath), payload);
  const expiring = await complete((await call('file_download', { serverId, path: sourcePath, waitMs: 0 })).state);
  const row = app.store.db.prepare('SELECT state FROM file_transfers WHERE id=?').get(expiring.transferId) as { state: string };
  const expired = { ...JSON.parse(row.state), expiresAt: new Date(Date.now() - 1).toISOString() };
  app.store.db.prepare('UPDATE file_transfers SET state=? WHERE id=?').run(JSON.stringify(expired), expiring.transferId);
  assert.equal((await fetch(expiring.downloadUrl)).status, 404);
  assert.equal((await call('file_transfer_status', { transferId: expiring.transferId })).state.status, 'expired');
  await assert.rejects(readFile(path.join(dir, 'file-transfers', expiring.transferId + '.bin')), { code: 'ENOENT' });
});
