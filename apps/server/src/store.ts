import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const LANGUAGES = ['en', 'ko'] as const;
export type Language = typeof LANGUAGES[number];
export class AppError extends Error {
  /** `params` carries interpolated values so clients can localize the message by `code`. */
  constructor(public code: string, message: string, public status = 400, public params?: Record<string, string | number>) { super(message); }
}
export interface Job {
  id: string; serverId: string; serverName?: string; kind: 'job' | 'terminal'; path: string; cmd: string;
  status: string; startedAt: string; endedAt?: string; exitCode?: number; signal?: string; error?: string; errorCode?: string;
  pid?: number; cols?: number; rows?: number; runnerVersion?: string; outputBytes: number; label?: string | null;
}
interface JobRow { state: string; server_id: string; output_bytes: number; server_name: string; label: string | null }
const jobFromRow = (r: JobRow): Job => ({ ...JSON.parse(r.state), serverId: r.server_id, serverName: r.server_name, outputBytes: r.output_bytes, label: r.label ?? null });
export interface ServerRecord {
  id: string; name: string; hostname: string; executionUser: string; version: string;
  os: string; arch: string; lastSeen: string | null; createdAt: string; fault: string | null;
}

export interface JobQuery { kind?: string; serverId?: string; status?: string; q?: string; from?: string; limit: number; offset: number }
export interface ActivityDay { date: string; completed: number; failed: number; interrupted: number; other: number }
const FINISHED = ['completed', 'failed', 'interrupted'];

// Ordered schema changes; PRAGMA user_version records how many have run.
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  db => {
    const columns = new Set((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(c => c.name));
    if (!columns.has('status')) db.exec('ALTER TABLE jobs ADD COLUMN status TEXT');
    if (!columns.has('started_at')) db.exec('ALTER TABLE jobs ADD COLUMN started_at TEXT');
    db.exec(`UPDATE jobs SET status=json_extract(state,'$.status'), started_at=json_extract(state,'$.startedAt') WHERE expired=0;
      CREATE INDEX IF NOT EXISTS jobs_started ON jobs(kind, started_at);`);
  },
  // Central-owned display name; agent state updates never touch it.
  db => {
    const columns = new Set((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(c => c.name));
    if (!columns.has('label')) db.exec('ALTER TABLE jobs ADD COLUMN label TEXT');
  },
  // Administrator writes and agent connect/disconnect. Detail is small JSON and must not hold secrets.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
        status INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events(at);
    `);
  },
];

type JobState = Omit<Job, 'serverId' | 'outputBytes' | 'label'>;
type StoredJobRow = { server_id: string; expired: number; state: string };

/** Emits 'servers' when server records change and 'job' (id, serverId) when a job state is stored. */
export class Store extends EventEmitter {
  readonly db: Database.Database;
  readonly outputDir: string;
  private readonly readJobRow: Database.Statement;
  private readonly writeJobState: Database.Statement;
  constructor(readonly dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.outputDir = path.join(dataDir, 'outputs');
    mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dataDir, 'hostherd.sqlite'));
    chmodSync(path.join(dataDir, 'hostherd.sqlite'), 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, execution_user TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, hostname TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '', last_seen TEXT,
        created_at TEXT NOT NULL, deleted_at TEXT, fault TEXT
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, execution_user TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id), kind TEXT NOT NULL,
        state TEXT NOT NULL, output_bytes INTEGER NOT NULL DEFAULT 0, ended_at TEXT, expired INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_server ON jobs(server_id);
      CREATE INDEX IF NOT EXISTS jobs_ended ON jobs(ended_at);
      CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, job_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.migrate();
    this.readJobRow = this.db.prepare('SELECT server_id,expired,state FROM jobs WHERE id=?');
    this.writeJobState = this.db.prepare(`INSERT INTO jobs (id,server_id,kind,state,ended_at,status,started_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,ended_at=excluded.ended_at,status=excluded.status,started_at=excluded.started_at`);
  }
  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.transaction(() => { MIGRATIONS[index](this.db); this.db.pragma(`user_version = ${index + 1}`); })();
    }
  }
  servers(): ServerRecord[] {
    return this.db.prepare(`SELECT id,name,hostname,execution_user executionUser,version,os,arch,
      last_seen lastSeen,created_at createdAt,fault FROM servers WHERE deleted_at IS NULL ORDER BY created_at`).all() as ServerRecord[];
  }
  server(id: string): ServerRecord {
    const result = this.servers().find(s => s.id === id);
    if (!result) throw new AppError('SERVER_NOT_FOUND', 'Server not found.', 404);
    return result;
  }
  authenticateAgent(token: string): string | null {
    return (this.db.prepare('SELECT id FROM servers WHERE token_hash=? AND deleted_at IS NULL').get(hash(token)) as { id: string } | undefined)?.id ?? null;
  }
  enrollment(name: string, executionUser = '') {
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.db.prepare('INSERT INTO enrollments VALUES (?,?,?,?)').run(hash(code), name, executionUser, expiresAt);
    return { code, expiresAt };
  }
  enroll(code: string, info: Record<string, string>) {
    const result = this.db.transaction(() => {
      const enrollment = this.db.prepare('SELECT * FROM enrollments WHERE code_hash=? AND expires_at>?').get(hash(code), new Date().toISOString()) as { name: string; execution_user: string } | undefined;
      if (!enrollment) throw new AppError('INVALID_CODE', 'The enrollment code has expired or was already used.', 401);
      // An enrollment may fix the execution account; otherwise it is the
      // account reported by the verified native installer.
      const executionUser = enrollment.execution_user || info.executionUser;
      if (!executionUser) throw new AppError('INVALID_EXECUTION_USER', 'The agent did not report its execution account.');
      const serverId = randomUUID(); const token = randomBytes(32).toString('base64url');
      this.db.prepare(`INSERT INTO servers (id,name,execution_user,token_hash,hostname,version,os,arch,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(serverId, enrollment.name, executionUser, hash(token), info.hostname ?? '', info.version ?? '', info.os ?? '', info.arch ?? '', new Date().toISOString());
      this.db.prepare('DELETE FROM enrollments WHERE code_hash=?').run(hash(code));
      return { serverId, token, executionUser };
    })();
    this.emit('servers');
    return result;
  }
  renameServer(id: string, name: string) {
    this.server(id);
    this.db.prepare('UPDATE servers SET name=? WHERE id=?').run(name, id);
    this.emit('servers');
  }
  deleteServer(id: string) {
    this.server(id);
    this.db.prepare('UPDATE servers SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
    this.emit('servers');
  }
  seen(id: string, info?: Record<string, string>) {
    if (info) this.db.prepare('UPDATE servers SET hostname=?,version=?,os=?,arch=?,fault=NULL WHERE id=?').run(info.hostname ?? '', info.version ?? '', info.os ?? '', info.arch ?? '', id);
    this.db.prepare('UPDATE servers SET last_seen=? WHERE id=?').run(new Date().toISOString(), id);
    if (info) this.emit('servers');
  }
  fault(id: string, message: string | null) {
    this.db.prepare('UPDATE servers SET fault=? WHERE id=?').run(message, id); this.emit('servers');
    if (message) this.emit('fault', id, message);
  }
  storedJob(serverId: string, id: string): { status?: string; error?: string } | undefined {
    const row = this.db.prepare('SELECT state FROM jobs WHERE id=? AND server_id=?').get(id, serverId) as { state: string } | undefined;
    return row && JSON.parse(row.state);
  }
  labelJob(id: string, label: string | null) {
    this.job(id);
    this.db.prepare('UPDATE jobs SET label=? WHERE id=?').run(label, id);
    this.emit('job', id, this.job(id).serverId);
  }
  saveJob(serverId: string, state: JobState) {
    const { saved, errors } = this.applyJobStates(serverId, [state]);
    if (errors.length) throw errors[0].error;
    if (saved.length) this.emit('job', state.id, serverId);
  }
  /**
   * One agent's sync. Every job is upserted in order in a single transaction;
   * a job that cannot be stored is skipped and the rest are kept.
   */
  saveJobStates(serverId: string, states: JobState[], beforeEach?: (state: JobState, previous: { status?: string; error?: string } | undefined) => void) {
    if (states.length === 0) return [] as { id: string; error: Error }[];
    const { saved, errors } = this.db.transaction(() => this.applyJobStates(serverId, states, beforeEach))();
    for (const id of saved) this.emit('job', id, serverId);
    return errors;
  }
  private applyJobStates(serverId: string, states: JobState[], beforeEach?: (state: JobState, previous: { status?: string; error?: string } | undefined) => void) {
    const saved: string[] = [];
    const errors: { id: string; error: Error }[] = [];
    for (const state of states) {
      const id = typeof state?.id === 'string' ? state.id : '';
      try {
        if (!state || !/^[a-zA-Z0-9-]{1,100}$/.test(state.id)) throw new AppError('BAD_ID', 'Invalid job ID');
        const old = this.readJobRow.get(state.id) as StoredJobRow | undefined;
        const previous = old && old.server_id === serverId ? JSON.parse(old.state) as { status?: string; error?: string } : undefined;
        beforeEach?.(state, previous);
        if (old && old.server_id !== serverId) throw new AppError('JOB_OWNER', 'Job belongs to another server', 403);
        if (old?.expired) continue;
        // A fast command can finish before its start RPC response arrives.
        if (previous && FINISHED.includes(previous.status ?? '') && ['running', 'pending', 'unknown'].includes(state.status)) continue;
        this.writeJobState.run(state.id, serverId, state.kind, JSON.stringify(state), state.endedAt ?? null, state.status, state.startedAt);
        saved.push(state.id);
      } catch (error) {
        errors.push({ id, error: error instanceof Error ? error : new Error('Invalid job state') });
      }
    }
    return { saved, errors };
  }
  jobs(kind?: string, serverId?: string): Job[] {
    const rows = this.db.prepare(`SELECT j.*,s.name server_name FROM jobs j JOIN servers s ON s.id=j.server_id
      WHERE j.expired=0 AND (? IS NULL OR j.kind=?) AND (? IS NULL OR j.server_id=?)
      ORDER BY j.started_at DESC`).all(kind ?? null, kind ?? null, serverId ?? null, serverId ?? null) as JobRow[];
    return rows.map(jobFromRow);
  }
  /** One filtered page of jobs, newest first, with the total match count. */
  jobPage(query: JobQuery): { items: Job[]; total: number } {
    const where = ['j.expired=0']; const params: unknown[] = [];
    if (query.kind) { where.push('j.kind=?'); params.push(query.kind); }
    if (query.serverId) { where.push('j.server_id=?'); params.push(query.serverId); }
    if (query.status) { where.push('j.status=?'); params.push(query.status); }
    if (query.from) { where.push('j.started_at>=?'); params.push(query.from); }
    if (query.q) {
      where.push(`(instr(lower(json_extract(j.state,'$.cmd')),?)>0 OR instr(lower(json_extract(j.state,'$.path')),?)>0 OR instr(j.id,?)>0)`);
      const q = query.q.toLowerCase(); params.push(q, q, q);
    }
    const clause = where.join(' AND ');
    const total = (this.db.prepare(`SELECT count(*) n FROM jobs j WHERE ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT j.*,s.name server_name FROM jobs j JOIN servers s ON s.id=j.server_id WHERE ${clause}
      ORDER BY j.started_at DESC LIMIT ? OFFSET ?`).all(...params, query.limit, query.offset) as JobRow[];
    return { items: rows.map(jobFromRow), total };
  }
  /** Daily command-job counts for the last `days` days, bucketed by the client's UTC offset in minutes. */
  activity(days: number, offsetMinutes: number, now = Date.now()): ActivityDay[] {
    const shift = `${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`;
    const dayOf = (ms: number) => new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
    const dates = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 86400_000));
    const rows = this.db.prepare(`SELECT date(started_at, ?) day, status, count(*) n FROM jobs
      WHERE expired=0 AND kind='job' AND started_at>=? GROUP BY day, status`).all(shift, new Date(now - (days + 1) * 86400_000).toISOString()) as { day: string; status: string; n: number }[];
    const byDate = new Map(dates.map(date => [date, { date, completed: 0, failed: 0, interrupted: 0, other: 0 }]));
    for (const row of rows) {
      const day = byDate.get(row.day); if (!day) continue;
      if (row.status === 'completed' || row.status === 'failed' || row.status === 'interrupted') day[row.status] += row.n; else day.other += row.n;
    }
    return [...byDate.values()];
  }
  /** Running counts skip deleted servers: their remote jobs are not marked ended but are no longer reachable. */
  jobCounts(since: string) {
    return this.db.prepare(`SELECT
      sum(kind='job' AND status='running' AND s.deleted_at IS NULL) runningJobs, sum(kind='terminal' AND status='running' AND s.deleted_at IS NULL) activeTerminals,
      sum(kind='job' AND status='failed' AND started_at>=?) failedJobs, sum(kind='job' AND started_at>=?) recentJobs
      FROM jobs j JOIN servers s ON s.id=j.server_id WHERE expired=0`).get(since, since) as Record<'runningJobs' | 'activeTerminals' | 'failedJobs' | 'recentJobs', number | null>;
  }
  /** Administrator language for server-generated texts (webhooks); English unless set to Korean. */
  language(): Language { return this.setting('language') === 'ko' ? 'ko' : 'en'; }
  setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  /** Command jobs started since `since` that failed after `after` (an acknowledgement time). */
  failedJobs(since: string, after?: string) {
    return (this.db.prepare(`SELECT count(*) n FROM jobs WHERE expired=0 AND kind='job' AND status='failed' AND started_at>=?
      AND (? IS NULL OR coalesce(ended_at, started_at)>?)`).get(since, after ?? null, after ?? null) as { n: number }).n;
  }
  /** Running command jobs and terminals per server. */
  runningByServer(): Record<string, { jobs: number; terminals: number }> {
    const rows = this.db.prepare(`SELECT server_id, sum(kind='job') jobs, sum(kind='terminal') terminals FROM jobs
      WHERE expired=0 AND status='running' AND server_id IN (SELECT id FROM servers WHERE deleted_at IS NULL) GROUP BY server_id`).all() as { server_id: string; jobs: number; terminals: number }[];
    return Object.fromEntries(rows.map(row => [row.server_id, { jobs: row.jobs, terminals: row.terminals }]));
  }
  job(id: string): Job {
    const r = this.db.prepare(`SELECT j.*,s.name server_name FROM jobs j JOIN servers s ON s.id=j.server_id WHERE j.id=? AND expired=0`).get(id) as JobRow | undefined;
    if (!r) throw new AppError('JOB_NOT_FOUND', 'Job not found.', 404);
    return jobFromRow(r);
  }
  request(requestId: string, payload: unknown): string | undefined {
    const old = this.db.prepare('SELECT * FROM requests WHERE request_id=?').get(requestId) as { payload_hash: string; job_id: string } | undefined;
    if (old && old.payload_hash !== hash(JSON.stringify(payload))) throw new AppError('REQUEST_CONFLICT', 'requestId was already used with a different command. Use a new requestId for a different command.', 409);
    return old?.job_id;
  }
  rememberRequest(requestId: string, payload: unknown, jobId: string) {
    this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(requestId, hash(JSON.stringify(payload)), jobId);
  }
  cursors(serverId: string): Record<string, number> {
    const rows = this.db.prepare('SELECT id,output_bytes FROM jobs WHERE server_id=?').all(serverId) as { id: string; output_bytes: number }[];
    return Object.fromEntries(rows.map(r => [r.id, r.output_bytes]));
  }
  outputPath(id: string) { return path.join(this.outputDir, `${id}.log`); }
  async appendOutput(serverId: string, id: string, offset: number, bytes: Buffer) {
    const row = this.db.prepare('SELECT server_id,output_bytes FROM jobs WHERE id=?').get(id) as { server_id: string; output_bytes: number } | undefined;
    if (!row || row.server_id !== serverId) throw new AppError('JOB_OWNER', 'Unknown output stream');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.output_bytes) throw new AppError('OUTPUT_GAP', 'Output cursor mismatch');
    const overlap = row.output_bytes - offset;
    if (overlap >= bytes.length) return row.output_bytes;
    const data = bytes.subarray(overlap);
    const filename = this.outputPath(id);
    const file = await open(filename, existsSync(filename) ? 'r+' : 'w+', 0o600);
    try {
      let written = 0;
      while (written < data.length) {
        const result = await file.write(data, written, data.length - written, row.output_bytes + written);
        if (!result.bytesWritten) throw new Error('Unable to write output');
        written += result.bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
    const next = row.output_bytes + data.length;
    this.db.prepare('UPDATE jobs SET output_bytes=? WHERE id=?').run(next, id);
    return next;
  }
  async output(id: string, cursor = 0, limit = 65536) {
    const job = this.job(id);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.outputBytes) throw new AppError('BAD_CURSOR', 'The output cursor is invalid.');
    limit = Math.min(1024 * 1024, Math.max(1, limit));
    const length = Math.min(limit, job.outputBytes - cursor);
    const bytes = Buffer.alloc(length);
    if (length) {
      const file = await open(this.outputPath(id), 'r');
      try { await file.read(bytes, 0, length, cursor); } finally { await file.close(); }
    }
    return { data: bytes.toString('base64'), cursor, nextCursor: cursor + length, eof: cursor + length >= job.outputBytes };
  }
  async cleanup(now = Date.now()) {
    const cutoff = new Date(now - 30 * 86400_000).toISOString();
    // Jobs of servers deleted before the cutoff expire too: they can never report an end.
    const rows = this.db.prepare(`SELECT id FROM jobs WHERE expired=0 AND ((ended_at IS NOT NULL AND ended_at<?)
      OR server_id IN (SELECT id FROM servers WHERE deleted_at<?))`).all(cutoff, cutoff) as { id: string }[];
    for (const { id } of rows) {
      await unlink(this.outputPath(id)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
      // Keep only the ID and acknowledged offset, so reconnect cannot resurrect old jobs.
      this.db.prepare("UPDATE jobs SET state='{}',expired=1 WHERE id=?").run(id);
    }
    this.db.prepare('DELETE FROM requests WHERE job_id IN (SELECT id FROM jobs WHERE expired=1)').run();
    this.db.prepare('DELETE FROM enrollments WHERE expires_at<?').run(new Date(now).toISOString());
  }
  close() { this.db.close(); }
}
