import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { classifyCommand } from '../src/approvals.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('webhooks deliver subscribed events in each format, sign generic payloads and never return stored tokens', async t => {
  const received: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({ path: req.url!, headers: req.headers, body }); res.statusCode = req.url === '/fail' ? 500 : 204; res.end(); });
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const hook = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-webhooks-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'https://hostherd.example' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); receiver.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const web = async <T = Record<string, unknown>>(method: string, url: string, body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };
  const { code } = app.store.enrollment('web-1');
  const { serverId } = await (await fetch(`${base}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, hostname: 'web1', os: 'linux', arch: 'amd64', version: '0.2.9', executionUser: 'root' }) })).json() as { serverId: string };

  const generic = await web<{ id: string; target: string; hasSecret: boolean }>('POST', '/api/webhooks', { name: 'ops', kind: 'generic', url: hook + '/generic?token=abc', secret: 's3cret', events: ['approval', 'fault', 'job_failed'], enabled: true });
  assert.equal(generic.status, 201);
  assert.equal(generic.body.target, hook + '/…');
  assert.equal(generic.body.hasSecret, true);
  await web('POST', '/api/webhooks', { name: 'chat', kind: 'slack', url: hook + '/slack', events: ['fault'], enabled: true });
  await web('POST', '/api/webhooks', { name: 'off', kind: 'discord', url: hook + '/discord', events: ['fault'], enabled: false });
  assert.deepEqual(await web('POST', '/api/webhooks', { name: 'bad', kind: 'generic', url: 'ftp://x', events: [], enabled: true }),
    { status: 400, body: { code: 'WEBHOOK_URL_SCHEME', error: 'Only http or https URLs can be used.' } });
  assert.deepEqual(await web('DELETE', `/api/webhooks/${randomUUID()}`), { status: 404, body: { code: 'WEBHOOK_NOT_FOUND', error: 'Notification not found.' } });
  assert.equal((await web<{ language: string }>('GET', '/api/settings')).body.language, 'en');
  const telegram = await web<{ target: string }>('POST', '/api/webhooks', { name: 'tg', kind: 'telegram', botToken: '123456:ABC-def', chatId: '-100200', events: [], enabled: true });
  assert.equal(telegram.body.target, 'api.telegram.org · chat -100200');
  assert.ok(!JSON.stringify((await web('GET', '/api/webhooks')).body).includes('ABC-def'), 'tokens are not returned');
  assert.ok(!JSON.stringify((await web('GET', '/api/webhooks')).body).includes('token=abc'), 'URL query is not returned');

  app.approvals.check({ serverId, tool: 'job_start', command: 'rm -rf /srv/data', path: '/', args: { cmd: 'rm -rf /srv/data' }, matches: classifyCommand('rm -rf /srv/data', '/') });
  app.store.fault(serverId, 'runner crashed');
  const now = new Date().toISOString();
  app.store.saveJob(serverId, { id: randomUUID(), kind: 'job', path: '/', cmd: 'make deploy', status: 'failed', startedAt: now, endedAt: now, exitCode: 2 });
  // An old failure re-sent after a reconnect is not news.
  const old = new Date(Date.now() - 3600_000).toISOString();
  app.store.saveJob(serverId, { id: randomUUID(), kind: 'job', path: '/', cmd: 'old', status: 'failed', startedAt: old, endedAt: old, exitCode: 1 });
  for (let i = 0; i < 100 && received.length < 4; i++) await sleep(20);
  await sleep(100);
  const generics = received.filter(item => item.path.startsWith('/generic')).map(item => ({ ...item, json: JSON.parse(item.body) }));
  assert.deepEqual(generics.map(item => item.json.event).sort(), ['approval', 'fault', 'job_failed']);
  for (const item of generics) {
    assert.equal(item.headers['x-hostherd-event'], item.json.event);
    assert.equal(item.headers['x-hostherd-signature'], 'sha256=' + createHmac('sha256', 's3cret').update(item.body).digest('hex'));
  }
  const approval = generics.find(item => item.json.event === 'approval')!.json;
  assert.match(approval.text, /rm -rf \/srv\/data/);
  assert.match(approval.url, /^https:\/\/hostherd\.example\/approvals\//);
  assert.equal(approval.serverName, 'web-1');
  const slack = received.filter(item => item.path === '/slack');
  assert.equal(slack.length, 1);
  assert.match(JSON.parse(slack[0].body).text, /^\[Hostherd\] Fault reported · web-1\nrunner crashed/);
  assert.equal(received.filter(item => item.path === '/discord').length, 0, 'disabled webhooks stay silent');

  // A repeated identical fault is not sent again; the test button reports delivery.
  app.store.fault(serverId, 'runner crashed');
  const failing = await web<{ id: string }>('POST', '/api/webhooks', { name: 'broken', kind: 'generic', url: hook + '/fail', events: [], enabled: true });
  const result = await web<{ ok: boolean; error: string; lastStatus: string }>('POST', `/api/webhooks/${failing.body.id}/test`);
  assert.deepEqual([result.body.ok, result.body.error, result.body.lastStatus], [false, 'HTTP 500', 'error']);
  await sleep(100);
  assert.equal(received.filter(item => item.path === '/slack').length, 1);

  // Notification texts follow the language setting at send time.
  assert.deepEqual(await web('PUT', '/api/settings/language', { language: 'ko' }), { status: 200, body: { language: 'ko' } });
  assert.equal((await web<{ language: string }>('GET', '/api/settings')).body.language, 'ko');
  assert.equal((await web<{ code: string }>('PUT', '/api/settings/language', { language: 'fr' })).body.code, 'INVALID_INPUT');
  assert.equal((await fetch(`${base}/api/settings/language`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en' }) })).status, 401, 'administrator only');
  app.store.fault(serverId, 'disk full');
  for (let i = 0; i < 100 && received.filter(item => item.path === '/slack').length < 2; i++) await sleep(20);
  assert.match(JSON.parse(received.filter(item => item.path === '/slack')[1].body).text, /^\[Hostherd\] 장애 보고 · web-1\ndisk full/);
  await web('PUT', '/api/settings/language', { language: 'en' });
  const updated = await web<{ name: string; hasSecret: boolean; target: string }>('PATCH', `/api/webhooks/${generic.body.id}`, { name: 'ops2', secret: null });
  assert.deepEqual([updated.body.name, updated.body.hasSecret, updated.body.target], ['ops2', false, hook + '/…']);
  assert.equal((await web('DELETE', `/api/webhooks/${generic.body.id}`)).status, 200);
  assert.equal((await web('GET', '/api/webhooks')).body.length, 4);
});
