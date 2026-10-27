import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/audit.js';
import { Store } from '../src/store.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface AuditEvent {
  id: number; at: string; actor: string; action: string; target: string | null;
  result: string; status: number | null; detail: Record<string, unknown>;
}
interface AuditPage { items: AuditEvent[]; nextCursor?: string }

async function adminApp(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-audit-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const send = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const list = async (query = '') => {
    const response = await fetch(base + '/api/audit-events' + query, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as AuditPage;
  };
  const stored = () => JSON.stringify(app.store.db.prepare('SELECT actor,action,target,result,status,detail FROM audit_events').all());
  return { app, base, cookie, send, list, stored };
}

test('an admin write is recorded with its result', async t => {
  const { app, base, cookie, send, list } = await adminApp(t);
  const { code } = app.store.enrollment('audit target', 'root');
  const { serverId } = app.store.enroll(code, { hostname: 'audit', executionUser: 'root' });
  app.store.fault(serverId, 'disk full');

  const dismissed = await send('DELETE', `/api/servers/${serverId}/fault`);
  assert.equal(dismissed.status, 200);
  const ok = (await list()).items.find(event => event.action === 'DELETE /api/servers/:id/fault');
  assert.ok(ok, 'fault dismiss is recorded');
  assert.equal(ok.actor, 'admin:1:owner');
  assert.equal(ok.target, serverId);
  assert.equal(ok.result, 'ok');
  assert.equal(ok.status, 200);

  const rejected = await send('PATCH', `/api/servers/${serverId}`, { name: '' });
  assert.equal(rejected.status, 400);
  const failed = (await list()).items.find(event => event.action === 'PATCH /api/servers/:id' && event.result === 'error');
  assert.ok(failed, 'rejected write is recorded');
  assert.equal(failed.status, 400);

  const before = (await list()).items.length;
  assert.equal((await fetch(`${base}/api/servers`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await list()).items.length, before, 'GET is not an audit event');
  assert.equal((await fetch(`${base}/api/audit-events`)).status, 401);
  assert.equal((await fetch(`${base}/api/audit-events?cursor=nope`, { headers: { Cookie: cookie } })).status, 400);

  const page = await list('?limit=1');
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const next = await list('?limit=1&cursor=' + page.nextCursor);
  assert.notEqual(next.items[0]?.id, page.items[0]?.id);
});

test('a secret-bearing field is not stored', async t => {
  const { base, cookie, send, list, stored } = await adminApp(t);
  const secret = 'AUDIT_SECRET_CANARY';
  const bot = 'AUDIT_BOT_CANARY';
  const urlToken = 'AUDIT_URL_CANARY';
  const password = 'AUDIT_PASSWORD_CANARY';
  const created = await send('POST', '/api/webhooks', {
    name: 'ops', kind: 'generic', url: `https://hooks.example/notify?token=${urlToken}`,
    secret, botToken: bot, password, events: ['fault'], enabled: true,
  });
  assert.equal(created.status, 201);
  const token = await send('POST', '/api/tokens', { name: 'audit' });
  assert.equal(token.status, 201);
  const issued = String(token.body.token);
  assert.match(issued, /^hostherd_/);
  const enrollment = await send('POST', '/api/enrollments', { name: 'audit-host' });
  assert.equal(enrollment.status, 201);
  const code = String(enrollment.body.code);
  assert.ok(code.length > 10);

  const raw = stored();
  for (const hidden of [secret, bot, urlToken, password, issued, code, 'test-password-123']) {
    assert.equal(raw.includes(hidden), false, hidden);
  }
  const webhook = (await list()).items.find(event => event.action === 'POST /api/webhooks');
  assert.ok(webhook);
  assert.equal(webhook.result, 'ok');
  assert.equal(webhook.status, 201);
  assert.equal(JSON.stringify(webhook.detail).includes(secret), false);
  const minted = (await list()).items.find(event => event.action === 'POST /api/tokens');
  assert.ok(minted, 'token create is recorded without the token');
  assert.equal(minted.result, 'ok');
  assert.equal((await fetch(`${base}/api/tokens`, { headers: { Cookie: cookie } })).status, 200);
});

test('agent disconnect records the close reason', async t => {
  const { app, base, list } = await adminApp(t);
  const { code } = app.store.enrollment('audit agent', 'root');
  const enrolled = app.store.enroll(code, { hostname: 'audit', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${enrolled.token}` } });
  t.after(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, hostname: 'audit', os: 'linux', arch: 'amd64', version: '0.1.0', user: 'root' }));
  for (let i = 0; i < 50 && !app.hub.online(enrolled.serverId); i++) await sleep(20);
  assert.equal(app.hub.online(enrolled.serverId), true);
  const reason = 'uplink lost during maintenance';
  ws.close(4000, reason);
  let disconnect: AuditEvent | undefined;
  for (let i = 0; i < 50; i++) {
    disconnect = (await list()).items.find(event => event.action === 'agent.disconnect' && event.target === enrolled.serverId);
    if (disconnect?.detail.reason === reason) break;
    await sleep(20);
  }
  assert.ok(disconnect, 'disconnect is recorded');
  assert.equal(disconnect.actor, `agent:${enrolled.serverId}`);
  assert.equal(disconnect.detail.reason, reason);
  assert.equal(disconnect.status, 4000);
  assert.equal(disconnect.result, 'error');
  const connect = (await list()).items.find(event => event.action === 'agent.connect' && event.target === enrolled.serverId);
  assert.equal(connect?.result, 'ok');
  assert.equal(connect?.actor, `agent:${enrolled.serverId}`);
});

test('a planned agent close is ok and an abnormal drop is an error', async t => {
  const { app, base, list } = await adminApp(t);
  const { code } = app.store.enrollment('audit close', 'root');
  const enrolled = app.store.enroll(code, { hostname: 'audit', os: 'linux', arch: 'amd64', version: '0.1.0', executionUser: 'root' });
  const hello = JSON.stringify({ type: 'hello', protocol: 1, hostname: 'audit', os: 'linux', arch: 'amd64', version: '0.1.0', user: 'root' });
  const url = `${base.replace('http:', 'ws:')}/agent`;
  const headers = { headers: { Authorization: `Bearer ${enrolled.token}` } };
  const until = async (ready: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 50; i++) {
      if (await ready()) return;
      await sleep(20);
    }
    assert.fail('timed out');
  };
  const connect = async () => {
    const ws = new WebSocket(url, headers);
    await once(ws, 'open');
    ws.send(hello);
    await until(() => app.hub.online(enrolled.serverId));
    return ws;
  };
  const disconnect = async (status: number) => {
    let found: AuditEvent | undefined;
    await until(async () => {
      found = (await list()).items.find(event => event.action === 'agent.disconnect' && event.target === enrolled.serverId && event.status === status);
      return found !== undefined;
    });
    return found!;
  };

  let ws = await connect();
  ws.close(1001, 'shutdown');
  const goingAway = await disconnect(1001);
  assert.equal(goingAway.result, 'ok');
  assert.equal(goingAway.detail.reason, 'shutdown');

  ws = await connect();
  ws.close(1000, 'normal');
  const normal = await disconnect(1000);
  assert.equal(normal.result, 'ok');
  assert.equal(normal.detail.reason, 'normal');

  ws = await connect();
  ws.terminate();
  const dropped = await disconnect(1006);
  assert.equal(dropped.result, 'error');
  assert.equal(dropped.detail.reason, undefined);
});

test('audit events are kept for thirty days and detail is truncated without secrets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-audit-retention-'));
  const store = new Store(dir);
  const audit = new AuditLog(store);
  try {
    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    store.db.prepare('INSERT INTO audit_events (at,actor,action,target,result,status,detail) VALUES (?,?,?,?,?,?,?)')
      .run(old, 'system', 'agent.disconnect', 'old-server', 'ok', 1000, '{}');
    audit.record({ actor: 'admin:1:owner', action: 'DELETE /api/servers/:id/fault', target: 'kept', result: 'ok', status: 200 });
    audit.cleanup();
    assert.deepEqual(audit.list(10).items.map(event => event.target), ['kept']);
    audit.record({
      actor: 'system', action: 'agent.disconnect', target: 'srv', result: 'error', status: 1006,
      detail: { reason: 'r'.repeat(500), secret: 'AUDIT_SECRET_CANARY', token: 'hostherd_plaintext' },
    });
    const row = audit.list(1).items[0];
    assert.equal(row?.actor, 'system');
    assert.equal(row?.detail.reason, 'r'.repeat(300));
    const raw = JSON.stringify(audit.list(10));
    assert.equal(raw.includes('AUDIT_SECRET_CANARY'), false);
    assert.equal(raw.includes('hostherd_plaintext'), false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
