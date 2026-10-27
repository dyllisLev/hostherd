import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { createApp, trustProxy } from '../src/app.js';
import { textChunk } from '../src/mcp.js';
import { VERSION } from '../src/version.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(20); }
  assert.ok(predicate(), 'condition became true');
}

test('output is byte-exact across retransmission and reopening; retention only removes ended records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-store-'));
  let store = new Store(dir);
  try {
    const { code } = store.enrollment('target');
    assert.throws(() => store.enroll(code, { hostname: 'test' }), { code: 'INVALID_EXECUTION_USER' });
    const { serverId, executionUser } = store.enroll(code, { hostname: 'test', executionUser: 'root' });
    assert.equal(executionUser, 'root');
    const id = randomUUID();
    store.saveJob(serverId, { id, kind: 'job', path: '/tmp', cmd: 'generate', status: 'running', startedAt: new Date().toISOString() });
    const data = Buffer.from('한글\u0000\u001b[32mbytes\n'.repeat(70_000));
    let cursor = 0;
    while (cursor < data.length) {
      const chunk = data.subarray(cursor, cursor + 65536);
      const next = await store.appendOutput(serverId, id, cursor, chunk);
      assert.equal(await store.appendOutput(serverId, id, cursor, chunk), next);
      cursor = next;
    }
    store.close(); store = new Store(dir);
    assert.equal(store.job(id).outputBytes, data.length);
    const full = await readFile(store.outputPath(id));
    assert.equal(createHash('sha256').update(full).digest('hex'), createHash('sha256').update(data).digest('hex'));
    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    const ended = randomUUID(), active = randomUUID();
    store.saveJob(serverId, { id: ended, kind: 'job', path: '/', cmd: 'true', status: 'completed', startedAt: old, endedAt: old });
    store.saveJob(serverId, { id: active, kind: 'terminal', path: '/', cmd: '', status: 'running', startedAt: old });
    await store.cleanup();
    assert.equal(store.jobs().length, 2);
    assert.equal(store.job(id).status, 'running');
    assert.equal(store.job(active).status, 'running');
    assert.throws(() => store.job(ended), { code: 'JOB_NOT_FOUND' });
    // Running jobs of a server deleted over 30 days ago expire too; dedupe rows of expired jobs go with them.
    const gone = store.enroll(store.enrollment('gone').code, { hostname: 'gone', executionUser: 'root' }).serverId;
    const orphan = randomUUID(), requestId = randomUUID();
    store.saveJob(gone, { id: orphan, kind: 'job', path: '/', cmd: 'sleep', status: 'running', startedAt: old });
    store.rememberRequest(requestId, { cmd: 'sleep' }, orphan);
    store.deleteServer(gone);
    await store.cleanup();
    assert.equal(store.job(orphan).status, 'running', 'a recent deletion keeps the record');
    store.db.prepare('UPDATE servers SET deleted_at=? WHERE id=?').run(old, gone);
    await store.cleanup();
    assert.throws(() => store.job(orphan), { code: 'JOB_NOT_FOUND' });
    assert.equal(store.request(requestId, { cmd: 'other' }), undefined);
    assert.equal(store.job(active).status, 'running');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real MCP transport authenticates, dispatches once per request ID, saves output and rejects offline dispatch', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-api-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const tokenResponse = await fetch(`${base}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'integration' }) });
  assert.equal(tokenResponse.status, 201);
  const pat = await tokenResponse.json() as { token: string; id: string };
  const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('WWW-Authenticate')!, /oauth-protected-resource/);
  const { code } = app.store.enrollment('Integration target');
  const missingAccount = await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0' }) });
  assert.equal(missingAccount.status, 400);
  const enrolled = await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' }) });
  assert.equal(enrolled.status, 201);
  const credentials = await enrolled.json() as { token: string; serverId: string; executionUser: string };
  assert.equal(credentials.executionUser, 'root');
  assert.equal(app.store.server(credentials.serverId).executionUser, 'root');
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${credentials.token}` } });
  let starts = 0;
  const imageData = Buffer.from('opaque image bytes supplied by the validating runner').toString('base64');
  const methods: string[] = [];
  let welcome: { publicUrl?: string } | undefined;
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'welcome') welcome = m;
    if (m.type !== 'request') return;
    methods.push(m.method);
    if (m.method === 'file.image') {
      const error = m.params.path === '/missing.png' ? { code: 'IMAGE_NOT_FOUND', message: 'Save the image first, then use the same server and its absolute file path.' } : undefined;
      ws.send(JSON.stringify({ type: 'response', id: m.id, ...(error ? { error } : { result: { data: imageData, mimeType: 'image/png', width: 1280, height: 720, size: Buffer.from(imageData, 'base64').length } }) }));
      return;
    }
    if (m.method === 'job.start') {
      starts++;
      if (m.params.path === '/bin/bash') {
        ws.send(JSON.stringify({ type: 'response', id: m.id, error: { code: 'INVALID_WORKDIR', message: 'Invalid working directory path="/bin/bash": the path is a file, not a directory. The command was not started.' } }));
        return;
      }
      const state = { id: m.params.id, kind: 'job', path: m.params.path, cmd: m.params.cmd, status: 'running', startedAt: new Date().toISOString(), runnerVersion: '0.1.0' };
      ws.send(JSON.stringify({ type: 'state', job: state }));
      ws.send(JSON.stringify({ type: 'output', jobId: state.id, offset: 0, data: Buffer.from('hello\n').toString('base64') }));
      // The initial-output assertion requires these bytes before the reply;
      // sending the reply first races the central's asynchronous disk flush.
      ws.send(JSON.stringify({ type: 'response', id: m.id, result: state }));
    }
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', user: 'root' }));
  await eventually(() => app.hub.online(credentials.serverId));
  await eventually(() => welcome !== undefined);
  assert.equal(welcome!.publicUrl, 'http://localhost:3000');
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pat.token}` } } }));
  t.after(() => client.close());
  const list = await client.listTools();
  assert.ok(list.tools.some(t => t.name === 'job_start'));
  assert.ok(list.tools.some(t => t.name === 'file_edit'));
  const startTool = list.tools.find(t => t.name === 'job_start')!;
  assert.deepEqual(startTool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  const serversTool = list.tools.find(t => t.name === 'servers_list')!;
  assert.deepEqual(serversTool.annotations, { readOnlyHint: true, openWorldHint: false });
  const pathSchema = startTool.inputSchema.properties!.path as { description?: string; examples?: string[]; pattern?: string };
  assert.match(pathSchema.description!, /working DIRECTORY/);
  assert.match(pathSchema.description!, /not.*shell.*executable/);
  assert.ok(pathSchema.examples?.includes('/'));
  assert.equal(new RegExp(pathSchema.pattern!).test('bin/bash'), false);
  assert.match(client.getInstructions()!, /same request/);
  assert.match(client.getInstructions()!, /image_read/);
  const imageTool = list.tools.find(t => t.name === 'image_read')!;
  assert.equal(imageTool.annotations?.readOnlyHint, true);
  assert.equal(imageTool.annotations?.openWorldHint, false);
  assert.match(imageTool.description!, /SAME serverId/);
  assert.match(imageTool.description!, /wait for that job to complete successfully/);
  const imagePath = imageTool.inputSchema.properties!.path as { description: string; examples: string[] };
  assert.match(imagePath.description, /image FILE/);
  assert.ok(imagePath.examples.includes('/tmp/screenshot.png'));
  const beforeImage = methods.length;
  const imageResult = await client.callTool({ name: 'image_read', arguments: { serverId: credentials.serverId, path: '/tmp/screenshot.png' } });
  assert.notEqual(imageResult.isError, true);
  const imageContent = imageResult.content as { type: string; data?: string; mimeType?: string; text?: string }[];
  assert.deepEqual(imageContent.find(c => c.type === 'image'), { type: 'image', data: imageData, mimeType: 'image/png' });
  const imageMetadata = JSON.parse(imageContent.find(c => c.type === 'text')!.text!);
  assert.equal(imageMetadata.path, '/tmp/screenshot.png'); assert.equal(imageMetadata.width, 1280);
  assert.ok(!('data' in imageMetadata), 'image bytes must not also become text tokens');
  assert.deepEqual(methods.slice(beforeImage), ['file.image'], 'image reading must not need a preliminary file query or pagination');
  for (const [imagePath, code] of [['/missing.png', 'IMAGE_NOT_FOUND']]) {
    const failed = await client.callTool({ name: 'image_read', arguments: { serverId: credentials.serverId, path: imagePath } });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse((failed.content as { text: string }[])[0].text).code, code);
  }
  const beforeInvalidImage = methods.length;
  const invalidImage = await client.callTool({ name: 'image_read', arguments: { serverId: credentials.serverId, path: 'https://example.com/image.png' } });
  assert.equal(invalidImage.isError, true);
  assert.equal(methods.length, beforeInvalidImage, 'a URL must fail schema validation without reaching the target');
  const request = { serverId: credentials.serverId, path: '/tmp', cmd: 'echo hello', requestId: randomUUID(), waitMs: 100 };
  const result = await client.callTool({ name: 'job_start', arguments: request });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = result.content as { type: string; text: string }[];
  const job = JSON.parse(content[0].text);
  assert.equal(job.status, 'running');
  assert.equal(job.output.text, 'hello\n');
  assert.equal(job.output.data, undefined, 'text output is not repeated as base64');
  // Pages end on character boundaries; non-UTF-8 bytes come back as base64.
  await app.store.appendOutput(credentials.serverId, job.jobId, 6, Buffer.from('가나'));
  const output = async (cursor: number, limit?: number) => JSON.parse(((await client.callTool({ name: 'job_output', arguments: { jobId: job.jobId, cursor, limit } })).content as { text: string }[])[0].text);
  assert.deepEqual(await output(6, 4), { cursor: 6, nextCursor: 9, eof: false, text: '가', status: 'running' });
  assert.deepEqual(await output(9, 4), { cursor: 9, nextCursor: 12, eof: true, text: '나', status: 'running' });
  await app.store.appendOutput(credentials.serverId, job.jobId, 12, Buffer.from([0xff, 0xfe, 0x00]));
  assert.deepEqual(await output(12), { cursor: 12, nextCursor: 15, eof: true, data: '//4A', encoding: 'base64', status: 'running' });
  await client.callTool({ name: 'job_start', arguments: request });
  assert.equal(starts, 1);
  const conflict = await client.callTool({ name: 'job_start', arguments: { ...request, cmd: 'different' } });
  assert.equal(conflict.isError, true);
  const beforeInvalid = methods.length;
  const invalidRequest = { ...request, path: '/bin/bash', requestId: randomUUID() };
  const invalid = await client.callTool({ name: 'job_start', arguments: invalidRequest });
  assert.equal(invalid.isError, true);
  const failure = JSON.parse((invalid.content as { type: string; text: string }[])[0].text);
  assert.equal(failure.code, 'INVALID_WORKDIR');
  assert.equal(failure.status, 'failed');
  assert.match(failure.error, /working directory.*\/bin\/bash/);
  assert.equal(app.store.job(failure.jobId).errorCode, 'INVALID_WORKDIR');
  assert.equal(app.store.server(credentials.serverId).fault, null);
  assert.deepEqual(methods.slice(beforeInvalid), ['job.start'], 'validation must not add a separate target request');
  const invalidRetry = await client.callTool({ name: 'job_start', arguments: invalidRequest });
  assert.equal(invalidRetry.isError, true);
  assert.equal(JSON.parse((invalidRetry.content as { text: string }[])[0].text).jobId, failure.jobId);
  assert.equal(starts, 2, 'retry must reuse the retained failure');
  const corrected = await client.callTool({ name: 'job_start', arguments: { ...invalidRequest, path: '/tmp', requestId: randomUUID() } });
  assert.notEqual(corrected.isError, true);
  assert.equal(starts, 3);
  app.store.saveJob(credentials.serverId, { id: randomUUID(), kind: 'job', path: '/', cmd: 'x'.repeat(400), status: 'completed', startedAt: new Date(Date.now() + 1000).toISOString(), endedAt: new Date().toISOString() });
  const jobsList = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'jobs_list', arguments: args })).content as { text: string }[])[0].text);
  const newest = await jobsList({ limit: 1 });
  assert.equal(newest.jobs.length, 1); assert.equal(newest.more, true); assert.equal(newest.total, 4);
  assert.match(newest.jobs[0].cmd, /^x{300}… \[400 chars/);
  assert.deepEqual((await jobsList({ status: 'failed' })).jobs.map((item: { id: string }) => item.id), [failure.jobId]);
  ws.close(); await once(ws, 'close');
  await eventually(() => !app.hub.online(credentials.serverId));
  const offline = await client.callTool({ name: 'job_start', arguments: { ...request, requestId: randomUUID() } });
  assert.equal(offline.isError, true);
  assert.equal(starts, 3);
  assert.equal(app.store.job(job.jobId).status, 'running');
  const removed = await fetch(`${base}/api/servers/${credentials.serverId}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(removed.status, 200);
  assert.equal(app.store.authenticateAgent(credentials.token), null);
  assert.equal(app.store.job(job.jobId).status, 'running');
  // The deleted server's jobs stay running in history but no longer count as running.
  assert.ok(!app.store.jobCounts(new Date(0).toISOString()).runningJobs);
  assert.equal(app.store.runningByServer()[credentials.serverId], undefined);
  await fetch(`${base}/api/tokens/${pat.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  const revoked = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(revoked.status, 401);
});

test('a finished job fault resent on reconnect stays cleared; the admin can clear a shown fault', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-fault-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const { code } = app.store.enrollment('Fault target');
  const { serverId, token } = app.store.enroll(code, { hostname: 'fixture', executionUser: 'root' });
  const stopped = { id: randomUUID(), kind: 'job', path: '/', cmd: 'grep -rIa x /', status: 'interrupted', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    error: 'runner stopped; process continuity cannot be guaranteed', errorCode: 'RUNNER_STOPPED' };
  const connect = async () => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${token}` } });
    await once(ws, 'open');
    const send = (message: unknown) => ws.send(JSON.stringify(message));
    send({ type: 'hello', protocol: 1, version: '1.0.0', hostname: 'fixture', os: 'linux', arch: 'amd64', user: 'root' });
    send({ type: 'state', job: stopped });
    send({ type: 'fault', message: `${stopped.id}: ${stopped.error}` });
    // Messages are processed in order; a later state marks the fault as handled.
    const marker = { id: randomUUID(), kind: 'job', path: '/', cmd: 'true', status: 'running', startedAt: new Date().toISOString() };
    send({ type: 'state', job: marker });
    await eventually(() => app.store.jobs().some(job => job.id === marker.id));
    return { ws, send };
  };
  let agent = await connect();
  assert.equal(app.store.server(serverId).fault, `${stopped.id}: ${stopped.error}`);
  const cleared = await fetch(`${base}/api/servers/${serverId}/fault`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(cleared.status, 200);
  assert.equal(app.store.server(serverId).fault, null);
  agent.ws.close(); await once(agent.ws, 'close');
  agent = await connect();
  assert.equal(app.store.server(serverId).fault, null, 'a past fault must not reappear on reconnect');
  agent.send({ type: 'fault', message: 'read job inventory: permission denied' });
  await eventually(() => app.store.server(serverId).fault === 'read job inventory: permission denied');
  agent.ws.close(); await once(agent.ws, 'close');
});

test('schema migration backfills job status and start time of an existing database once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-schema-'));
  try {
    const original = new Database(path.join(dir, 'hostherd.sqlite'));
    original.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, execution_user TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        hostname TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '',
        last_seen TEXT, created_at TEXT NOT NULL, deleted_at TEXT, fault TEXT);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id), kind TEXT NOT NULL,
        state TEXT NOT NULL, output_bytes INTEGER NOT NULL DEFAULT 0, ended_at TEXT, expired INTEGER NOT NULL DEFAULT 0);`);
    original.prepare(`INSERT INTO servers (id,name,execution_user,token_hash,created_at) VALUES ('s','old','root','h',?)`).run(new Date().toISOString());
    const startedAt = new Date().toISOString();
    original.prepare(`INSERT INTO jobs (id,server_id,kind,state) VALUES ('first-job','s','job',?)`).run(JSON.stringify({ id: 'first-job', kind: 'job', path: '/', cmd: 'uptime', status: 'failed', startedAt }));
    original.close();
    let store = new Store(dir);
    assert.equal(store.db.pragma('user_version', { simple: true }), 3);
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get());
    assert.deepEqual(store.jobPage({ status: 'failed', limit: 10, offset: 0 }).items.map(job => job.id), ['first-job']);
    store.close(); store = new Store(dir);
    assert.equal(store.jobPage({ q: 'UPTIME', limit: 10, offset: 0 }).total, 1);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('web API pages jobs, buckets activity by the client offset, renames servers and pushes change events', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-webapi-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const events = new AbortController();
  t.after(async () => { events.abort(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const get = async <T>(url: string) => { const response = await fetch(base + url, { headers: { Cookie: cookie } }); assert.equal(response.status, 200, url); return await response.json() as T; };
  const { code } = app.store.enrollment('Web target');
  const { serverId } = app.store.enroll(code, { hostname: 'fixture', executionUser: 'root' });
  // 16:30 UTC two days ago is already the next calendar day at UTC+9.
  const utcDay = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  const lateUtc = `${utcDay}T16:30:00.000Z`;
  const nextDay = new Date(Date.parse(lateUtc) + 9 * 3600_000).toISOString().slice(0, 10);
  for (let i = 0; i < 3; i++) app.store.saveJob(serverId, { id: randomUUID(), kind: 'job', path: '/srv', cmd: `deploy ${i}`, status: 'completed', startedAt: new Date(Date.now() - i * 1000).toISOString(), endedAt: new Date().toISOString() });
  app.store.saveJob(serverId, { id: randomUUID(), kind: 'job', path: '/var/log', cmd: 'grep error', status: 'failed', startedAt: lateUtc, endedAt: lateUtc, exitCode: 1 });
  app.store.saveJob(serverId, { id: randomUUID(), kind: 'terminal', path: '/', cmd: '', status: 'running', startedAt: new Date().toISOString() });

  const page = await get<{ items: { cmd: string }[]; total: number }>('/api/jobs?kind=job&limit=2&offset=0');
  assert.equal(page.total, 4); assert.equal(page.items.length, 2); assert.equal(page.items[0].cmd, 'deploy 0');
  assert.deepEqual((await get<{ items: { cmd: string }[] }>('/api/jobs?kind=job&status=failed&q=GREP')).items.map(job => job.cmd), ['grep error']);
  const seoul = await get<{ activity: { date: string; failed: number }[]; activeTerminals: number; recentJobs: unknown[] }>('/api/dashboard?days=7&tzOffset=540');
  assert.equal(seoul.activity.find(day => day.date === nextDay)?.failed, 1);
  const utc = await get<{ activity: { date: string; failed: number }[] }>('/api/dashboard?days=7&tzOffset=0');
  assert.equal(utc.activity.find(day => day.date === utcDay)?.failed, 1);
  assert.equal(seoul.activeTerminals, 1); assert.equal(seoul.recentJobs.length, 4);

  const stream = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: events.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body!.getReader(); let received = '';
  const renamed = await fetch(`${base}/api/servers/${serverId}`, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '  Renamed  ' }) });
  assert.equal(renamed.status, 200);
  assert.equal((await get<{ name: string; online: boolean }>(`/api/servers/${serverId}`)).name, 'Renamed');
  while (!received.includes('event: servers')) received += new TextDecoder().decode((await reader.read()).value);
  const anonymous = await fetch(`${base}/api/events`);
  assert.equal(anonymous.status, 401);

  const terminal = (await get<{ items: { id: string }[] }>('/api/jobs?kind=terminal')).items[0];
  const labelled = await fetch(`${base}/api/jobs/${terminal.id}`, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: ' deploy shell ' }) });
  assert.equal((await labelled.json()).label, 'deploy shell');
  // Agent state updates keep the central-owned label.
  app.store.saveJob(serverId, { id: terminal.id, kind: 'terminal', path: '/', cmd: '', status: 'completed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  assert.equal(app.store.job(terminal.id).label, 'deploy shell');
  const output = Buffer.from('line 1\n\u001b[31mred\u001b[0m 한글\n');
  await app.store.appendOutput(serverId, terminal.id, 0, output);
  const download = await fetch(`${base}/api/jobs/${terminal.id}/output/download`, { headers: { Cookie: cookie } });
  assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="hostherd-terminal-/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), output);
});

test('Windows agents enroll with DOMAIN\\name accounts and Windows paths pass validation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-windows-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const issued = await (await fetch(`${base}/api/enrollments`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'win' }) })).json() as { code: string; windowsCommand: string };
  assert.match(issued.windowsCommand, /downloads\/install\.ps1/);
  assert.ok(issued.windowsCommand.includes(`-Code '${issued.code}'`));
  for (const [user, ok] of [['PC-01\\Jane Doe', true], ['NT AUTHORITY\\SYSTEM', true], ['root', true], ['bad\\na:me', false], ['two\\back\\slashes', false]] as const) {
    const { code } = app.store.enrollment('candidate');
    const response = await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'win-host', os: 'windows', arch: 'amd64', version: '0.2.6', executionUser: user }) });
    assert.equal(response.status, ok ? 201 : 400, user);
  }
  const terminal = await fetch(`${base}/api/terminals`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId: randomUUID(), path: 'C:\\Users' }) });
  assert.equal(terminal.status, 404, 'a Windows start path passes validation and reaches the server lookup');
  const relative = await fetch(`${base}/api/terminals`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId: randomUUID(), path: 'Users' }) });
  assert.equal(relative.status, 400);
});

test('dashboard failure notice counts only failures after the administrator acknowledges it', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-ack-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const dashboard = async () => (await (await fetch(`${base}/api/dashboard`, { headers: { Cookie: cookie } })).json()) as { failedJobs24h: number; unacknowledgedFailures24h: number };
  const { code } = app.store.enrollment('fixture');
  const { serverId } = await (await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'fixture', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' }) })).json() as { serverId: string };
  const fail = () => {
    const now = new Date().toISOString();
    app.store.saveJob(serverId, { id: randomUUID(), kind: 'job', path: '/', cmd: 'false', status: 'failed', startedAt: now, endedAt: now, exitCode: 1 });
  };
  fail();
  assert.deepEqual(await dashboard().then(d => [d.failedJobs24h, d.unacknowledgedFailures24h]), [1, 1]);
  assert.equal((await fetch(`${base}/api/dashboard/failures/acknowledge`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.deepEqual(await dashboard().then(d => [d.failedJobs24h, d.unacknowledgedFailures24h]), [1, 0]);
  await sleep(5); fail();
  assert.deepEqual(await dashboard().then(d => [d.failedJobs24h, d.unacknowledgedFailures24h]), [2, 1]);
});

test('deleting a server can ask its agent to uninstall first; the registration is deleted whatever the outcome', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-uninstall-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  type Agent = { ws: WebSocket; requests: { id: string; method: string }[]; closed: Promise<number> };
  const enroll = (name: string) => { const { code } = app.store.enrollment(name); return app.store.enroll(code, { hostname: name, executionUser: 'root' }); };
  const connect = async (token: string, capabilities: string[] | undefined, reply?: (request: { id: string; method: string }) => unknown): Promise<Agent> => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${token}` } });
    const requests: Agent['requests'] = [];
    const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)));
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'request') return;
      requests.push(message);
      if (reply) ws.send(JSON.stringify({ type: 'response', id: message.id, ...reply(message) as object }));
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, version: '0.1.0', hostname: 'fixture', os: 'linux', arch: 'amd64', user: 'root', ...(capabilities ? { capabilities } : {}) }));
    return { ws, requests, closed };
  };
  const remove = async (id: string, body?: unknown) => {
    const response = await fetch(`${base}/api/servers/${id}`, { method: 'DELETE', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200);
    return await response.json() as { ok: boolean; uninstall?: { status: string; code?: string } };
  };
  const listed = async (id: string) => (await (await fetch(`${base}/api/servers`, { headers: { Cookie: cookie } })).json() as { id: string; canUninstall: boolean }[]).find(server => server.id === id);
  const gone = async (id: string) => assert.equal((await fetch(`${base}/api/servers/${id}`, { headers: { Cookie: cookie } })).status, 404);

  // A supporting agent accepts; central deletes the registration after the reply.
  const current = enroll('current');
  const agent = await connect(current.token, ['metrics', 'uninstall'], () => ({ result: { accepted: true } }));
  await eventually(() => app.hub.canUninstall(current.serverId));
  assert.equal((await listed(current.serverId))?.canUninstall, true);
  assert.deepEqual(await remove(current.serverId, { uninstall: true }), { ok: true, uninstall: { status: 'accepted' } });
  assert.deepEqual(agent.requests.map(r => r.method), ['agent.uninstall']);
  assert.equal(await agent.closed, 4003);
  await gone(current.serverId);

  // A failed removal still deletes the registration and is reported.
  const failing = enroll('failing');
  const broken = await connect(failing.token, ['uninstall'], () => ({ error: { code: 'operation_failed', message: 'systemd-run: not found' } }));
  await eventually(() => app.hub.canUninstall(failing.serverId));
  const failed = await remove(failing.serverId, { uninstall: true });
  assert.equal(failed.uninstall?.status, 'failed');
  assert.equal(failed.uninstall?.code, 'operation_failed');
  assert.equal(await broken.closed, 4003);
  await gone(failing.serverId);

  // Offline servers cannot remove the agent; a plain delete only drops the registration.
  const offline = enroll('offline');
  assert.equal((await remove(offline.serverId, { uninstall: true })).uninstall?.code, 'SERVER_OFFLINE');
  await gone(offline.serverId);
  const plain = enroll('plain');
  assert.deepEqual(await remove(plain.serverId), { ok: true });
  await gone(plain.serverId);
});

test('MCP text chunks end on UTF-8 boundaries and fall back to base64 for binary bytes', () => {
  const bytes = Buffer.from('a가😀');
  assert.deepEqual(textChunk(bytes.subarray(0, 3), false), { text: 'a', length: 1 });
  assert.deepEqual(textChunk(bytes.subarray(0, 6), false), { text: 'a가', length: 4 });
  assert.deepEqual(textChunk(bytes, false), { text: 'a가😀', length: 8 });
  assert.deepEqual(textChunk(bytes.subarray(4, 6), false), { data: bytes.subarray(4, 6).toString('base64'), encoding: 'base64', length: 2 }, 'a lone partial character is returned');
  assert.deepEqual(textChunk(bytes.subarray(0, 3), true), { data: bytes.subarray(0, 3).toString('base64'), encoding: 'base64', length: 3 });
  assert.deepEqual(textChunk(Buffer.alloc(0), false), { text: '', length: 0 });
});

test('TRUST_PROXY accepts hop counts, booleans and address lists', () => {
  assert.equal(trustProxy(undefined), 1);
  assert.equal(trustProxy(''), 1);
  assert.equal(trustProxy('2'), 2);
  assert.equal(trustProxy('false'), false);
  assert.equal(trustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
});

test('invalid OAuth requests return 4xx with a standard error body and server faults stay 500', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-http-errors-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  t.after(async () => { console.error = original; await app.close(); await rm(dir, { recursive: true, force: true }); });

  const interaction = await fetch(`${base}/oauth/interaction/00000000-0000-4000-8000-000000000001`);
  assert.equal(interaction.status, 400);
  assert.deepEqual(await interaction.json(), { error: 'interaction session id cookie not found', code: 'invalid_request' });
  assert.equal(logged.some(line => line.startsWith('Request failed')), false);

  const token = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' });
  assert.equal(token.status, 400);
  const tokenBody = await token.json() as { error?: string; error_description?: string; code?: string };
  assert.equal(tokenBody.error, 'invalid_request');
  assert.equal(typeof tokenBody.error_description, 'string');
  assert.equal(tokenBody.code, undefined);

  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const missing = await fetch(`${base}/api/jobs/${randomUUID()}`, { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { code: string }).code, 'JOB_NOT_FOUND');

  const { code } = app.store.enrollment('target');
  const { serverId } = app.store.enroll(code, { hostname: 't', executionUser: 'root' });
  const id = randomUUID();
  const now = new Date().toISOString();
  app.store.saveJob(serverId, { id, kind: 'job', path: '/', cmd: 'true', status: 'completed', startedAt: now, endedAt: now });
  app.store.db.prepare('UPDATE jobs SET output_bytes=4 WHERE id=?').run(id);
  logged.length = 0;
  const broken = await fetch(`${base}/api/jobs/${id}/output`, { headers: { Cookie: cookie } });
  assert.equal(broken.status, 500);
  assert.equal((await broken.json() as { code: string }).code, 'INTERNAL_ERROR');
  assert.ok(logged.some(line => line.startsWith('Request failed:')));
});

test('reported version matches the release version in package.json', async () => {
  const root = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, root.version);
});
