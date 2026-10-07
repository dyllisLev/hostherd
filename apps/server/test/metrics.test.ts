import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { MetricsStore, type MetricsSample } from '../src/metrics.js';

const sample = (cpu: number, extra: Partial<MetricsSample> = {}): MetricsSample => ({
  cpu, cpus: 4, load1: 0.5, memTotal: 1000, memUsed: 250, netRx: 100, netTx: 50,
  disks: [{ mount: '/', fs: 'ext4', total: 100, used: 40, avail: 60 }, { mount: '/data', fs: 'xfs', total: 100, used: 90, avail: 10 }], ...extra,
});

test('metrics store buckets samples with gaps, rolls up, computes availability and expires data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-metrics-'));
  const store = new MetricsStore(dir);
  try {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    // Reports every 30 s with jitter fill every 60 s bucket; a 4-minute outage stays empty.
    for (let i = 0; i < 20; i++) if (i < 6 || i > 13) store.record('s1', sample(10), now - 60_000 - i * 30_000 + (i % 3) * 4_000);
    store.record('s1', sample(80), now - 5_000);
    const { step, points } = store.series('s1', '1h', now);
    assert.equal(step, 60);
    assert.equal(points.length, 60);
    assert.equal(points.at(-2)?.cpuMax, 80, 'the newest bucket holds the newest sample');
    const empty = points.slice(-12, -1).filter(point => point.cpu === null).length;
    assert.ok(empty >= 3 && empty <= 4, 'the outage is a gap; jittered reports are not');
    const filled = points.filter(point => point.cpu !== null);
    assert.equal(filled[0].mem, 25);
    assert.equal(filled[0].disk, 90, 'disk is the fullest filesystem');
    assert.deepEqual(store.summaries().get('s1'), { at: new Date(Math.floor((now - 5_000) / 1000) * 1000).toISOString(), cpu: 80, load1: 0.5, memPct: 25, diskPct: 90 });

    store.rollup(now);
    const rolled = store.db.prepare('SELECT count(*) n, max(cpu_max) peak FROM rollup_5m').get() as { n: number; peak: number };
    assert.ok(rolled.n >= 1); assert.equal(rolled.peak, 80);

    store.event('s1', 'online', now - 3600_000 * 2);
    store.event('s1', 'offline', now - 1800_000);
    store.event('s1', 'online', now - 900_000);
    const availability = store.availability('s1', '1h', true, now);
    assert.equal(availability.percent, 75);
    assert.deepEqual(availability.events.map(event => event.type), ['online', 'offline', 'online']);

    store.cleanup(now + 49 * 3600_000);
    assert.equal((store.db.prepare('SELECT count(*) n FROM samples').get() as { n: number }).n, 0);
    store.forget('s1');
    assert.equal(store.latest('s1'), null);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('agents that announce metrics report samples; agents without the capability and unknown messages keep working', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-metrics-app-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const sockets: WebSocket[] = [];
  let client: Client | undefined;
  t.after(async () => { await client?.close(); for (const ws of sockets) ws.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'test-password-123', setupToken }) });
  const cookie = setup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const connect = async (name: string, capabilities?: string[]) => {
    const { code } = app.store.enrollment(name);
    const { serverId, token } = app.store.enroll(code, { hostname: name, executionUser: 'root' });
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/agent`, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(ws);
    await once(ws, 'open');
    const welcome = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, version: '0.1.0', hostname: name, os: 'linux', arch: 'amd64', user: 'root', ...(capabilities ? { capabilities } : {}) }));
    return { serverId, ws, welcome: JSON.parse(String((await welcome)[0])) };
  };
  const modern = await connect('modern', ['metrics', 'future-feature']);
  assert.deepEqual(modern.welcome.metrics, { intervalMs: 30_000 });
  const plain = await connect('plain');
  assert.equal(plain.welcome.metrics, undefined, 'agents without the capability are not asked for samples');

  modern.ws.send(JSON.stringify({ type: 'some-future-message', value: 1 }));
  modern.ws.send(JSON.stringify({ type: 'metrics', sample: { cpu: 999, cpus: 1, disks: [] } }));
  modern.ws.send(JSON.stringify({ type: 'metrics', at: new Date().toISOString(), sample: sample(42) }));
  const get = async <T>(url: string) => (await fetch(base + url, { headers: { Cookie: cookie } })).json() as Promise<T>;
  for (let i = 0; i < 50 && !app.metrics.latest(modern.serverId); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.hub.online(modern.serverId), true, 'unknown and malformed messages do not drop the agent');
  assert.equal(app.store.server(modern.serverId).fault, null);
  const servers = await get<{ id: string; metrics: { cpu: number; diskPct: number } | null }[]>('/api/servers');
  assert.deepEqual(servers.map(server => [server.id, server.metrics?.cpu ?? null]), [[modern.serverId, 42], [plain.serverId, null]]);
  const detail = await get<{ points: { cpu: number | null }[]; latest: { sample: MetricsSample }; availability: { percent: number } }>(`/api/servers/${modern.serverId}/metrics?range=1h`);
  assert.equal(detail.points.filter(point => point.cpu !== null).at(-1)?.cpu, 42);
  assert.equal(detail.latest.sample.disks.length, 2);
  assert.equal(detail.availability.percent, 100);
  assert.equal((await fetch(`${base}/api/servers/${modern.serverId}/metrics?range=2y`, { headers: { Cookie: cookie } })).status, 400);

  const { token } = await (await fetch(`${base}/api/tokens`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'metrics' }) })).json() as { token: string };
  client = new Client({ name: 'metrics-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  const result = await client.callTool({ name: 'server_metrics', arguments: { serverId: modern.serverId, range: '1h' } });
  const body = JSON.parse((result.content as { text: string }[])[0].text);
  assert.equal(body.summary.cpuPercent.max, 42);
  assert.equal(body.summary.fullestDiskPercent.max, 90);
  assert.ok(body.series.points.length <= 24);
  const empty = JSON.parse(((await client.callTool({ name: 'server_metrics', arguments: { serverId: plain.serverId } })).content as { text: string }[])[0].text);
  assert.equal(empty.latest, null); assert.match(empty.note, /No samples yet/);

  modern.ws.close(); await once(modern.ws, 'close');
  for (let i = 0; i < 50 && app.hub.online(modern.serverId); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const after = app.metrics.availability(modern.serverId, '1h', false);
  assert.deepEqual(after.events.map(event => event.type), ['offline', 'online']);
});
