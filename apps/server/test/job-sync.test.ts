import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(20); }
  assert.ok(predicate(), 'condition became true');
}

test('a batch sync stores every job and a bad entry does not drop the others', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-batch-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { code } = app.store.enrollment('Batch target');
  const { serverId, token } = app.store.enroll(code, { hostname: 'fixture', executionUser: 'root' });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${token}` } });
  t.after(async () => { ws.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  await once(ws, 'open');
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  send({ type: 'hello', protocol: 1, version: '1.0.0', hostname: 'fixture', os: 'linux', arch: 'amd64', user: 'root' });

  const startedAt = '2026-10-27T00:00:00.000Z';
  const endedAt = '2026-10-27T00:00:01.000Z';
  const revised = randomUUID();
  const running = randomUUID();
  const terminal = randomUUID();
  const after = randomUUID();
  send({
    type: 'state', jobs: [
      { id: revised, kind: 'job', path: '/', cmd: 'false', status: 'failed', startedAt, endedAt, exitCode: 1, error: 'exit' },
      { id: 'not valid', kind: 'job', path: '/', cmd: 'bad', status: 'failed', startedAt, endedAt },
      { id: running, kind: 'job', path: '/tmp', cmd: 'sleep', status: 'running', startedAt },
      { id: revised, kind: 'job', path: '/srv', cmd: 'false', status: 'completed', startedAt, endedAt, exitCode: 0 },
      { id: randomUUID(), kind: 'nope', path: '/', cmd: 'x', status: 'running', startedAt },
      { id: terminal, kind: 'terminal', path: '/', cmd: '', status: 'interrupted', startedAt, endedAt },
    ],
  });
  await eventually(() => app.store.jobs().some(job => job.id === terminal));

  const stored = app.store.job(revised);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.cmd, 'false');
  assert.equal(stored.path, '/srv');
  assert.equal(stored.exitCode, 0);
  assert.equal(stored.error, undefined);
  assert.equal(stored.serverId, serverId);
  const live = app.store.job(running);
  assert.equal(live.status, 'running');
  assert.equal(live.cmd, 'sleep');
  assert.equal(live.path, '/tmp');
  assert.equal(app.store.job(terminal).status, 'interrupted');
  assert.equal(app.store.job(terminal).kind, 'terminal');
  assert.equal(app.store.jobs().length, 3);
  assert.equal(app.store.server(serverId).fault, null);
  assert.equal(ws.readyState, WebSocket.OPEN);

  send({
    type: 'state', jobs: [
      { id: revised, kind: 'job', path: '/srv', cmd: 'false', status: 'running', startedAt },
      { id: after, kind: 'job', path: '/var', cmd: 'after', status: 'completed', startedAt, endedAt, exitCode: 0 },
    ],
  });
  await eventually(() => app.store.jobs().some(job => job.id === after));
  assert.equal(app.store.job(revised).status, 'completed', 'a finished job does not regress');
  assert.equal(app.store.job(after).cmd, 'after');
  assert.equal(app.store.jobs().length, 4);
  assert.equal(ws.readyState, WebSocket.OPEN);
});
