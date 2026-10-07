import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError, Store } from './store.js';

export type RequestOutcome = 'pending' | 'success' | 'error' | 'unknown';
export interface RequestLog {
  traceId: string; receivedAt: string; endedAt?: string; durationMs?: number;
  httpMethod: string; httpPath: string; httpStatus?: number;
  rpcId?: string | number | null; method?: string; tool?: string;
  serverId?: string; serverName?: string; executionUser?: string;
  clientId?: string; subject?: string; clientName?: string; userAgent?: string;
  requestId?: string; jobId?: string; transferId?: string;
  arguments?: unknown; result?: unknown; outcome: RequestOutcome;
  errorCode?: string | number; error?: string; failureStage?: string;
  mcpIsError?: boolean; jsonRpcErrorCode?: number; incomplete?: boolean;
}
interface TraceContext { record: RequestLog; started: number; toolEntered: boolean }
export interface RequestLogFilters {
  from?: string; to?: string; serverId?: string; tool?: string; outcome?: RequestOutcome;
  q?: string; cursor?: string; limit?: number;
}
type ObjectValue = Record<string, unknown>;
const COMMAND_TOOLS = new Set(['job_start', 'job_input', 'job_cancel']);
/** Tool errors that mean the command policy held the call, not that it failed. */
const HELD_CODES = new Set(['APPROVAL_REQUIRED', 'APPROVAL_DENIED', 'COMMAND_BLOCKED']);
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const secretWords = '(?:authorization|cookie|password|passwd|passphrase|token|secret|api[_-]?key|private[_-]?key|credential|bearer)';
const secretKey = new RegExp(secretWords, 'i');
const payloadKey = /^(data|text|oldText|newText|output|content|body)$/i;

/** Redact before persistence, including secrets embedded in commands and error messages. */
export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:hostherd_|sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:^|\s)(?:-H|--header)(?:\s*|=))("(?:\\.|[^"\\])*"|'[^']*')/g, (raw, flag: string, quoted: string) => {
      const header = new RegExp(String.raw`^([\w-]*${secretWords}[\w-]*\s*:)`, 'i').exec(quoted.slice(1, -1));
      return header ? `${flag}${quoted[0]}${header[1]} [REDACTED]${quoted[0]}` : raw;
    })
    .replace(/https?:\/\/[^\s<>"']+/g, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = ''; url.password = ''; }
        if (url.search) url.search = '?[REDACTED]';
        if (url.hash) url.hash = '#[REDACTED]';
        url.pathname = url.pathname.replace(/(\/files\/download\/[^/]+\/)[^/]+/, '$1[REDACTED]');
        return url.toString();
      } catch { return '[REDACTED URL]'; }
    })
    .replace(new RegExp(String.raw`\b([\w-]*${secretWords}[\w-]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(String.raw`(--[\w-]*${secretWords}[\w-]*\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(String.raw`(["'][\w-]*${secretWords}[\w-]*["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)`, 'gi'), '$1"[REDACTED]"')
    .replace(new RegExp(String.raw`(\b[\w-]*${secretWords}[\w-]*\s*:\s*)(?:"[^"]*"|'[^']*'|[^\r\n"']+)`, 'gi'), '$1[REDACTED]')
    .replace(/((?:^|\s)(?:-u|-b|--user)\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)/g, '$1[REDACTED]');
}

export function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (secretKey.test(key) || /^(download_url|downloadUrl)$/i.test(key)) return '[REDACTED]';
  if (key === 'env') return object(value) ? Object.fromEntries(Object.keys(value as ObjectValue).map(k => [redactText(k), '[REDACTED]'])) : '[REDACTED]';
  if (payloadKey.test(key)) return { omitted: true, ...(typeof value === 'string' ? { encodedBytes: Buffer.byteLength(value) } : {}) };
  if (depth > 12) return { omitted: true, reason: 'nesting' };
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitize(v, '', depth + 1)).concat(value.length > 100 ? [{ omitted: true, count: value.length - 100 }] : []);
  if (object(value)) return Object.fromEntries(Object.entries(value as ObjectValue).map(([k, v]) => [redactText(k), sanitize(v, k, depth + 1)]));
  return value;
}

const resultKeys = new Set(['id', 'jobId', 'transferId', 'serverId', 'status', 'phase', 'exitCode', 'signal', 'errorCode', 'code', 'error', 'message', 'path', 'filename', 'mimeType', 'size', 'width', 'height', 'bytes', 'outputBytes', 'cursor', 'nextCursor', 'nextOffset', 'eof', 'total', 'count', 'sha256', 'generation', 'runnerVersion', 'startedAt', 'endedAt', 'createdAt', 'updatedAt', 'expiresAt', 'ok']);
export function summarizeResult(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length };
  const record = object(value);
  if (!record) return { type: value === null ? 'null' : typeof value };
  const result: ObjectValue = {};
  for (const [key, v] of Object.entries(record)) {
    if (resultKeys.has(key)) result[key] = sanitize(v, key);
    else if (Array.isArray(v)) result[key] = { count: v.length };
    else if (key === 'data' && typeof v === 'string') result.encodedBytes = Buffer.byteLength(v);
    else if (key === 'output' && object(v)) {
      result.output = Object.fromEntries(Object.entries(v as ObjectValue).filter(([k]) => ['cursor', 'nextCursor', 'eof'].includes(k)));
    }
  }
  return result;
}

export class RequestLogs {
  private context = new AsyncLocalStorage<TraceContext>();
  private startedAt = new Date().toISOString();
  private failedWrites = 0;
  private lastErrorAt?: string;

  constructor(readonly store: Store) {
    this.safe(() => {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS request_log_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS request_logs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT NOT NULL UNIQUE,
          received_at TEXT NOT NULL, ended_at TEXT, server_id TEXT, tool TEXT,
          outcome TEXT NOT NULL, record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS request_logs_received ON request_logs(received_at);
        CREATE INDEX IF NOT EXISTS request_logs_server ON request_logs(server_id, seq);
        CREATE INDEX IF NOT EXISTS request_logs_tool ON request_logs(tool, seq);
        CREATE TABLE IF NOT EXISTS request_log_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id TEXT NOT NULL REFERENCES request_logs(trace_id) ON DELETE CASCADE,
          at TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, data TEXT
        );
        CREATE INDEX IF NOT EXISTS request_log_events_trace ON request_log_events(trace_id, seq);
      `);
      store.db.prepare('INSERT OR IGNORE INTO request_log_meta VALUES (?,?)').run('startedAt', this.startedAt);
      this.startedAt = (store.db.prepare('SELECT value FROM request_log_meta WHERE key=?').get('startedAt') as { value: string }).value;
      const rows = store.db.prepare('SELECT record FROM request_logs WHERE ended_at IS NULL').all() as { record: string }[];
      for (const row of rows) {
        const record = JSON.parse(row.record) as RequestLog;
        record.outcome = 'unknown'; record.endedAt = new Date().toISOString();
        record.durationMs = Date.parse(record.endedAt) - Date.parse(record.receivedAt);
        record.failureStage = 'response'; record.errorCode = 'CENTRAL_RESTARTED';
        record.error = 'Hostherd restarted before the response completed. Check the status of the linked job.';
        this.persist(record, 'response', 'unknown', { code: record.errorCode });
      }
    });
  }

  private safe<T>(fn: () => T): T | undefined {
    try { return fn(); }
    catch {
      this.failedWrites++; this.lastErrorAt = new Date().toISOString();
      const ctx = this.context.getStore();
      if (ctx) ctx.record.incomplete = true;
      if (this.failedWrites === 1) console.error('Request trace storage failed; request logs may be incomplete.');
      return undefined;
    }
  }

  collection() { return { startedAt: this.startedAt, status: this.failedWrites ? 'degraded' as const : 'ok' as const, failedWrites: this.failedWrites, lastErrorAt: this.lastErrorAt }; }
  current() { return this.context.getStore(); }

  private persist(record: RequestLog, stage?: string, status?: string, data?: unknown) {
    this.safe(() => this.store.db.transaction(() => {
      this.store.db.prepare(`INSERT INTO request_logs (trace_id,received_at,ended_at,server_id,tool,outcome,record) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(trace_id) DO UPDATE SET ended_at=excluded.ended_at,server_id=excluded.server_id,tool=excluded.tool,outcome=excluded.outcome,record=excluded.record`)
        .run(record.traceId, record.receivedAt, record.endedAt ?? null, record.serverId ?? null, record.tool ?? null, record.outcome, JSON.stringify(record));
      if (stage) this.store.db.prepare('INSERT INTO request_log_events (trace_id,at,stage,status,data) VALUES (?,?,?,?,?)')
        .run(record.traceId, new Date().toISOString(), stage, status ?? 'info', data === undefined ? null : JSON.stringify(sanitize(data)));
    })());
  }

  event(stage: string, status: string, data?: unknown, ctx = this.current()) {
    if (ctx) this.persist(ctx.record, stage, status, data);
  }
  update(fields: Partial<RequestLog>, ctx = this.current()) {
    if (!ctx) return;
    Object.assign(ctx.record, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? redactText(value) : value]))); this.persist(ctx.record);
  }
  failure(stage: string, error: unknown, ctx = this.current()) {
    if (!ctx) return;
    const e = error as { code?: string | number; message?: string; type?: string } | undefined;
    const rawCode = e?.code ?? e?.type ?? 'ERROR';
    const code = typeof rawCode === 'string' ? redactText(rawCode) : rawCode;
    const message = e?.type === 'entity.parse.failed' ? 'Malformed JSON request body.' : e?.type === 'entity.too.large' ? 'Request body exceeds the size limit.' : redactText(String(e?.message ?? error));
    if (!ctx.record.endedAt) Object.assign(ctx.record, { outcome: code === 'EXECUTION_UNKNOWN' ? 'unknown' : 'error', failureStage: stage, errorCode: code, error: message });
    this.event(stage, 'error', { code, message }, ctx);
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      if (!/^\/mcp\/?$/i.test(req.path)) { next(); return; }
      const ctx: TraceContext = { record: {
        traceId: randomUUID(), receivedAt: new Date().toISOString(), httpMethod: req.method,
        httpPath: req.path, userAgent: redactText((req.get('user-agent') ?? '').slice(0, 1024)), outcome: 'pending',
      }, started: performance.now(), toolEntered: false };
      res.setHeader('X-Hostherd-Trace-Id', ctx.record.traceId);
      this.context.run(ctx, () => {
        this.event('received', 'start', { contentType: req.get('content-type'), contentLength: req.get('content-length') });
        const finish = (closed: boolean) => {
          if (ctx.record.endedAt) return;
          ctx.record.endedAt = new Date().toISOString(); ctx.record.durationMs = Math.round(performance.now() - ctx.started);
          ctx.record.httpStatus = res.statusCode;
          if (closed && !res.writableFinished) {
            ctx.record.outcome = 'unknown'; ctx.record.failureStage = 'response';
            ctx.record.errorCode = 'RESPONSE_INTERRUPTED'; ctx.record.error = 'The response connection closed early. Check whether the linked job ran.';
          } else if (ctx.record.outcome === 'pending') ctx.record.outcome = res.statusCode >= 400 ? 'error' : 'success';
          this.event('response', ctx.record.outcome, { httpStatus: res.statusCode, durationMs: ctx.record.durationMs }, ctx);
        };
        res.once('finish', () => finish(false)); res.once('close', () => finish(true));
        next();
      });
    };
  }

  request(body: unknown) {
    const ctx = this.current(); if (!ctx) return;
    this.event('parse', 'success');
    const envelope = object(body);
    if (!envelope) { this.event('sdk', 'start', { bodyType: Array.isArray(body) ? 'array' : typeof body }); return; }
    const params = object(envelope.params), args = object(params?.arguments);
    this.update({
      rpcId: typeof envelope.id === 'string' || typeof envelope.id === 'number' || envelope.id === null ? envelope.id : undefined,
      method: typeof envelope.method === 'string' ? redactText(envelope.method) : undefined,
      tool: typeof params?.name === 'string' ? redactText(params.name) : undefined,
      arguments: sanitize(params?.arguments ?? params),
      clientName: typeof object(params?.clientInfo)?.name === 'string' ? redactText(object(params?.clientInfo)!.name as string) : undefined,
    });
    if (typeof args?.requestId === 'string') this.update({ requestId: redactText(args.requestId) });
    if (typeof args?.serverId === 'string') this.server(args.serverId);
    if (typeof args?.jobId === 'string') this.job(args.jobId);
    if (typeof args?.transferId === 'string') this.update({ transferId: redactText(args.transferId) });
  }

  server(serverId: string, ctx = this.current()) {
    if (!ctx) return;
    let snapshot: Partial<RequestLog> = {};
    try { const server = this.store.server(serverId); snapshot = { serverName: redactText(server.name), executionUser: server.executionUser }; } catch { /* Unknown target is recorded by the operation. */ }
    this.update({ serverId: redactText(serverId), ...snapshot }, ctx);
  }
  job(jobId: string, ctx = this.current()) {
    if (!ctx) return;
    this.update({ jobId: redactText(jobId) }, ctx);
    try { this.server(this.store.job(jobId).serverId, ctx); } catch { /* Retain the requested ID even when no job exists. */ }
  }
  tool() { const ctx = this.current(); if (ctx) { ctx.toolEntered = true; this.event('tool', 'start'); } }

  result(value: unknown, ctx = this.current()) {
    if (!ctx) return;
    const state = object(value);
    if (typeof state?.jobId === 'string') this.job(state.jobId, ctx);
    if (typeof state?.transferId === 'string') this.update({ transferId: state.transferId }, ctx);
    if (typeof state?.serverId === 'string') this.server(state.serverId, ctx);
    this.update({ result: summarizeResult(value) }, ctx);
  }

  /** Observe SDK messages before encoding; never buffer or rewrite image/SSE bytes. */
  message(message: unknown, ctx = this.current()) {
    if (!ctx) return;
    const m = object(message); if (!m || !('id' in m)) return;
    if (m.error) {
      const err = object(m.error)!;
      this.update({ jsonRpcErrorCode: typeof err.code === 'number' ? err.code : undefined }, ctx);
      this.failure('sdk', err, ctx); return;
    }
    if (!('result' in m)) return;
    const result = object(m.result);
    if (ctx.record.method === 'tools/call' && result) {
      result._meta = { ...object(result._meta), 'hostherd/traceId': ctx.record.traceId };
      this.update({ mcpIsError: result.isError === true }, ctx);
      if (result.isError === true) {
        const texts = Array.isArray(result.content) ? result.content.map(c => object(c)?.type === 'text' ? object(c)?.text : undefined).filter((v): v is string => typeof v === 'string') : [];
        let error: ObjectValue = { code: 'MCP_TOOL_ERROR', message: texts.join('\n') || 'Tool execution failed' };
        try {
          const parsed = object(JSON.parse(texts[0]));
          if (parsed) { error = { code: parsed.code ?? parsed.errorCode ?? 'MCP_TOOL_ERROR', message: parsed.error ?? parsed.message ?? error.message }; this.result(parsed, ctx); }
        } catch { /* SDK validation errors are plain text. */ }
        this.failure(ctx.toolEntered ? (ctx.record.failureStage ?? 'tool') : 'sdk', error, ctx);
      } else {
        if (!ctx.record.result) this.update({ result: summarizeResult(m.result) }, ctx);
        if (!ctx.record.endedAt) this.update({ outcome: 'success', errorCode: undefined, error: undefined, failureStage: undefined }, ctx);
      }
    } else this.update({ result: summarizeResult(m.result), ...(!ctx.record.endedAt ? { outcome: 'success' as const, errorCode: undefined, error: undefined, failureStage: undefined } : {}) }, ctx);
    this.event('sdk', result?.isError ? 'error' : 'success', { mcpIsError: result?.isError === true }, ctx);
  }

  rpc(serverId: string, method: string, rpcId: string, params: unknown) {
    const ctx = this.current();
    if (ctx) {
      this.server(serverId, ctx);
      this.event('rpc', 'start', { rpcId, method, arguments: sanitize(params) }, ctx);
    }
    return (result?: unknown, error?: unknown) => {
      if (!ctx) return;
      if (error) { this.failure('rpc', error, ctx); this.event('rpc', 'error', { rpcId, method }, ctx); }
      else this.event('rpc', 'success', { rpcId, method, result: summarizeResult(result) }, ctx);
    };
  }

  list(filters: RequestLogFilters = {}) {
    const where = ['received_at >= ?'];
    const values: (string | number)[] = [filters.from ?? new Date(Date.now() - 86400_000).toISOString()];
    for (const [column, value] of [['server_id', filters.serverId], ['tool', filters.tool], ['outcome', filters.outcome]] as const) {
      if (value) { where.push(`${column} = ?`); values.push(value); }
    }
    if (filters.to) { where.push('received_at <= ?'); values.push(filters.to); }
    if (filters.cursor) { where.push('seq < ?'); values.push(Number(filters.cursor)); }
    if (filters.q) {
      const query = '%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%';
      where.push("(record LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM request_log_events e WHERE e.trace_id=request_logs.trace_id AND e.data LIKE ? ESCAPE '\\'))");
      values.push(query, query);
    }
    const limit = filters.limit ?? 50;
    const rows = this.safe(() => this.store.db.prepare(`SELECT seq,record FROM request_logs WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...values, limit + 1) as { seq: number; record: string }[]) ?? [];
    return { items: rows.slice(0, limit).map(r => JSON.parse(r.record) as RequestLog), nextCursor: rows.length > limit ? String(rows[limit - 1].seq) : null, collection: this.collection() };
  }

  /** MCP tool calls by kind: daily since `days` ago (client UTC offset), a 24-hour summary and the latest calls. */
  toolActivity(days: number, offsetMinutes: number, now = Date.now()) {
    const shift = `${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`;
    const dayOf = (ms: number) => new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
    const dates = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 86400_000));
    const byDate = new Map(dates.map(date => [date, { date, command: 0, file: 0, query: 0, held: 0, error: 0 }]));
    const kind = (tool: string, outcome: string, code: string | null) => {
      if (code && HELD_CODES.has(code)) return 'held';
      if (outcome === 'error' || outcome === 'unknown') return 'error';
      return COMMAND_TOOLS.has(tool) ? 'command' : tool.startsWith('file_') || tool === 'image_read' ? 'file' : 'query';
    };
    const rows = this.safe(() => this.store.db.prepare(`SELECT date(received_at, ?) day, tool, outcome, json_extract(record,'$.errorCode') code, count(*) n FROM request_logs
      WHERE tool IS NOT NULL AND received_at>=? GROUP BY day, tool, outcome, code`).all(shift, new Date(now - (days + 1) * 86400_000).toISOString()) as { day: string; tool: string; outcome: string; code: string | null; n: number }[]) ?? [];
    for (const row of rows) { const day = byDate.get(row.day); if (day) day[kind(row.tool, row.outcome, row.code)] += row.n; }
    const recentRows = this.safe(() => this.store.db.prepare(`SELECT tool, outcome, json_extract(record,'$.errorCode') code, count(*) n FROM request_logs
      WHERE tool IS NOT NULL AND received_at>=? GROUP BY tool, outcome, code`).all(new Date(now - 86400_000).toISOString()) as { tool: string; outcome: string; code: string | null; n: number }[]) ?? [];
    const summary = { requests: 0, errors: 0, held: 0 };
    for (const row of recentRows) {
      summary.requests += row.n;
      const value = kind(row.tool, row.outcome, row.code);
      if (value === 'error') summary.errors += row.n; else if (value === 'held') summary.held += row.n;
    }
    const latest = (this.safe(() => this.store.db.prepare('SELECT record FROM request_logs WHERE tool IS NOT NULL ORDER BY seq DESC LIMIT 6').all() as { record: string }[]) ?? [])
      .map(row => {
        const record = JSON.parse(row.record) as RequestLog;
        const args = object(record.arguments);
        const target = [args?.cmd, args?.path, args?.data, args?.jobId, args?.transferId].find(value => typeof value === 'string');
        return { traceId: record.traceId, receivedAt: record.receivedAt, tool: record.tool!, serverId: record.serverId ?? null, serverName: record.serverName ?? null,
          clientId: record.clientId ?? null, outcome: record.outcome, errorCode: record.errorCode ?? null, summary: typeof target === 'string' ? target.slice(0, 300) : null };
      });
    const clients = (this.safe(() => this.store.db.prepare(`SELECT json_extract(record,'$.clientId') client, count(*) n,
      sum(outcome IN ('error','unknown') AND coalesce(json_extract(record,'$.errorCode'),'') NOT IN ('APPROVAL_REQUIRED','APPROVAL_DENIED','COMMAND_BLOCKED')) errors,
      max(received_at) last FROM request_logs WHERE tool IS NOT NULL AND received_at>=? GROUP BY client ORDER BY n DESC LIMIT 6`)
      .all(new Date(now - 86400_000).toISOString()) as { client: string | null; n: number; errors: number; last: string }[]) ?? [])
      .map(row => ({ clientId: row.client, requests: row.n, errors: row.errors, lastAt: row.last }));
    return { days: [...byDate.values()], summary, latest, clients };
  }

  detail(traceId: string) {
    const row = this.safe(() => (this.store.db.prepare('SELECT record FROM request_logs WHERE trace_id=?').get(traceId) as { record: string } | undefined) ?? null);
    if (row === undefined) throw new AppError('TRACE_STORAGE_UNAVAILABLE', 'Request log storage is unavailable.', 503);
    if (!row) throw new AppError('TRACE_NOT_FOUND', 'Request log not found or past its retention period.', 404);
    const request = JSON.parse(row.record) as RequestLog;
    const events = this.safe(() => (this.store.db.prepare('SELECT seq,at,stage,status,data FROM request_log_events WHERE trace_id=? ORDER BY seq').all(traceId) as { seq: number; at: string; stage: string; status: string; data: string | null }[])
      .map(event => ({ ...event, data: event.data ? JSON.parse(event.data) : undefined }))) ?? [];
    let job, transfer;
    if (request.jobId) {
      try { const state = this.store.job(request.jobId); job = { id: state.id, kind: state.kind, status: state.status, exitCode: state.exitCode, outputBytes: state.outputBytes, endedAt: state.endedAt }; } catch { /* Job may have expired. */ }
    }
    if (request.transferId) {
      try {
        const row = this.store.db.prepare('SELECT state FROM file_transfers WHERE id=?').get(request.transferId) as { state: string } | undefined;
        if (row) { const t = JSON.parse(row.state); transfer = { transferId: t.transferId, status: t.status, bytes: t.bytes, size: t.size, errorCode: t.errorCode, error: t.error ? redactText(t.error) : undefined }; }
      } catch { /* Transfer may have expired. */ }
    }
    return { request, events, job, transfer, collection: this.collection() };
  }

  cleanup(now = Date.now()) {
    this.safe(() => this.store.db.prepare('DELETE FROM request_logs WHERE ended_at IS NOT NULL AND ended_at < ?').run(new Date(now - 30 * 86400_000).toISOString()));
  }
}
