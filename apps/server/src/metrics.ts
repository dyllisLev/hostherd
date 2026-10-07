import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Resource samples live in their own database: frequent small writes do not
// need the job store's synchronous=FULL durability.
export const METRICS_INTERVAL_MS = 30_000;
const RAW_RETENTION = 48 * 3600, FIVE_MIN_RETENTION = 35 * 86400, HOUR_RETENTION = 400 * 86400, EVENT_RETENTION = 90 * 86400;

const bytes = z.number().nonnegative().finite();
const percent = z.number().min(0).max(100);
export const metricsSample = z.object({
  cpu: percent.optional(), cpus: z.number().int().min(0).max(100_000),
  load1: bytes.optional(), load5: bytes.optional(), load15: bytes.optional(),
  memTotal: bytes.optional(), memUsed: bytes.optional(), swapTotal: bytes.optional(), swapUsed: bytes.optional(),
  netRx: bytes.optional(), netTx: bytes.optional(), uptime: bytes.optional(), procs: z.number().int().nonnegative().optional(),
  disks: z.array(z.object({ mount: z.string().max(1024), fs: z.string().max(64), total: bytes, used: bytes, avail: bytes })).max(64),
});
export type MetricsSample = z.infer<typeof metricsSample>;
export interface LatestMetrics { at: string; cpu: number | null; memPct: number | null; diskPct: number | null; load1: number | null }
export interface MetricsPoint { t: string; cpu: number | null; cpuMax: number | null; mem: number | null; disk: number | null; load: number | null; rx: number | null; tx: number | null }
export const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 } as const;
export type Range = keyof typeof RANGES;

const diskPercent = (disk: { used: number; avail: number }) => disk.used + disk.avail > 0 ? disk.used * 100 / (disk.used + disk.avail) : 0;
const round = (value: number | null | undefined, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const seconds = (ms: number) => Math.floor(ms / 1000);

export class MetricsStore {
  readonly db: Database.Database;
  constructor(dataDir: string, readonly intervalMs = METRICS_INTERVAL_MS) {
    const file = path.join(dataDir, 'metrics.sqlite');
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    const columns = 'server_id TEXT NOT NULL, at INTEGER NOT NULL, cpu REAL, cpu_max REAL, load1 REAL, mem_used REAL, mem_total REAL, disk_pct REAL, net_rx REAL, net_tx REAL, PRIMARY KEY (server_id, at)';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (${columns}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS rollup_5m (${columns}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS rollup_1h (${columns}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS latest (server_id TEXT PRIMARY KEY, at INTEGER NOT NULL, sample TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS server_events (server_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS server_events_at ON server_events(server_id, at);
    `);
  }

  record(serverId: string, sample: MetricsSample, now = Date.now()) {
    const at = seconds(now);
    const disk = sample.disks.length ? Math.max(...sample.disks.map(diskPercent)) : null;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR REPLACE INTO samples (server_id,at,cpu,cpu_max,load1,mem_used,mem_total,disk_pct,net_rx,net_tx) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(serverId, at, sample.cpu ?? null, sample.cpu ?? null, sample.load1 ?? null, sample.memUsed ?? null, sample.memTotal ?? null, disk, sample.netRx ?? null, sample.netTx ?? null);
      this.db.prepare('INSERT OR REPLACE INTO latest (server_id,at,sample) VALUES (?,?,?)').run(serverId, at, JSON.stringify(sample));
    })();
  }

  event(serverId: string, type: 'online' | 'offline', now = Date.now()) {
    this.db.prepare('INSERT INTO server_events (server_id,at,type) VALUES (?,?,?)').run(serverId, now, type);
  }

  latest(serverId: string): { at: string; sample: MetricsSample } | null {
    const row = this.db.prepare('SELECT at,sample FROM latest WHERE server_id=?').get(serverId) as { at: number; sample: string } | undefined;
    return row ? { at: new Date(row.at * 1000).toISOString(), sample: JSON.parse(row.sample) } : null;
  }

  /** Compact current values for every server with a report. */
  summaries(): Map<string, LatestMetrics> {
    const rows = this.db.prepare('SELECT server_id,at,sample FROM latest').all() as { server_id: string; at: number; sample: string }[];
    return new Map(rows.map(row => {
      const sample = JSON.parse(row.sample) as MetricsSample;
      return [row.server_id, {
        at: new Date(row.at * 1000).toISOString(), cpu: round(sample.cpu), load1: round(sample.load1, 2),
        memPct: sample.memTotal && sample.memUsed !== undefined ? round(sample.memUsed * 100 / sample.memTotal) : null,
        diskPct: sample.disks.length ? round(Math.max(...sample.disks.map(diskPercent))) : null,
      }];
    }));
  }

  /** Evenly bucketed series ending now; missing buckets are null so charts show gaps. */
  series(serverId: string, range: Range, now = Date.now()) {
    const span = RANGES[range], end = seconds(now), start = end - span;
    const table = span <= RAW_RETENTION ? 'samples' : span <= FIVE_MIN_RETENTION - 86400 ? 'rollup_5m' : 'rollup_1h';
    // Raw buckets span two report intervals so timing jitter does not leave false gaps.
    const resolution = table === 'samples' ? Math.max(10, Math.ceil(2 * this.intervalMs / 1000)) : table === 'rollup_5m' ? 300 : 3600;
    const step = Math.max(resolution, Math.ceil(span / 240 / resolution) * resolution);
    // step is an internal integer; inlined so SQLite divides as integers.
    const rows = this.db.prepare(`SELECT (at/${step})*${step} bucket, avg(cpu) cpu, max(cpu_max) cpuMax, avg(mem_used*100.0/mem_total) mem, max(disk_pct) disk,
      avg(load1) load, avg(net_rx) rx, avg(net_tx) tx FROM ${table} WHERE server_id=? AND at>? AND at<=? GROUP BY bucket`)
      .all(serverId, start, end) as { bucket: number; cpu: number | null; cpuMax: number | null; mem: number | null; disk: number | null; load: number | null; rx: number | null; tx: number | null }[];
    const byBucket = new Map(rows.map(row => [row.bucket, row]));
    const points: MetricsPoint[] = [];
    for (let bucket = Math.floor(start / step) * step + step; bucket <= end; bucket += step) {
      const row = byBucket.get(bucket);
      points.push({ t: new Date(bucket * 1000).toISOString(), cpu: round(row?.cpu), cpuMax: round(row?.cpuMax), mem: round(row?.mem), disk: round(row?.disk), load: round(row?.load, 2), rx: round(row?.rx, 0), tx: round(row?.tx, 0) });
    }
    return { range, step, points };
  }

  /** Connection changes in the range, and the share of known time spent online. */
  availability(serverId: string, range: Range, online: boolean, now = Date.now()) {
    const start = now - RANGES[range] * 1000;
    const before = this.db.prepare('SELECT type,at FROM server_events WHERE server_id=? AND at<=? ORDER BY at DESC LIMIT 1').get(serverId, start) as { type: string; at: number } | undefined;
    const events = this.db.prepare('SELECT type,at FROM server_events WHERE server_id=? AND at>? ORDER BY at').all(serverId, start) as { type: 'online' | 'offline'; at: number }[];
    let state: string | undefined = before?.type, cursor = start, up = 0, known = 0;
    for (const event of events) {
      if (state) { known += event.at - cursor; if (state === 'online') up += event.at - cursor; }
      state = event.type; cursor = event.at;
    }
    if (!state && !events.length) state = online ? 'online' : undefined;
    if (state) { known += now - cursor; if (state === 'online') up += now - cursor; }
    const recent = this.db.prepare('SELECT type,at FROM server_events WHERE server_id=? ORDER BY at DESC LIMIT 20').all(serverId) as { type: string; at: number }[];
    return { percent: known > 0 ? round(up * 100 / known, 2) : null, events: recent.map(event => ({ type: event.type, at: new Date(event.at).toISOString() })) };
  }

  /** Re-aggregates the newest buckets; older buckets are already final. */
  rollup(now = Date.now()) {
    const at = seconds(now);
    const aggregate = (source: string, target: string, step: number, from: number) => this.db.prepare(`INSERT OR REPLACE INTO ${target}
      SELECT server_id, (at/${step})*${step}, avg(cpu), max(cpu_max), avg(load1), avg(mem_used), max(mem_total), max(disk_pct), avg(net_rx), avg(net_tx)
      FROM ${source} WHERE at>=? GROUP BY server_id, at/${step}`).run(from);
    this.db.transaction(() => {
      aggregate('samples', 'rollup_5m', 300, Math.floor((at - 900) / 300) * 300);
      aggregate('rollup_5m', 'rollup_1h', 3600, Math.floor((at - 7200) / 3600) * 3600);
    })();
  }

  cleanup(now = Date.now()) {
    const at = seconds(now);
    this.db.prepare('DELETE FROM samples WHERE at<?').run(at - RAW_RETENTION);
    this.db.prepare('DELETE FROM rollup_5m WHERE at<?').run(at - FIVE_MIN_RETENTION);
    this.db.prepare('DELETE FROM rollup_1h WHERE at<?').run(at - HOUR_RETENTION);
    this.db.prepare('DELETE FROM server_events WHERE at<?').run(now - EVENT_RETENTION * 1000);
  }

  /** Removes a deleted server's samples. */
  forget(serverId: string) {
    this.db.transaction(() => {
      for (const table of ['samples', 'rollup_5m', 'rollup_1h', 'latest', 'server_events']) this.db.prepare(`DELETE FROM ${table} WHERE server_id=?`).run(serverId);
    })();
  }

  close() { this.db.close(); }
}
