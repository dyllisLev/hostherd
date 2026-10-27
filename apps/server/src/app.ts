import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { errors as oidcErrors } from 'oidc-provider';
import { z } from 'zod';
import { Store, AppError, LANGUAGES } from './store.js';
import { AgentHub } from './hub.js';
import { createAuth } from './auth.js';
import { mountMcp } from './mcp.js';
import { FileTransfers } from './transfers.js';
import { RequestLogs, redactText } from './request-logs.js';
import { VERSION } from './version.js';
import { ABSOLUTE_PATH, executionUser } from './validation.js';
import { MetricsStore, RANGES, type Range } from './metrics.js';
import { Approvals } from './approvals.js';
import { EVENTS, KINDS, Notifier } from './notifications.js';

export interface AppOptions { dataDir: string; publicUrl: string; releaseDir?: string; webDir?: string; metricsIntervalMs?: number; eventKeepAliveMs?: number }
const uuid = z.string().uuid();
const ABSOLUTE_PATH_MESSAGE = 'Enter an absolute path.';
const targetPath = z.string().min(1).regex(ABSOLUTE_PATH, ABSOLUTE_PATH_MESSAGE);
/** Express trust proxy from TRUST_PROXY: a hop count, true/false, or addresses/subnets (default one proxy hop). */
export function trustProxy(value = process.env.TRUST_PROXY): number | boolean | string {
  const text = value?.trim();
  if (!text) return 1;
  if (/^\d+$/.test(text)) return Number(text);
  if (text === 'true' || text === 'false') return text === 'true';
  return text;
}

export async function createApp(options: AppOptions) {
  const publicUrl = options.publicUrl.replace(/\/$/, '');
  const store = new Store(options.dataDir);
  const requestLogs = new RequestLogs(store);
  const metrics = new MetricsStore(options.dataDir, options.metricsIntervalMs);
  const hub = new AgentHub(store, requestLogs, publicUrl, metrics);
  const approvals = new Approvals(store);
  const notifier = new Notifier(store, hub, approvals, publicUrl);
  // Each web event stream and terminal socket adds a listener.
  store.setMaxListeners(0); hub.setMaxListeners(0);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());
  app.use(requestLogs.middleware());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/') || req.path.startsWith('/oauth')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const auth = await createAuth({ db: store.db, app, publicUrl, dataDir: options.dataDir });
  app.use(express.json({ limit: '4mb' }));
  app.get('/healthz', (_req, res) => {
    store.db.prepare('SELECT 1').get();
    res.json({ status: 'ok', version: VERSION, commit: process.env.APP_COMMIT ?? 'development' });
  });
  app.post('/api/agent/enroll', (req, res) => {
    const body = z.object({ code: z.string().min(10), hostname: z.string().max(255), os: z.string().max(40), arch: z.string().max(40), version: z.string().max(100), executionUser }).parse(req.body);
    res.status(201).json({ ...store.enroll(body.code, body), url: publicUrl });
  });
  const releaseDir = options.releaseDir ?? path.resolve('releases');
  // The agent version offered by /downloads, re-read when the manifest changes.
  let manifestCache: { mtimeMs: number; version?: string } | undefined;
  const agentVersion = () => {
    try {
      const file = path.join(releaseDir, 'manifest.json');
      const { mtimeMs } = statSync(file);
      if (manifestCache?.mtimeMs !== mtimeMs) {
        const payload = JSON.parse(Buffer.from(JSON.parse(readFileSync(file, 'utf8')).payload, 'base64').toString('utf8'));
        manifestCache = { mtimeMs, version: typeof payload.version === 'string' ? payload.version : undefined };
      }
      return manifestCache.version;
    } catch { return undefined; }
  };
  app.use('/downloads', express.static(releaseDir, { dotfiles: 'deny', setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
  const transfers = new FileTransfers(hub, publicUrl);
  transfers.mount(app);
  const mcp = mountMcp(app, hub, auth.authenticateMcp, publicUrl, transfers, approvals);
  app.use('/api', auth.requireAdmin);
  app.get('/api/request-logs', (req, res) => {
    const filters = z.object({
      from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
      serverId: uuid.optional(), tool: z.string().max(200).optional(),
      outcome: z.enum(['pending', 'success', 'error', 'unknown']).optional(), q: z.string().max(1000).optional(),
      cursor: z.string().regex(/^[1-9][0-9]*$/).refine(v => Number.isSafeInteger(Number(v))).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    res.json(requestLogs.list({ ...filters, from: filters.from ? new Date(filters.from).toISOString() : undefined, to: filters.to ? new Date(filters.to).toISOString() : undefined }));
  });
  app.get('/api/request-logs/:traceId', (req, res) => res.json(requestLogs.detail(uuid.parse(req.params.traceId))));
  app.get('/api/dashboard', (req, res) => {
    const { days, tzOffset } = z.object({
      days: z.coerce.number().int().min(1).max(30).default(14),
      tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
    }).parse(req.query);
    const since = new Date(Date.now() - 86400_000).toISOString();
    const counts = store.jobCounts(since);
    res.json({
      runningJobs: counts.runningJobs ?? 0, activeTerminals: counts.activeTerminals ?? 0,
      failedJobs24h: counts.failedJobs ?? 0, jobs24h: counts.recentJobs ?? 0,
      activity: store.activity(days, tzOffset),
      recentJobs: store.jobPage({ kind: 'job', limit: 8, offset: 0 }).items,
      recentFailures: store.jobPage({ kind: 'job', status: 'failed', from: since, limit: 5, offset: 0 }).items,
      // Failures the administrator has not acknowledged on the dashboard yet.
      unacknowledgedFailures24h: store.failedJobs(since, store.setting('failuresAcknowledgedAt')),
      running: store.runningByServer(),
      mcp: (() => {
        const activity = requestLogs.toolActivity(days, tzOffset);
        const labels = new Map<string, string | null>();
        const label = (id: string | null) => { if (!id) return null; if (!labels.has(id)) labels.set(id, auth.clientLabel(id)); return labels.get(id)!; };
        return { ...activity, latest: activity.latest.map(item => ({ ...item, client: label(item.clientId) })), clients: activity.clients.map(item => ({ ...item, client: label(item.clientId) })) };
      })(),
    });
  });
  app.post('/api/dashboard/failures/acknowledge', (_req, res) => {
    store.setSetting('failuresAcknowledgedAt', new Date().toISOString());
    res.json({ ok: true });
  });
  // canUninstall is web-only: the delete dialog offers agent removal with it.
  app.get('/api/servers', (_req, res) => res.json(hub.servers().map(server => ({ ...server, canUninstall: hub.canUninstall(server.id) }))));
  app.get('/api/servers/:id', (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json({ ...store.server(id), online: hub.online(id), canUninstall: hub.canUninstall(id) });
  });
  app.get('/api/servers/:id/metrics', (req, res) => {
    const id = uuid.parse(req.params.id);
    const range = z.enum(Object.keys(RANGES) as [Range, ...Range[]]).default('1h').parse(req.query.range);
    store.server(id);
    res.json({ ...metrics.series(id, range), latest: metrics.latest(id), availability: metrics.availability(id, range, hub.online(id)) });
  });
  // Subdirectories for folder pickers, read as the server's execution account.
  app.get('/api/servers/:id/directories', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const server = store.server(id);
    const windows = server.os === 'windows';
    const requested = z.string().max(4096).optional().parse(req.query.path)?.trim();
    const dir = requested && ABSOLUTE_PATH.test(requested) ? requested : windows ? 'C:\\' : '/';
    const api = windows ? path.win32 : path.posix;
    const listing = await hub.rpc<{ entries: { name: string; type: string }[] }>(id, 'file.list', { path: dir });
    const resolved = api.resolve(dir);
    const parent = api.dirname(resolved);
    res.json({
      path: resolved, parent: parent === resolved ? null : parent,
      directories: listing.entries.filter(entry => entry.type === 'directory').map(entry => ({ name: entry.name, path: api.join(resolved, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });
  app.patch('/api/servers/:id', (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const id = uuid.parse(req.params.id);
    store.renameServer(id, name);
    res.json({ ...store.server(id), online: hub.online(id) });
  });
  app.post('/api/enrollments', (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const enrollment = store.enrollment(name);
    const command = `f=$(mktemp) && curl -fsSL '${publicUrl}/downloads/install.sh' -o "$f" && sudo sh "$f" --url '${publicUrl}' --code '${enrollment.code}'; rm -f "$f"`;
    // Run in an elevated PowerShell; append -RunAsSystem to run commands as SYSTEM.
    const windowsCommand = `$f = Join-Path $env:TEMP 'hostherd-install.ps1'; Invoke-WebRequest -UseBasicParsing '${publicUrl}/downloads/install.ps1' -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f -Url '${publicUrl}' -Code '${enrollment.code}'`;
    res.status(201).json({ ...enrollment, command, windowsCommand });
  });
  app.delete('/api/servers/:id', async (req, res) => {
    const { uninstall } = z.object({ uninstall: z.boolean().default(false) }).default({ uninstall: false }).parse(req.body);
    const result = await hub.deleteServer(uuid.parse(req.params.id), uninstall);
    res.json({ ok: true, ...(result ? { uninstall: result } : {}) });
  });
  app.delete('/api/servers/:id/fault', (req, res) => {
    const id = uuid.parse(req.params.id);
    store.server(id); store.fault(id, null); res.json({ ok: true });
  });
  app.post('/api/servers/:id/update', async (req, res) => {
    res.json(await hub.rpc(uuid.parse(req.params.id), 'agent.update', { manifestUrl: `${publicUrl}/downloads/manifest.json` }));
  });
  app.get('/api/jobs', (req, res) => {
    const query = z.object({
      kind: z.enum(['job', 'terminal']).optional(), serverId: uuid.optional(),
      status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted', 'unknown']).optional(),
      q: z.string().trim().max(500).optional(), from: z.iso.datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json(store.jobPage({ ...query, q: query.q || undefined, from: query.from ? new Date(query.from).toISOString() : undefined }));
  });
  app.get('/api/jobs/:id', (req, res) => res.json(store.job(uuid.parse(req.params.id))));
  app.get('/api/jobs/:id/output', async (req, res) => {
    const cursor = z.coerce.number().int().nonnegative().default(0).parse(req.query.cursor);
    const limit = z.coerce.number().int().min(1).max(1024 * 1024).default(65536).parse(req.query.limit);
    res.json(await store.output(uuid.parse(req.params.id), cursor, limit));
  });
  app.get('/api/jobs/:id/output/download', (req, res) => {
    const job = store.job(uuid.parse(req.params.id));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hostherd-${job.kind}-${job.id}.log"`);
    res.setHeader('Content-Length', String(job.outputBytes));
    if (!job.outputBytes) { res.end(); return; }
    // Stored output is append-only; stream the acknowledged length.
    const stream = createReadStream(store.outputPath(job.id), { start: 0, end: job.outputBytes - 1 });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  app.patch('/api/jobs/:id', (req, res) => {
    const { label } = z.object({ label: z.string().trim().max(80).nullable() }).parse(req.body);
    const id = uuid.parse(req.params.id);
    store.labelJob(id, label || null);
    res.json(store.job(id));
  });
  app.post('/api/jobs/:id/input', async (req, res) => {
    const job = store.job(uuid.parse(req.params.id));
    const body = z.object({ data: z.string().default(''), eof: z.boolean().default(false) }).parse(req.body);
    res.json(await hub.rpc(job.serverId, 'job.input', { id: job.id, ...body }));
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => {
    const job = store.job(uuid.parse(req.params.id)); res.json(await hub.rpc(job.serverId, 'job.cancel', { id: job.id }));
  });
  app.post('/api/terminals', async (req, res) => {
    const { serverId, label, ...params } = z.object({ serverId: uuid, path: targetPath, label: z.string().trim().max(80).optional(), cols: z.number().int().min(2).max(1000).default(100), rows: z.number().int().min(2).max(500).default(30) }).parse(req.body);
    const job = await hub.start(serverId, 'terminal', params);
    if (label) store.labelJob(job.id, label);
    res.status(201).json(store.job(job.id));
  });
  app.post('/api/terminals/:id/close', async (req, res) => {
    const job = store.job(uuid.parse(req.params.id)); res.json(await hub.rpc(job.serverId, 'terminal.close', { id: job.id }));
  });
  app.get('/api/approvals', (req, res) => {
    const query = z.object({
      status: z.enum(['pending', 'approved', 'denied', 'blocked', 'expired']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json(approvals.list(query));
  });
  app.get('/api/approvals/:id', (req, res) => res.json(approvals.get(uuid.parse(req.params.id))));
  app.post('/api/approvals/:id/decision', (req, res) => {
    const { decision, always } = z.object({ decision: z.enum(['approve', 'deny']), always: z.boolean().default(false) }).parse(req.body);
    res.json(approvals.decide(uuid.parse(req.params.id), decision, always));
  });
  app.get('/api/approval-settings', (_req, res) => res.json({ enabled: approvals.enabled() }));
  app.put('/api/approval-settings', (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    approvals.setEnabled(enabled);
    res.json({ enabled: approvals.enabled() });
  });
  app.get('/api/command-rules', (_req, res) => res.json(approvals.rules()));
  app.post('/api/command-rules', (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), matchType: z.enum(['command', 'regex']), pattern: z.string().trim().min(1).max(300), mode: z.enum(['confirm', 'block']) }).parse(req.body);
    res.status(201).json(approvals.addCustomRule(body));
  });
  app.delete('/api/command-rules/:id', (req, res) => { approvals.removeCustomRule(z.string().max(60).parse(req.params.id)); res.json({ ok: true }); });
  app.put('/api/command-rules/:id', (req, res) => {
    const { mode } = z.object({ mode: z.enum(['confirm', 'allow', 'block']) }).parse(req.body);
    approvals.setRule(z.string().max(60).parse(req.params.id), mode);
    res.json(approvals.rules());
  });
  app.get('/api/allowed-folders', (_req, res) => res.json(approvals.folders()));
  app.post('/api/allowed-folders', (req, res) => {
    const body = z.object({ serverId: uuid.nullable().default(null), path: targetPath }).parse(req.body);
    res.status(201).json(approvals.addFolder(body.serverId, body.path));
  });
  app.delete('/api/allowed-folders/:id', (req, res) => { approvals.removeFolder(uuid.parse(req.params.id)); res.json({ ok: true }); });
  const webhookInput = z.object({
    name: z.string().trim().min(1).max(80), kind: z.enum(KINDS), url: z.string().trim().max(2048).optional(),
    botToken: z.string().trim().max(200).optional(), chatId: z.string().trim().max(100).optional(), secret: z.string().max(200).nullable().optional(),
    events: z.array(z.enum(EVENTS)).max(EVENTS.length), enabled: z.boolean().default(true),
  });
  app.get('/api/webhooks', (_req, res) => res.json(notifier.list()));
  app.post('/api/webhooks', (req, res) => res.status(201).json(notifier.create(webhookInput.parse(req.body))));
  app.patch('/api/webhooks/:id', (req, res) => res.json(notifier.update(uuid.parse(req.params.id), webhookInput.partial().parse(req.body))));
  app.delete('/api/webhooks/:id', (req, res) => { notifier.remove(uuid.parse(req.params.id)); res.json({ ok: true }); });
  app.post('/api/webhooks/:id/test', async (req, res) => res.json(await notifier.test(uuid.parse(req.params.id))));
  app.get('/api/settings', (_req, res) => res.json({ url: publicUrl, mcpUrl: `${publicUrl}/mcp`, version: VERSION, agentVersion: agentVersion() ?? null, retentionDays: 30, language: store.language() }));
  app.put('/api/settings/language', (req, res) => {
    const { language } = z.object({ language: z.enum(LANGUAGES) }).parse(req.body);
    store.setSetting('language', language);
    res.json({ language: store.language() });
  });
  // Change notifications for the web console; clients refetch the affected views.
  const eventStreams = new Set<express.Response>();
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const pending = new Set<string>(); let timer: NodeJS.Timeout | undefined;
    const notify = (type: string) => {
      pending.add(type);
      timer ??= setTimeout(() => { timer = undefined; for (const name of pending) res.write(`event: ${name}\ndata: {}\n\n`); pending.clear(); }, 250);
    };
    const servers = () => notify('servers'); const jobs = () => notify('jobs'); const samples = () => notify('metrics'); const approvalChanges = () => notify('approvals');
    store.on('servers', servers); store.on('job', jobs); hub.on('connection', servers); hub.on('metrics', samples); store.on('approvals', approvalChanges);
    const keepAlive = setInterval(() => {
      // EventSource GETs carry no Origin header; only the session decides.
      if (!auth.hasSession(req)) { res.write('event: unauthorized\ndata: {}\n\n'); res.end(); return; }
      res.write(': ping\n\n');
    }, options.eventKeepAliveMs ?? 25_000);
    eventStreams.add(res);
    res.on('close', () => {
      clearInterval(keepAlive); clearTimeout(timer); eventStreams.delete(res);
      store.off('servers', servers); store.off('job', jobs); hub.off('connection', servers); hub.off('metrics', samples); store.off('approvals', approvalChanges);
    });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ code: 'API_NOT_FOUND', error: 'API endpoint not found.' }); });
  const webDir = options.webDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    requestLogs.failure(error?.type?.startsWith('entity.') ? 'parse' : 'http', error);
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      const large = error.type === 'entity.too.large';
      res.status(large ? 413 : 400).json({ error: large ? 'Request body exceeds the size limit.' : 'Malformed JSON request body.', code: large ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON' }); return;
    }
    if (error instanceof z.ZodError) {
      // The one validation message the web shows as is gets its own code.
      if (error.issues.every(i => i.message === ABSOLUTE_PATH_MESSAGE)) { res.status(400).json({ error: ABSOLUTE_PATH_MESSAGE, code: 'ABSOLUTE_PATH_REQUIRED' }); return; }
      res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'INVALID_INPUT', params: { fields: [...new Set(error.issues.map(i => i.path.join('.')))].join(', ') } }); return;
    }
    // Interaction routes throw oidc-provider client errors (invalid_request and the rest). Those already carry a 4xx status.
    const clientError = error instanceof oidcErrors.OIDCProviderError && error.status >= 400 && error.status < 500 ? error : undefined;
    const status = error instanceof AppError ? error.status : clientError?.status ?? 500;
    if (status === 500) console.error('Request failed:', redactText(error instanceof Error ? error.message : 'unknown error'));
    if (clientError) { res.status(status).json({ error: clientError.error_description || 'The request is invalid.', code: clientError.error }); return; }
    if (!(error instanceof AppError)) { res.status(status).json({ error: error instanceof Error ? error.message : 'The request failed.', code: 'INTERNAL_ERROR' }); return; }
    res.status(status).json({ error: error.message, code: error.code, ...(error.params ? { params: error.params } : {}) });
  };
  app.use(errorHandler);
  // Node's 5s keep-alive closes idle sockets a reverse proxy still reuses (502/521); headersTimeout stays higher.
  const KEEP_ALIVE_TIMEOUT_MS = 65_000;
  const HEADERS_TIMEOUT_MS = 66_000;
  const server = createServer(app);
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  // One image RPC carries up to 8 MiB encoded as base64, plus JSON metadata.
  const agentSockets = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', publicUrl);
      if (url.pathname === '/agent') {
        const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
        const id = token ? store.authenticateAgent(token) : null;
        if (!id) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
        agentSockets.handleUpgrade(req, socket, head, ws => hub.attach(id, ws)); return;
      }
      const match = /^\/terminal\/([a-f0-9-]+)$/.exec(url.pathname);
      if (!match || !auth.authorizeUpgrade(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const job = store.job(uuid.parse(match[1]));
      if (job.kind !== 'terminal') throw new Error('Not a terminal');
      let cursor = z.coerce.number().int().nonnegative().default(0).parse(url.searchParams.get('cursor') ?? undefined);
      if (cursor > job.outputBytes) cursor = 0;
      terminalSockets.handleUpgrade(req, socket, head, ws => {
        let pumping = false;
        const send = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
        const pump = async () => {
          if (pumping || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512 * 1024) return;
          if (!auth.authorizeUpgrade(req)) { ws.close(4003, 'Session expired'); return; }
          pumping = true;
          try {
            const output = await store.output(job.id, cursor);
            if (output.nextCursor > cursor) {
              send({ type: 'output', data: output.data, offset: cursor }); cursor = output.nextCursor;
            }
          } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : 'Output unavailable' }); }
          finally { pumping = false; }
        };
        const state = (id: string) => { if (id === job.id) send({ type: 'state', job: store.job(job.id) }); };
        hub.on('state', state);
        const interval = setInterval(() => void pump(), 50);
        send({ type: 'state', job }); void pump();
        let input = Promise.resolve();
        ws.on('message', raw => {
          input = input.then(async () => {
            if (!auth.authorizeUpgrade(req)) { ws.close(4003, 'Session expired'); return; }
            const message = z.discriminatedUnion('type', [z.object({ type: z.literal('input'), data: z.string() }), z.object({ type: z.literal('resize'), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(500) })]).parse(JSON.parse(raw.toString()));
            if (message.type === 'input') await hub.rpc(job.serverId, 'terminal.input', { id: job.id, data: message.data });
            else await hub.rpc(job.serverId, 'terminal.resize', { id: job.id, cols: message.cols, rows: message.rows });
          }).catch(error => send({ type: 'error', message: error instanceof Error ? error.message : 'Terminal request failed' }));
        });
        ws.on('error', () => {});
        ws.on('close', () => { clearInterval(interval); hub.off('state', state); });
      });
    } catch { socket.destroy(); }
  });
  const cleanup = setInterval(() => {
    requestLogs.cleanup(); metrics.cleanup(); approvals.cleanup();
    void store.cleanup().catch(error => console.error('Retention cleanup failed:', error.message));
  }, 3600_000);
  cleanup.unref();
  const rollup = setInterval(() => { try { metrics.rollup(); } catch (error) { console.error('Metrics rollup failed:', error instanceof Error ? error.message : error); } }, 300_000);
  rollup.unref();
  return { app, server, store, hub, auth, transfers, requestLogs, metrics, approvals, notifier, async close() {
    clearInterval(cleanup); clearInterval(rollup); notifier.close(); await transfers.close(); hub.close();
    for (const res of eventStreams) res.end();
    for (const ws of terminalSockets.clients) ws.close(1001, 'Central restarting');
    await mcp.close(); await auth.close();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections();
      const timer = setTimeout(() => { for (const ws of [...agentSockets.clients, ...terminalSockets.clients]) ws.terminate(); server.closeAllConnections(); resolve(); }, 2000);
      timer.unref();
    });
    store.close(); metrics.close();
  } };
}
