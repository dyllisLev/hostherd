import type { Request, Response } from 'express';
import { AppError, type Store } from './store.js';
import { sanitize } from './request-logs.js';

/** Incident review. Independent of request-log retention. */
const RETENTION_MS = 30 * 86400_000;
const DETAIL_TEXT = 300;
/** Body fields safe to keep. Credentials, payloads and command output are not in this set. */
const SAFE_DETAIL = new Set(['name', 'uninstall', 'decision', 'always', 'enabled', 'language', 'mode', 'kind', 'label', 'matchType']);

export type AuditResult = 'ok' | 'error';
export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  result: AuditResult;
  status: number | null;
  detail: Record<string, unknown>;
}
interface AuditInput {
  actor: string;
  action: string;
  target?: string | null;
  result: AuditResult;
  status?: number | null;
  detail?: unknown;
}
interface AuditRow { id: number; at: string; actor: string; action: string; target: string | null; result: AuditResult; status: number | null; detail: string | null }

/**
 * Administrator writes and agent connect/disconnect.
 * Actor is `admin:<id>:<name>`, `agent:<serverId>`, or `system`.
 * Detail stays small. Secrets, tokens, passwords, request bodies with
 * credentials and command output are never stored.
 */
export class AuditLog {
  private failedWrites = 0;
  constructor(readonly store: Store) {}

  record(event: AuditInput) {
    this.safe(() => {
      const detail = JSON.stringify(sanitize(clip(event.detail ?? {})) ?? {});
      const status = Number.isInteger(event.status) ? event.status : null;
      this.store.db.prepare('INSERT INTO audit_events (at,actor,action,target,result,status,detail) VALUES (?,?,?,?,?,?,?)')
        .run(new Date().toISOString(), event.actor.slice(0, 200), event.action.slice(0, 200), event.target ? event.target.slice(0, 200) : null, event.result, status, detail);
    });
  }

  /** Agent socket opened after hello, or closed. `reason` is the close reason or error message. */
  connection(serverId: string, action: 'agent.connect' | 'agent.disconnect', status?: number, reason?: string) {
    const text = reason?.trim();
    // 1000 and 1001 are planned closes (normal, or going away for shutdown/update).
    // 1006, protocol errors, and heartbeat timeouts stay errors.
    const normal = action === 'agent.connect' || status === 1000 || status === 1001;
    this.record({
      actor: `agent:${serverId}`, action, target: serverId,
      result: normal ? 'ok' : 'error', status: status ?? null,
      detail: text ? { reason: text } : {},
    });
  }

  list(limit: number, cursor?: number): { items: AuditEvent[]; nextCursor?: string } {
    try {
      const rows = this.store.db.prepare(`SELECT id,at,actor,action,target,result,status,detail FROM audit_events
        ${cursor ? 'WHERE id<?' : ''} ORDER BY id DESC LIMIT ?`).all(...(cursor ? [cursor, limit + 1] : [limit + 1])) as AuditRow[];
      const page = rows.slice(0, limit).map(row => ({
        ...row,
        detail: row.detail ? JSON.parse(row.detail) as Record<string, unknown> : {},
      }));
      const nextCursor = rows.length > limit ? String(page[page.length - 1]?.id) : undefined;
      return nextCursor ? { items: page, nextCursor } : { items: page };
    } catch {
      throw new AppError('AUDIT_UNAVAILABLE', 'Audit log storage is unavailable.', 503);
    }
  }

  cleanup(now = Date.now()) {
    this.safe(() => this.store.db.prepare('DELETE FROM audit_events WHERE at < ?').run(new Date(now - RETENTION_MS).toISOString()));
  }

  private safe(fn: () => void) {
    try { fn(); }
    catch {
      this.failedWrites++;
      if (this.failedWrites === 1) console.error('Audit log storage failed; audit events may be incomplete.');
    }
  }
}

function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, DETAIL_TEXT);
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => clip(item, depth + 1)).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      const next = clip(item, depth + 1);
      if (next !== undefined) out[key.slice(0, 80)] = next;
    }
    return out;
  }
  return undefined;
}

function routePattern(req: Request): string | undefined {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern !== 'string') return undefined;
  const base = req.baseUrl ?? '';
  if (!base || pattern === base || pattern.startsWith(`${base}/`)) return pattern;
  return `${base}${pattern}`;
}

function targetOf(req: Request): string | null {
  const raw = req.params?.id ?? req.params?.serverId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === 'string' && id) return id;
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const serverId = (body as Record<string, unknown>).serverId;
    if (typeof serverId === 'string' && /^[0-9a-f-]{36}$/i.test(serverId)) return serverId;
  }
  return req.originalUrl.split('?')[0].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
}

/** Fields copied from an admin write. Anything else in the body is dropped. */
export function auditDetail(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const detail: Record<string, unknown> = {};
  const record = body as Record<string, unknown>;
  for (const key of SAFE_DETAIL) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || value === null) detail[key] = value;
  }
  return detail;
}

/** Records a non-GET admin request when the response finishes. */
export function watchAdminWrite(audit: AuditLog, actor: string, req: Request, res: Response) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  // Auth routes are already matched here. App routes match later, so the pattern is read again on finish.
  const early = routePattern(req);
  const earlyTarget = targetOf(req);
  res.on('finish', () => {
    const status = res.statusCode;
    audit.record({
      actor,
      action: `${req.method} ${early ?? routePattern(req) ?? req.originalUrl.split('?')[0]}`,
      target: targetOf(req) ?? earlyTarget,
      result: status >= 200 && status < 400 ? 'ok' : 'error',
      status,
      detail: auditDetail(req.body),
    });
  });
}
