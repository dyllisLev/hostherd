import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { RequestLogs, redactText } from '../src/request-logs.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 150; i++) { const value = await read(); if (accept(value)) return value; await delay(20); }
  const value = await read(); assert.ok(accept(value), label); return value;
}

interface Log {
  traceId: string; receivedAt: string; endedAt?: string; durationMs?: number; httpMethod: string; httpPath: string;
  httpStatus?: number; rpcId?: string | number; method?: string; tool?: string; serverId?: string; serverName?: string;
  executionUser?: string; clientId?: string; subject?: string; clientName?: string; userAgent?: string;
  requestId?: string; jobId?: string; transferId?: string; arguments?: Record<string, unknown>; result?: unknown;
  outcome: string; errorCode?: string; error?: string; failureStage?: string; mcpIsError?: boolean; jsonRpcErrorCode?: number;
}
interface Detail { request: Log; events: { seq: number; at: string; stage: string; status: string; data?: unknown }[]; job?: { id: string; status: string; outputBytes: number; exitCode?: number }; transfer?: { transferId: string; status: string; bytes: number; size?: number; errorCode?: string }; collection: { startedAt: string; status: string; failedWrites: number } }
interface Listing { items: Log[]; nextCursor?: string | null; collection: Detail['collection'] }

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-request-logs-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'trace-owner', password: 'trace-test-password', setupToken }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const tokenResponse = await fetch(base + '/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'trace fixture client' }) });
  assert.equal(tokenResponse.status, 201);
  const pat = await tokenResponse.json() as { token: string };
  const enrollment = app.store.enrollment('Trace target', 'root');
  const credentials = app.store.enroll(enrollment.code, { hostname: 'trace-fixture', os: 'linux', arch: 'amd64', version: '1.0.0' });
  const offline = app.store.enroll(app.store.enrollment('Offline trace target', 'root').code, { hostname: 'offline-fixture' });
  const serverId = credentials.serverId;
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/agent', { headers: { Authorization: 'Bearer ' + credentials.token } });
  const rpc: { id: string; method: string; params: any }[] = [];
  const output = Buffer.from('OUTPUT_PRIVATE_CANARY\n'.repeat(20_000));
  const fileBytes = Buffer.from('FILE_PRIVATE_CANARY\u0000한글\n');
  const imageBytes = Buffer.from('IMAGE_PRIVATE_CANARY'.repeat(100_000));
  const transferPaths = new Map<string, string>();
  let stalled: { id: string; params: any } | undefined;
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'request') return;
    rpc.push(message);
    const p = message.params;
    const reply = (result: unknown) => ws.send(JSON.stringify({ type: 'response', id: message.id, result }));
    const fail = (code: string, text: string) => ws.send(JSON.stringify({ type: 'response', id: message.id, error: { code, message: text } }));
    if (message.method === 'file.read') {
      if (p.path === '/denied.txt') return fail('EACCES', 'Permission denied: /denied.txt');
      if (p.path === '/stalled.txt') { stalled = message; return; }
      if (p.path === '/slow.txt') { setTimeout(() => reply({ data: fileBytes.toString('base64'), size: fileBytes.length, nextOffset: fileBytes.length, eof: true }), 80); return; }
      return reply({ data: fileBytes.toString('base64'), size: fileBytes.length, nextOffset: fileBytes.length, eof: true });
    }
    if (message.method === 'file.list') return reply([{ name: 'example.txt', path: p.path + '/example.txt', type: 'file', size: fileBytes.length }]);
    if (message.method === 'file.image') return reply({ data: imageBytes.toString('base64'), mimeType: 'image/png', width: 640, height: 480, size: imageBytes.length });
    if (message.method === 'file.transfer.open') { transferPaths.set(p.id, p.path); return reply({ id: p.id, generation: 'trace-fixture', size: fileBytes.length, bytes: 0, status: 'running' }); }
    if (message.method === 'file.transfer.read') {
      if (transferPaths.get(p.id) === '/download-late-failure.bin') { setTimeout(() => fail('READ_FAILED', 'Source became unreadable after the tool response'), 100); return; }
      return reply({ data: fileBytes.toString('base64'), nextOffset: fileBytes.length, eof: true });
    }
    if (message.method === 'file.transfer.abort') return fail('RELEASE_FAILED', 'Descriptor cleanup failed after the transfer finished');
    if (['file.write', 'file.edit', 'job.input'].includes(message.method)) return reply({ ok: true, bytes: Buffer.byteLength(p.data ?? p.newText ?? '') });
    if (message.method === 'job.start') {
      if (p.path === '/invalid-workdir') return fail('INVALID_WORKDIR', 'Invalid working directory: /invalid-workdir');
      const state = { id: p.id, kind: 'job', path: p.path, cmd: p.cmd, status: 'running', startedAt: new Date().toISOString() };
      ws.send(JSON.stringify({ type: 'state', job: state }));
      for (let offset = 0; offset < output.length; offset += 48_000) ws.send(JSON.stringify({ type: 'output', jobId: p.id, offset, data: output.subarray(offset, offset + 48_000).toString('base64') }));
      return reply(state);
    }
    fail('UNEXPECTED_METHOD', message.method);
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, hostname: 'trace-fixture', os: 'linux', arch: 'amd64', version: '1.0.0', user: 'root' }));
  await eventually(() => app.hub.online(serverId), Boolean, 'fixture agent connected');
  const captured = new Map<string, { status: number; traceId: string | null; contentType: string | null }>();
  const client = new Client({ name: 'request-log-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + pat.token, 'User-Agent': 'Hostherd request-log regression' } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const traceId = response.headers.get('X-Hostherd-Trace-Id');
      if (traceId) captured.set(traceId, { status: response.status, traceId, contentType: response.headers.get('Content-Type') });
      return response;
    },
  }));
  async function get<T>(url: string): Promise<T> { const response = await fetch(base + url, { headers: { Cookie: cookie } }); assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>; }
  async function detail(traceId: string) { return eventually(() => get<Detail>('/api/request-logs/' + traceId), value => value.request.outcome !== 'pending', 'request completed in trace log'); }
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const traceId = result._meta?.['hostherd/traceId'];
    assert.equal(typeof traceId, 'string', `${name} exposes its trace ID, including SDK tool errors`);
    assert.ok(captured.has(traceId as string), 'tool metadata and HTTP header identify the same trace');
    return { result, traceId: traceId as string, log: await detail(traceId as string), http: captured.get(traceId as string)! };
  }
  return { app, base, dir, cookie, pat, ws, serverId, offlineId: offline.serverId, rpc, output, fileBytes, imageBytes, client, captured, get, detail, call, stalled: () => stalled };
}

test('MCP request logs correlate real transport, jobs, RPCs and retries without retaining payload bytes', async t => {
  const f = await fixture(t);
  const args = { serverId: f.serverId, path: '/tmp', cmd: 'printf trace-command', requestId: randomUUID(), waitMs: 0 };
  const started = await f.call('job_start', args);
  const state = JSON.parse((started.result.content as { text: string }[])[0].text);
  assert.equal(started.result.isError, undefined);
  assert.equal(started.http.status, 200);
  assert.equal(started.log.request.outcome, 'success');
  assert.equal(started.log.request.httpMethod, 'POST');
  assert.equal(started.log.request.httpPath, '/mcp');
  assert.equal(started.log.request.method, 'tools/call');
  assert.equal(started.log.request.tool, 'job_start');
  assert.equal(started.log.request.requestId, args.requestId);
  assert.equal(started.log.request.jobId, state.jobId);
  assert.equal(started.log.request.serverId, f.serverId);
  assert.equal(started.log.request.serverName, 'Trace target');
  assert.equal(started.log.request.executionUser, 'root');
  assert.ok(started.log.request.clientId);
  assert.ok(started.log.request.subject);
  assert.equal(started.log.request.userAgent, 'Hostherd request-log regression');
  assert.equal(started.log.request.arguments?.cmd, args.cmd);
  assert.equal(started.log.job?.id, state.jobId);
  assert.ok(started.log.request.endedAt);
  assert.ok(started.log.request.durationMs! >= 0);
  assert.ok(started.log.events.length >= 6, 'request lifecycle includes receive, authentication, SDK, tool, RPC, and response');
  assert.ok(JSON.stringify(started.log.events).includes(f.rpc.find(rpc => rpc.method === 'job.start')!.id), 'agent RPC ID is linked');
  const rpcSearch = await f.get<Listing>('/api/request-logs?q=' + f.rpc.find(rpc => rpc.method === 'job.start')!.id);
  assert.deepEqual(rpcSearch.items.map(item => item.traceId), [started.traceId], 'search resolves agent RPC IDs from the event timeline');
  assert.equal(new Set(started.log.events.map(event => event.seq)).size, started.log.events.length);
  assert.ok(started.log.events.every((event, index, all) => !index || event.seq > all[index - 1].seq));

  const retried = await f.call('job_start', args);
  assert.notEqual(retried.traceId, started.traceId);
  assert.equal(retried.log.request.jobId, state.jobId);
  assert.equal(f.rpc.filter(rpc => rpc.method === 'job.start').length, 1);
  // The fixture agent streams output asynchronously; wait until all of it is stored.
  for (const deadline = Date.now() + 10_000; f.app.store.job(state.jobId).outputBytes !== f.output.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
  const job = f.app.store.job(state.jobId);
  f.app.store.saveJob(f.serverId, { ...job, status: 'completed', exitCode: 0, endedAt: new Date().toISOString() });
  const updated = await f.detail(started.traceId);
  assert.equal(updated.request.outcome, 'success');
  assert.equal(updated.job?.status, 'completed', 'detail resolves current job state without rewriting request outcome');
  assert.equal(updated.job?.outputBytes, f.output.length);
  const savedOutput = await f.get<{ data: string }>(`/api/jobs/${state.jobId}/output?limit=${f.output.length}`);
  assert.deepEqual(Buffer.from(savedOutput.data, 'base64'), f.output);
  assert.doesNotMatch(JSON.stringify(updated), /OUTPUT_PRIVATE_CANARY/);
  assert.ok(!JSON.stringify(updated).includes(f.output.subarray(0, 100).toString('base64')), 'job output is linked, not duplicated');

  const [slow, fast] = await Promise.all([
    f.call('file_read', { serverId: f.serverId, path: '/slow.txt' }),
    f.call('file_read', { serverId: f.serverId, path: '/fast.txt' }),
  ]);
  assert.notEqual(slow.traceId, fast.traceId);
  assert.equal(slow.log.request.arguments?.path, '/slow.txt');
  assert.equal(fast.log.request.arguments?.path, '/fast.txt');
  for (const result of [slow, fast]) {
    assert.equal(result.log.request.outcome, 'success');
    const value = JSON.parse((result.result.content as { text: string }[])[0].text);
    assert.equal(value.text, f.fileBytes.toString('utf8'));
    assert.doesNotMatch(JSON.stringify(result.log), /FILE_PRIVATE_CANARY/);
    assert.ok(!JSON.stringify(result.log).includes(f.fileBytes.toString('base64')));
    const matchingRpc = f.rpc.find(rpc => rpc.method === 'file.read' && rpc.params.path === result.log.request.arguments?.path)!;
    assert.ok(JSON.stringify(result.log.events).includes(matchingRpc.id));
    const other = result === slow ? fast : slow;
    const otherRpc = f.rpc.find(rpc => rpc.method === 'file.read' && rpc.params.path === other.log.request.arguments?.path)!;
    assert.ok(!JSON.stringify(result.log.events).includes(otherRpc.id), 'concurrent RPC contexts stay separate');
  }
  const image = await f.call('image_read', { serverId: f.serverId, path: '/large.png' });
  assert.deepEqual((image.result.content as any[]).find(content => content.type === 'image'), { type: 'image', data: f.imageBytes.toString('base64'), mimeType: 'image/png' });
  assert.doesNotMatch(JSON.stringify(image.log), /IMAGE_PRIVATE_CANARY/);
  assert.ok(JSON.stringify(image.log).length < 20_000, 'large image is summarized in log');

  const listing = await f.get<Listing>('/api/request-logs?tool=job_start&serverId=' + f.serverId + '&q=' + args.requestId);
  assert.equal(listing.items.length, 2);
  assert.deepEqual(new Set(listing.items.map(item => item.traceId)), new Set([started.traceId, retried.traceId]));
  assert.equal(listing.collection.status, 'ok');
  assert.equal(listing.collection.failedWrites, 0);
  assert.ok(Date.parse(listing.collection.startedAt) <= Date.parse(started.log.request.receivedAt));
  const first = await f.get<Listing>('/api/request-logs?tool=file_read&limit=1');
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await f.get<Listing>('/api/request-logs?tool=file_read&limit=1&cursor=' + encodeURIComponent(first.nextCursor!));
  assert.equal(second.items.length, 1); assert.notEqual(second.items[0].traceId, first.items[0].traceId);
  assert.equal(second.nextCursor, null, 'pagination ends after both matching requests');
  const future = await f.get<Listing>('/api/request-logs?from=' + encodeURIComponent(new Date(Date.now() + 60_000).toISOString()));
  assert.equal(future.items.length, 0);
});

test('request logs retain authentication, parse, SDK and remote errors separately from HTTP status', async t => {
  const f = await fixture(t);
  for (const route of ['/mcp/', '/MCP']) {
    const response = await fetch(f.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + f.pat.token }, body: JSON.stringify({ jsonrpc: '2.0', id: 'route-' + route, method: 'tools/call', params: { name: 'servers_list', arguments: {} } }) });
    assert.equal(response.status, 200, 'Express-compatible MCP route remains accepted');
    await response.text();
    const traceId = response.headers.get('X-Hostherd-Trace-Id');
    assert.ok(traceId, `${route} receives a trace header`);
    const traced = await f.detail(traceId);
    assert.equal(traced.request.httpPath, route);
    assert.equal(traced.request.tool, 'servers_list');
    assert.equal(traced.request.outcome, 'success');
  }
  for (const route of ['/api/request-logs', '/api/request-logs/' + randomUUID()]) {
    assert.equal((await fetch(f.base + route)).status, 401);
    assert.equal((await fetch(f.base + route, { headers: { Authorization: 'Bearer ' + f.pat.token } })).status, 401, 'MCP PAT does not grant administrator log access');
  }
  const unauth = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer INVALID_AUTH_PRIVATE_CANARY', Cookie: 'other=COOKIE_PRIVATE_CANARY' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'unauthorized-request', method: 'tools/list' }) });
  assert.equal(unauth.status, 401);
  const unauthorized = await f.detail(unauth.headers.get('X-Hostherd-Trace-Id')!);
  assert.equal(unauthorized.request.outcome, 'error');
  assert.equal(unauthorized.request.httpStatus, 401);
  assert.ok(unauthorized.request.failureStage);
  assert.doesNotMatch(JSON.stringify(unauthorized), /INVALID_AUTH_PRIVATE_CANARY|COOKIE_PRIVATE_CANARY/);
  const unauthCall = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'job_start', arguments: { cmd: 'UNAUTH_BODY_PRIVATE_CANARY' } } }) });
  assert.equal(unauthCall.status, 401);
  const unauthCallLog = await f.detail(unauthCall.headers.get('X-Hostherd-Trace-Id')!);
  assert.equal(unauthCallLog.request.arguments, undefined, 'unauthenticated bodies are not recorded');
  assert.doesNotMatch(JSON.stringify(unauthCallLog), /UNAUTH_BODY_PRIVATE_CANARY/);

  const malformed = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.pat.token }, body: '{"password":"MALFORMED_PRIVATE_CANARY",' });
  assert.equal(malformed.status, 400);
  const parsed = await f.detail(malformed.headers.get('X-Hostherd-Trace-Id')!);
  assert.equal(parsed.request.outcome, 'error');
  assert.equal(parsed.request.httpStatus, 400);
  assert.ok(parsed.request.errorCode);
  assert.doesNotMatch(JSON.stringify(parsed), /MALFORMED_PRIVATE_CANARY/);
  const oversized = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.pat.token }, body: JSON.stringify({ data: 'OVERSIZED_PRIVATE_CANARY'.repeat(200_000) }) });
  assert.equal(oversized.status, 413);
  const oversizedLog = await f.detail(oversized.headers.get('X-Hostherd-Trace-Id')!);
  assert.equal(oversizedLog.request.failureStage, 'parse');
  assert.equal(oversizedLog.request.outcome, 'error');
  assert.doesNotMatch(JSON.stringify(oversizedLog), /OVERSIZED_PRIVATE_CANARY/);
  const rejected = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + f.pat.token }, body: JSON.stringify({ jsonrpc: '2.0', id: 'sdk-transport-rejected', method: 'tools/list' }) });
  assert.equal(rejected.status, 406, 'SDK rejects a missing SSE accept type before its response transport');
  const rejectedLog = await f.detail(rejected.headers.get('X-Hostherd-Trace-Id')!);
  assert.equal(rejectedLog.request.outcome, 'error');
  assert.equal(rejectedLog.request.failureStage, 'sdk');
  assert.equal(typeof rejectedLog.request.jsonRpcErrorCode, 'number');
  const beforeInvalid = f.rpc.length;
  const schema = await f.call('file_read', { serverId: f.serverId, path: 'relative/private' });
  assert.equal(schema.result.isError, true);
  assert.equal(schema.log.request.tool, 'file_read');
  assert.equal(schema.log.request.outcome, 'error');
  assert.equal(schema.log.request.mcpIsError, true);
  assert.equal(schema.log.request.httpStatus, 200);
  assert.equal(f.rpc.length, beforeInvalid, 'schema failure never reaches agent');
  assert.ok(schema.log.request.error);
  const beforeUnknown = new Set(f.captured.keys());
  await assert.rejects(f.client.callTool({ name: 'does_not_exist', arguments: {} }), /does_not_exist/);
  const unknownTraceIds = [...f.captured.keys()].filter(id => !beforeUnknown.has(id));
  assert.equal(unknownTraceIds.length, 1, 'JSON-RPC error still exposes HTTP trace ID');
  const unknown = await f.detail(unknownTraceIds[0]);
  assert.equal(unknown.request.tool, 'does_not_exist');
  assert.equal(unknown.request.outcome, 'error');
  assert.equal(typeof unknown.request.jsonRpcErrorCode, 'number');
  assert.equal(f.rpc.length, beforeInvalid);
  for (const [tool, args, errorCode] of [
    ['file_read', { serverId: f.offlineId, path: '/tmp/offline' }, 'SERVER_OFFLINE'],
    ['file_read', { serverId: f.serverId, path: '/denied.txt' }, 'EACCES'],
    ['job_start', { serverId: f.serverId, path: '/invalid-workdir', cmd: 'true', waitMs: 0 }, 'INVALID_WORKDIR'],
  ] as const) {
    const result = await f.call(tool, args);
    assert.equal(result.http.status, 200);
    assert.equal(result.result.isError, true);
    assert.equal(result.log.request.outcome, 'error');
    assert.equal(result.log.request.mcpIsError, true);
    assert.equal(result.log.request.errorCode, errorCode);
  }
  const failures = await f.get<Listing>('/api/request-logs?outcome=error&q=EACCES');
  assert.equal(failures.items.length, 1); assert.equal(failures.items[0].errorCode, 'EACCES');
  for (const query of ['limit=201', 'cursor=not-a-cursor', 'from=not-a-date', 'outcome=not-an-outcome']) assert.equal((await fetch(f.base + '/api/request-logs?' + query, { headers: { Cookie: f.cookie } })).status, 400, query);
});

test('request trace summaries mask credentials, environment values, file edits, input and attachment URLs', async t => {
  const f = await fixture(t);
  const markers = ['PASSWORD_PRIVATE_CANARY', 'ENV_PRIVATE_CANARY', 'PEM_PRIVATE_CANARY', 'URL_PRIVATE_CANARY', 'WRITE_PRIVATE_CANARY', 'OLD_PRIVATE_CANARY', 'NEW_PRIVATE_CANARY', 'INPUT_PRIVATE_CANARY', 'PASSPHRASE_PRIVATE_CANARY', 'COOKIE_COMMAND_PRIVATE_CANARY', 'API_HEADER_PRIVATE_CANARY', 'INVALID_ENV_PRIVATE_CANARY', 'QUOTED_COOKIE_PRIVATE_CANARY', 'QUOTED_KEY_PRIVATE_CANARY'];
  const command = 'curl -u owner:PASSWORD_PRIVATE_CANARY --passphrase "PASSPHRASE_PRIVATE_CANARY" --cookie "session=COOKIE_COMMAND_PRIVATE_CANARY" -H "X-Api-Key: API_HEADER_PRIVATE_CANARY" -H \'Cookie: session="QUOTED_COOKIE_PRIVATE_CANARY"\' --header=\'X-Api-Key: "QUOTED_KEY_PRIVATE_CANARY"\' https://example.com/trace-command && cat <<\'KEY\'\n-----BEGIN PRIVATE KEY-----\nPEM_PRIVATE_CANARY\n-----END PRIVATE KEY-----\nKEY';
  const started = await f.call('job_start', { serverId: f.serverId, path: '/tmp', cmd: command, env: { TEST_VALUE: 'ENV_PRIVATE_CANARY' }, waitMs: 0 });
  const jobId = started.log.request.jobId!;
  // file_edit follows the in-place edit rule; an allowed folder lets it reach the runner.
  f.app.approvals.addFolder(f.serverId, '/tmp');
  const written = await f.call('file_write', { serverId: f.serverId, path: '/tmp/file.txt', data: 'WRITE_PRIVATE_CANARY', encoding: 'utf8' });
  const edited = await f.call('file_edit', { serverId: f.serverId, path: '/tmp/file.txt', oldText: 'OLD_PRIVATE_CANARY', newText: 'NEW_PRIVATE_CANARY' });
  const input = await f.call('job_input', { jobId, data: 'INPUT_PRIVATE_CANARY', eof: true });
  const uploaded = await f.call('file_upload', { serverId: f.offlineId, path: '/tmp/file.zip', file: { file_id: 'file-test', download_url: 'https://example.com/attachment?token=URL_PRIVATE_CANARY' }, waitMs: 0 });
  const beforeMalformed = f.rpc.length;
  const malformedEnv = await f.call('job_start', { serverId: f.serverId, path: '/tmp', cmd: 'true', env: ['INVALID_ENV_PRIVATE_CANARY'], waitMs: 0 });
  assert.equal(malformedEnv.result.isError, true);
  assert.equal(malformedEnv.log.request.failureStage, 'sdk');
  assert.equal(f.rpc.length, beforeMalformed, 'invalid environment never reaches the runner');
  for (const entry of [started, written, edited, input, uploaded, malformedEnv]) {
    const serialized = JSON.stringify(entry.log);
    for (const marker of markers) assert.ok(!serialized.includes(marker), `${entry.log.request.tool} log must omit ${marker}`);
    if (entry !== input) assert.ok(serialized.includes('/tmp'), 'non-sensitive paths remain useful');
  }
  assert.equal(f.rpc.find(rpc => rpc.method === 'job.start')!.params.cmd, command, 'masking does not alter dispatched command');
  assert.equal(f.rpc.find(rpc => rpc.method === 'job.start')!.params.env.TEST_VALUE, 'ENV_PRIVATE_CANARY');
  assert.equal(f.rpc.find(rpc => rpc.method === 'file.write')!.params.data, 'WRITE_PRIVATE_CANARY');
  assert.equal(f.rpc.find(rpc => rpc.method === 'file.edit')!.params.newText, 'NEW_PRIVATE_CANARY');
  assert.equal(f.rpc.find(rpc => rpc.method === 'job.input')!.params.data, 'INPUT_PRIVATE_CANARY');
  const persisted = JSON.stringify({
    requests: f.app.store.db.prepare('SELECT record FROM request_logs').all(),
    events: f.app.store.db.prepare('SELECT data FROM request_log_events').all(),
  });
  for (const marker of [...markers, f.pat.token]) assert.ok(!persisted.includes(marker), 'sensitive canaries must be redacted before SQLite persistence, not only in the API view');
});

test('a disconnected MCP response records an uncertain delivery while the agent reply can still complete', async t => {
  const f = await fixture(t);
  const rpcId = 'disconnect-' + randomUUID();
  const payload = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'file_read', arguments: { serverId: f.serverId, path: '/stalled.txt' } } });
  const request = httpRequest(f.base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + f.pat.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(payload) } });
  request.on('error', () => {});
  request.end(payload);
  await eventually(f.stalled, Boolean, 'agent received stalled call');
  request.destroy();
  const log = await eventually(() => f.get<Listing>('/api/request-logs?q=' + encodeURIComponent(rpcId)), list => list.items.length === 1 && list.items[0].outcome !== 'pending', 'aborted response is finalized');
  assert.equal(log.items[0].outcome, 'unknown');
  f.ws.send(JSON.stringify({ type: 'response', id: f.stalled()!.id, result: { data: f.fileBytes.toString('base64'), size: f.fileBytes.length, eof: true } }));
  await delay(100);
  const detail = await f.detail(log.items[0].traceId);
  assert.equal(detail.request.outcome, 'unknown', 'a late successful result does not claim delivered response');
  assert.ok(detail.request.errorCode || detail.events.some(event => /clos|abort|disconnect/.test(JSON.stringify(event))), 'disconnect reason stays visible');
});

test('request logs survive reopening, recover unfinished requests and retain only thirty days after completion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-trace-retention-'));
  let store = new Store(dir);
  let logs = new RequestLogs(store);
  const collectionStartedAt = logs.collection().startedAt;
  const now = Date.now(), old = new Date(now - 40 * 86400_000).toISOString(), recent = new Date(now).toISOString();
  const serverId = store.enroll(store.enrollment('Retention target', 'root').code, { hostname: 'retention-fixture' }).serverId;
  const jobId = randomUUID();
  store.saveJob(serverId, { id: jobId, kind: 'job', path: '/tmp', cmd: 'long-running-command', status: 'running', startedAt: old });
  const activeId = randomUUID(), expiredId = randomUUID(), completedId = randomUUID();
  function seed(traceId: string, receivedAt: string, endedAt?: string) {
    const record = { traceId, receivedAt, endedAt, httpMethod: 'POST', httpPath: '/mcp', method: 'tools/call', tool: 'job_start', serverId, jobId, outcome: endedAt ? 'success' : 'pending' };
    store.db.prepare('INSERT INTO request_logs (trace_id,received_at,ended_at,server_id,tool,outcome,record) VALUES (?,?,?,?,?,?,?)').run(traceId, receivedAt, endedAt ?? null, serverId, 'job_start', record.outcome, JSON.stringify(record));
    store.db.prepare('INSERT INTO request_log_events (trace_id,at,stage,status,data) VALUES (?,?,?,?,?)').run(traceId, receivedAt, 'received', 'start', JSON.stringify({ fixture: true }));
  }
  try {
    seed(expiredId, old, old);
    seed(completedId, old, recent);
    seed(activeId, old);
    logs.cleanup(now);
    assert.throws(() => logs.detail(expiredId), { code: 'TRACE_NOT_FOUND' });
    assert.equal((store.db.prepare('SELECT COUNT(*) count FROM request_log_events WHERE trace_id=?').get(expiredId) as { count: number }).count, 0, 'retention removes corresponding events');
    assert.equal(logs.detail(activeId).request.outcome, 'pending', 'active request is never aged out by receive time');
    assert.equal(logs.detail(completedId).request.outcome, 'success', 'retention age starts on completion, not receipt');
    store.close(); store = new Store(dir); logs = new RequestLogs(store);
    assert.equal(logs.collection().startedAt, collectionStartedAt);
    assert.equal(logs.detail(completedId).request.outcome, 'success');
    assert.equal(logs.detail(completedId).events.length, 1, 'stored event survives SQLite reopen');
    const recovered = logs.detail(activeId);
    assert.equal(recovered.request.outcome, 'unknown');
    assert.equal(recovered.request.errorCode, 'CENTRAL_RESTARTED');
    assert.ok(recovered.request.endedAt);
    assert.equal(recovered.job?.id, jobId);
    assert.equal(recovered.job?.status, 'running', 'trace recovery must not stop or rewrite the underlying job');
    assert.equal(store.job(jobId).status, 'running');
    logs.cleanup(now);
    assert.equal(logs.detail(activeId).request.outcome, 'unknown');
    logs.cleanup(now + 31 * 86400_000);
    assert.throws(() => logs.detail(activeId), { code: 'TRACE_NOT_FOUND' });
    assert.throws(() => logs.detail(completedId), { code: 'TRACE_NOT_FOUND' });
    assert.equal(store.job(jobId).status, 'running', 'trace cleanup never deletes linked job state');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('trace storage failure preserves command execution and surfaces degraded collection to administrators', async t => {
  const f = await fixture(t);
  const prepare = f.app.store.db.prepare.bind(f.app.store.db);
  const errors = t.mock.method(console, 'error', () => {});
  f.app.store.db.prepare = ((sql: string) => {
    if (/^\s*(?:INSERT INTO|UPDATE) request_log(?:s|_events)\b/.test(sql)) throw new Error('TRACE_STORAGE_PRIVATE_CANARY');
    return prepare(sql);
  }) as typeof f.app.store.db.prepare;
  try {
    const result = await f.client.callTool({ name: 'job_start', arguments: { serverId: f.serverId, path: '/tmp', cmd: 'printf survives-trace-storage-failure', waitMs: 0 } });
    assert.notEqual(result.isError, true);
    const job = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(f.app.store.job(job.jobId).status, 'running');
    assert.equal(f.rpc.filter(message => message.method === 'job.start').length, 1);
    assert.equal(typeof result._meta?.['hostherd/traceId'], 'string');
    const listing = await f.get<Listing>('/api/request-logs');
    assert.equal(listing.collection.status, 'degraded');
    assert.ok(listing.collection.failedWrites > 0);
    assert.ok((listing.collection as any).lastErrorAt);
    assert.ok(errors.mock.callCount() > 0, 'storage fault is also visible in server stderr');
    assert.ok(!JSON.stringify(errors.mock.calls.map(call => call.arguments)).includes('TRACE_STORAGE_PRIVATE_CANARY'), 'logging failure must not leak raw database error contents');
  } finally { f.app.store.db.prepare = prepare; errors.mock.restore(); }
  const resumed = await f.call('file_read', { serverId: f.serverId, path: '/after-storage-recovery.txt' });
  assert.equal(resumed.log.request.outcome, 'success', 'new traces are persisted after storage recovers');
  assert.equal(resumed.log.collection.status, 'degraded', 'past missing writes remain visible');
});

test('caught cleanup errors and later transfer failures do not rewrite a successful MCP response', async t => {
  const f = await fixture(t);
  const completed = await f.call('file_download', { serverId: f.serverId, path: '/download-cleanup-failure.bin', waitMs: 5000 });
  assert.notEqual(completed.result.isError, true);
  const state = JSON.parse((completed.result.content as { text: string }[])[0].text);
  assert.equal(state.status, 'completed');
  assert.equal(completed.log.request.outcome, 'success', 'best-effort cleanup failure is not the overall request result');
  assert.equal(completed.log.transfer?.transferId, state.transferId);
  assert.equal(completed.log.transfer?.status, 'completed');
  assert.ok(JSON.stringify(completed.log.events).includes('RELEASE_FAILED'), 'caught RPC error remains visible in lifecycle events');
  assert.ok(!JSON.stringify(completed.log).includes(state.downloadUrl), 'temporary download URL is omitted from trace summaries');
  assert.ok(!JSON.stringify(completed.log).includes(f.fileBytes.toString('base64')), 'transfer chunks are never retained in logs');

  const pending = await f.call('file_download', { serverId: f.serverId, path: '/download-late-failure.bin', waitMs: 0 });
  assert.equal(JSON.parse((pending.result.content as { text: string }[])[0].text).status, 'running');
  assert.equal(pending.log.request.outcome, 'success');
  const afterFailure = await eventually(() => f.detail(pending.traceId), detail => detail.transfer?.status === 'failed', 'background transfer failure is available in linked state');
  assert.equal(afterFailure.transfer?.errorCode, 'READ_FAILED');
  assert.equal(afterFailure.request.outcome, 'success', 'successful running response remains successful after background failure');
  assert.equal(afterFailure.request.endedAt, pending.log.request.endedAt);
  assert.equal((afterFailure.request.result as { status?: string }).status, 'running', 'result summary retains the actual delivered state');
  assert.ok(JSON.stringify(afterFailure.events).includes('READ_FAILED'));
});

test('dashboard MCP activity sorts tool calls by kind, separates policy holds from errors and lists the latest calls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-tool-activity-'));
  const store = new Store(dir);
  try {
    const logs = new RequestLogs(store);
    const now = Date.parse('2026-10-06T12:00:00Z');
    const add = (receivedAt: string, tool: string, outcome: string, extra: Record<string, unknown> = {}) => {
      const record = { traceId: randomUUID(), receivedAt, endedAt: receivedAt, httpMethod: 'POST', httpPath: '/mcp', tool, outcome, ...extra };
      store.db.prepare('INSERT INTO request_logs (trace_id,received_at,ended_at,server_id,tool,outcome,record) VALUES (?,?,?,?,?,?,?)').run(record.traceId, receivedAt, receivedAt, null, tool, outcome, JSON.stringify(record));
    };
    add('2026-10-05T10:00:00Z', 'job_start', 'success', { arguments: { cmd: 'uptime', path: '/' } });
    add('2026-10-06T09:00:00Z', 'file_write', 'success', { arguments: { path: '/tmp/a' } });
    add('2026-10-06T09:30:00Z', 'servers_list', 'success');
    add('2026-10-06T10:00:00Z', 'job_start', 'error', { errorCode: 'APPROVAL_REQUIRED', arguments: { cmd: 'rm -rf /x', path: '/' }, clientId: 'pat:1' });
    add('2026-10-06T11:00:00Z', 'job_status', 'error', { errorCode: 'NOT_FOUND' });
    store.db.prepare('INSERT INTO request_logs (trace_id,received_at,ended_at,server_id,tool,outcome,record) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), '2026-10-06T11:30:00Z', null, null, null, 'success', JSON.stringify({ method: 'tools/list' }));
    const activity = logs.toolActivity(2, 0, now);
    assert.deepEqual(activity.days, [
      { date: '2026-10-05', command: 1, file: 0, query: 0, held: 0, error: 0 },
      { date: '2026-10-06', command: 0, file: 1, query: 1, held: 1, error: 1 },
    ]);
    assert.deepEqual(activity.summary, { requests: 4, errors: 1, held: 1 });
    assert.deepEqual(activity.latest.map(call => [call.tool, call.summary, call.errorCode]), [
      ['job_status', null, 'NOT_FOUND'], ['job_start', 'rm -rf /x', 'APPROVAL_REQUIRED'], ['servers_list', null, null], ['file_write', '/tmp/a', null], ['job_start', 'uptime', null],
    ]);
    assert.deepEqual(activity.clients, [{ clientId: null, requests: 3, errors: 1, lastAt: '2026-10-06T11:00:00Z' }, { clientId: 'pat:1', requests: 1, errors: 0, lastAt: '2026-10-06T10:00:00Z' }]);
    // The day boundary follows the viewer's UTC offset.
    assert.equal(logs.toolActivity(1, 9 * 60, now).days[0].date, '2026-10-06');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('redaction stays linear on long inputs', () => {
  for (const input of ['a-'.repeat(50_000), '-'.repeat(100_000), 'x-token:'.repeat(12_000)]) {
    const started = performance.now();
    redactText(input);
    assert.ok(performance.now() - started < 1000, `redacting ${input.slice(0, 8)}… took too long`);
  }
});
