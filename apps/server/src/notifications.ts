import { createHmac, randomUUID } from 'node:crypto';
import type { AgentHub } from './hub.js';
import type { Approvals } from './approvals.js';
import { AppError, type Store } from './store.js';
import { redactText } from './request-logs.js';

// Webhook notifications for things that need the administrator: approval
// requests, servers going offline or reporting faults, high usage and failed
// jobs. Delivery is best effort with a few retries; nothing is queued across
// central restarts.

export const EVENTS = ['approval', 'offline', 'fault', 'usage', 'job_failed'] as const;
export type NotificationEvent = typeof EVENTS[number];
export const KINDS = ['generic', 'slack', 'discord', 'telegram'] as const;
export type WebhookKind = typeof KINDS[number];

export interface Notification { event: NotificationEvent | 'recovered' | 'test'; title: string; text: string; url?: string; serverId?: string; serverName?: string; data?: Record<string, unknown> }
interface WebhookRow {
  id: string; name: string; kind: WebhookKind; url: string; chat_id: string | null; secret: string | null; events: string; enabled: number;
  created_at: string; last_at: string | null; last_status: string | null; last_error: string | null;
}
export interface WebhookInput { name: string; kind: WebhookKind; url?: string; botToken?: string; chatId?: string; secret?: string | null; events: NotificationEvent[]; enabled: boolean }

/** Notification texts by the administrator's language setting. */
const TEXTS = {
  en: {
    testTitle: 'Hostherd notification test', testText: (name: string) => `Notification "${name}" is connected.`,
    approval: 'Approval pending', rules: 'Rules', fault: 'Fault reported', recovered: 'Reconnected', recoveredText: 'The server reconnected.',
    offline: 'Disconnected', offlineText: (minutes: number, lastSeen: string | null) => `Not connected for more than ${minutes} minutes. Last connected ${lastSeen ?? 'never'}`,
    usage: 'High usage', memory: 'Memory', disk: 'Disk', jobFailed: 'Job failed', exitCode: (code?: number) => `Exit code ${code ?? 'unknown'}`,
  },
  ko: {
    testTitle: 'Hostherd 알림 테스트', testText: (name: string) => `${name} 알림이 연결되었습니다.`,
    approval: '승인 대기', rules: '규칙', fault: '장애 보고', recovered: '다시 연결됨', recoveredText: '서버가 다시 연결되었습니다.',
    offline: '연결 끊김', offlineText: (minutes: number, lastSeen: string | null) => `${minutes}분 넘게 연결되지 않았습니다. 마지막 연결 ${lastSeen ?? '없음'}`,
    usage: '사용률 높음', memory: '메모리', disk: '디스크', jobFailed: '작업 실패', exitCode: (code?: number) => `종료 코드 ${code ?? '알 수 없음'}`,
  },
};

const OFFLINE_GRACE_MS = 2 * 60_000;
const STARTUP_GRACE_MS = 5 * 60_000;
const RETRY_MS = [5_000, 30_000];
const HIGH = 90; const CLEAR = 85;

/** Shown instead of the stored URL, which can carry a token. */
function target(row: WebhookRow) {
  if (row.kind === 'telegram') return `api.telegram.org · chat ${row.chat_id}`;
  try { const url = new URL(row.url); return `${url.protocol}//${url.host}${url.pathname.length > 1 ? '/…' : ''}`; } catch { return '—'; }
}
const view = (row: WebhookRow) => ({
  id: row.id, name: row.name, kind: row.kind, target: target(row), chatId: row.chat_id, hasSecret: Boolean(row.secret), events: JSON.parse(row.events) as NotificationEvent[],
  enabled: Boolean(row.enabled), createdAt: row.created_at, lastAt: row.last_at, lastStatus: row.last_status, lastError: row.last_error,
});

function httpUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('INVALID_WEBHOOK_URL', 'The webhook URL is invalid.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('WEBHOOK_URL_SCHEME', 'Only http or https URLs can be used.');
  return url.toString();
}

export class Notifier {
  private offlineTimers = new Map<string, NodeJS.Timeout>();
  private offlineNotified = new Set<string>();
  private usageNotified = new Set<string>();
  private cpuHigh = new Map<string, number>();
  private faultNotified = new Map<string, string>();
  private jobsNotified = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(readonly store: Store, readonly hub: AgentHub, readonly approvals: Approvals, readonly publicUrl: string) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, chat_id TEXT, secret TEXT, events TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_at TEXT, last_status TEXT, last_error TEXT)`);
    store.on('approval-request', this.onApproval);
    store.on('fault', this.onFault);
    store.on('job', this.onJob);
    hub.on('connection', this.onConnection);
    hub.on('metrics', this.onMetrics);
    // Agents reconnect after a central restart; only the ones that stay away are reported.
    this.later(STARTUP_GRACE_MS, () => {
      for (const server of this.hub.servers()) if (!server.online && server.lastSeen && Date.parse(server.lastSeen) > Date.now() - 7 * 86400_000) this.reportOffline(server.id);
    });
  }

  close() {
    this.closed = true;
    this.store.off('approval-request', this.onApproval); this.store.off('fault', this.onFault); this.store.off('job', this.onJob);
    this.hub.off('connection', this.onConnection); this.hub.off('metrics', this.onMetrics);
    for (const timer of [...this.timers, ...this.offlineTimers.values()]) clearTimeout(timer);
  }

  private later(ms: number, run: () => void) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) run(); }, ms);
    timer.unref(); this.timers.add(timer);
    return timer;
  }

  list() { return (this.store.db.prepare('SELECT * FROM webhooks ORDER BY created_at').all() as WebhookRow[]).map(view); }
  private row(id: string) {
    const row = this.store.db.prepare('SELECT * FROM webhooks WHERE id=?').get(id) as WebhookRow | undefined;
    if (!row) throw new AppError('WEBHOOK_NOT_FOUND', 'Notification not found.', 404);
    return row;
  }
  private destination(input: Partial<WebhookInput>, kind: WebhookKind, current?: WebhookRow) {
    if (kind === 'telegram') {
      const token = input.botToken?.trim();
      const chatId = input.chatId?.trim() || current?.chat_id;
      if (!chatId || !/^-?\d+$|^@\w+$/.test(chatId)) throw new AppError('INVALID_CHAT', 'Enter a Telegram chat ID: a numeric ID or an @channel name.');
      if (token && !/^\d+:[\w-]+$/.test(token)) throw new AppError('TELEGRAM_TOKEN_INVALID', 'The Telegram bot token format is invalid.');
      const url = token ? `https://api.telegram.org/bot${token}/sendMessage` : current?.kind === 'telegram' ? current.url : undefined;
      if (!url) throw new AppError('TELEGRAM_TOKEN_REQUIRED', 'Enter a Telegram bot token.');
      return { url, chatId };
    }
    const url = input.url?.trim() ? httpUrl(input.url.trim()) : current && current.kind !== 'telegram' ? current.url : undefined;
    if (!url) throw new AppError('WEBHOOK_URL_REQUIRED', 'Enter a webhook URL.');
    return { url, chatId: null };
  }
  create(input: WebhookInput) {
    const { url, chatId } = this.destination(input, input.kind);
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO webhooks (id,name,kind,url,chat_id,secret,events,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.name.trim(), input.kind, url, chatId, input.kind === 'generic' ? input.secret || null : null, JSON.stringify(input.events), input.enabled ? 1 : 0, new Date().toISOString());
    return view(this.row(id));
  }
  update(id: string, input: Partial<WebhookInput>) {
    const current = this.row(id);
    const kind = input.kind ?? current.kind;
    const { url, chatId } = this.destination(input, kind, current);
    const secret = kind !== 'generic' ? null : input.secret === undefined ? current.secret : input.secret || null;
    this.store.db.prepare('UPDATE webhooks SET name=?,kind=?,url=?,chat_id=?,secret=?,events=?,enabled=? WHERE id=?')
      .run(input.name?.trim() ?? current.name, kind, url, chatId, secret, input.events ? JSON.stringify(input.events) : current.events, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, id);
    return view(this.row(id));
  }
  remove(id: string) { this.row(id); this.store.db.prepare('DELETE FROM webhooks WHERE id=?').run(id); }
  async test(id: string) {
    const row = this.row(id);
    const result = await this.deliver(row, { event: 'test', title: this.text.testTitle, text: this.text.testText(row.name), url: this.publicUrl });
    return { ...view(this.row(id)), ok: result.ok, error: result.error };
  }

  private format(row: WebhookRow, note: Notification) {
    const text = [note.title, note.text, note.url].filter(Boolean).join('\n');
    switch (row.kind) {
      case 'slack': return { text };
      case 'discord': return { content: text.slice(0, 2000) };
      case 'telegram': return { chat_id: row.chat_id, text: text.slice(0, 4000), disable_web_page_preview: true };
      default: return { event: note.event, title: note.title, text: note.text, url: note.url, serverId: note.serverId, serverName: note.serverName, data: note.data, at: new Date().toISOString() };
    }
  }

  private async deliver(row: WebhookRow, note: Notification): Promise<{ ok: boolean; error?: string }> {
    const body = JSON.stringify(this.format(row, note));
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Hostherd-Webhook' };
    if (row.kind === 'generic') {
      headers['X-Hostherd-Event'] = note.event;
      if (row.secret) headers['X-Hostherd-Signature'] = 'sha256=' + createHmac('sha256', row.secret).update(body).digest('hex');
    }
    let error: string | undefined;
    try {
      const response = await fetch(row.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (cause) {
      // Error messages can include the URL, and with it a bot token.
      error = redactText((cause instanceof Error ? cause.message : 'Delivery failed').replaceAll(row.url, '[webhook]'));
    }
    this.store.db.prepare('UPDATE webhooks SET last_at=?,last_status=?,last_error=? WHERE id=?').run(new Date().toISOString(), error ? 'error' : 'ok', error ?? null, row.id);
    return { ok: !error, error };
  }

  private async send(row: WebhookRow, note: Notification, attempt = 0) {
    const result = await this.deliver(row, note);
    if (!result.ok && attempt < RETRY_MS.length) this.later(RETRY_MS[attempt], () => void this.send(row, note, attempt + 1));
  }

  /** Sends to every enabled webhook subscribed to the event (recoveries follow `offline`). */
  notify(note: Notification) {
    const event = note.event === 'recovered' ? 'offline' : note.event;
    for (const row of this.store.db.prepare('SELECT * FROM webhooks WHERE enabled=1').all() as WebhookRow[]) {
      if ((JSON.parse(row.events) as string[]).includes(event)) void this.send(row, note).catch(() => {});
    }
  }

  /** Texts in the language set when the notification is sent. */
  private get text() { return TEXTS[this.store.language()]; }
  private serverName(id: string) { try { return this.store.server(id).name; } catch { return id; } }
  private link(path: string) { return this.publicUrl + path; }

  private onApproval = (id: string) => {
    try {
      const request = this.approvals.get(id);
      const name = request.serverName ?? request.serverId;
      this.notify({ event: 'approval', title: `[Hostherd] ${this.text.approval} · ${name}`, text: `${request.command}\n${this.text.rules}: ${(request.ruleNames ?? request.rules).join(', ')}`,
        url: this.link('/approvals/' + id), serverId: request.serverId, serverName: name, data: { approvalId: id, tool: request.tool, rules: request.rules } });
    } catch { /* The request may already be gone. */ }
  };

  private onFault = (serverId: string, message: string) => {
    if (this.faultNotified.get(serverId) === message) return;
    this.faultNotified.set(serverId, message);
    const name = this.serverName(serverId);
    this.notify({ event: 'fault', title: `[Hostherd] ${this.text.fault} · ${name}`, text: message.slice(0, 500), url: this.link('/servers/' + serverId), serverId, serverName: name });
  };

  private onConnection = (serverId: string) => {
    if (this.hub.online(serverId)) {
      clearTimeout(this.offlineTimers.get(serverId)); this.offlineTimers.delete(serverId);
      if (this.offlineNotified.delete(serverId)) {
        const name = this.serverName(serverId);
        this.notify({ event: 'recovered', title: `[Hostherd] ${this.text.recovered} · ${name}`, text: this.text.recoveredText, url: this.link('/servers/' + serverId), serverId, serverName: name });
      }
      return;
    }
    if (this.offlineTimers.has(serverId)) return;
    this.offlineTimers.set(serverId, this.later(OFFLINE_GRACE_MS, () => { this.offlineTimers.delete(serverId); this.reportOffline(serverId); }));
  };

  private reportOffline(serverId: string) {
    if (this.hub.online(serverId) || this.offlineNotified.has(serverId)) return;
    let server;
    try { server = this.store.server(serverId); } catch { return; }
    this.offlineNotified.add(serverId);
    this.notify({ event: 'offline', title: `[Hostherd] ${this.text.offline} · ${server.name}`, text: this.text.offlineText(Math.round(OFFLINE_GRACE_MS / 60_000), server.lastSeen),
      url: this.link('/servers/' + serverId), serverId, serverName: server.name });
  }

  private onMetrics = (serverId: string) => {
    const metrics = this.hub.servers().find(server => server.id === serverId)?.metrics;
    if (!metrics) return;
    // A single CPU sample spikes easily; three in a row (about 90 seconds) count.
    const cpuRun = metrics.cpu !== null && metrics.cpu >= HIGH ? (this.cpuHigh.get(serverId) ?? 0) + 1 : 0;
    this.cpuHigh.set(serverId, cpuRun);
    const text = this.text;
    const values: [string, string, number | null, boolean][] = [
      ['cpu', 'CPU', metrics.cpu, cpuRun >= 3], ['mem', text.memory, metrics.memPct, (metrics.memPct ?? 0) >= HIGH], ['disk', text.disk, metrics.diskPct, (metrics.diskPct ?? 0) >= HIGH],
    ];
    for (const [key, label, value, high] of values) {
      const id = serverId + ':' + key;
      if (value !== null && value < CLEAR) this.usageNotified.delete(id);
      if (!high || this.usageNotified.has(id)) continue;
      this.usageNotified.add(id);
      const name = this.serverName(serverId);
      this.notify({ event: 'usage', title: `[Hostherd] ${text.usage} · ${name}`, text: `${label} ${Math.round(value!)}%`, url: this.link(`/servers/${serverId}?tab=resources`), serverId, serverName: name, data: { metric: key, value } });
    }
  };

  private onJob = (id: string, serverId: string) => {
    if (this.jobsNotified.has(id)) return;
    let job;
    try { job = this.store.job(id); } catch { return; }
    // Finished states are re-sent on reconnect; only fresh failures are news.
    if (job.kind !== 'job' || job.status !== 'failed' || !job.endedAt || Date.parse(job.endedAt) < Date.now() - 10 * 60_000) return;
    this.jobsNotified.add(id);
    if (this.jobsNotified.size > 1000) this.jobsNotified.delete(this.jobsNotified.values().next().value!);
    const name = job.serverName ?? this.serverName(serverId);
    this.notify({ event: 'job_failed', title: `[Hostherd] ${this.text.jobFailed} · ${name}`, text: `${redactText(job.cmd).slice(0, 300)}\n${job.error ?? this.text.exitCode(job.exitCode)}`,
      url: this.link('/jobs/' + id), serverId, serverName: name, data: { jobId: id, exitCode: job.exitCode } });
  };
}
