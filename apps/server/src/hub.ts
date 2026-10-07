import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { AppError, Store, type Job } from './store.js';
import type { RequestLogs } from './request-logs.js';
import { metricsSample, type MetricsStore } from './metrics.js';

interface Connection { socket: WebSocket; ready: boolean; alive: boolean; capabilities: string[] }
/** One message for SERVER_OFFLINE wherever it is raised. */
export const OFFLINE_MESSAGE = 'The server is offline. Wait for it to reconnect, then retry.';
export interface UninstallResult { status: 'accepted' | 'failed'; code?: string; error?: string }
interface Pending { serverId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export class AgentHub extends EventEmitter {
  readonly connections = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout;
  private closing = false;
  constructor(readonly store: Store, readonly requestLogs?: RequestLogs, readonly publicUrl = '', readonly metrics?: MetricsStore) {
    super();
    this.heartbeat = setInterval(() => {
      for (const [id, c] of this.connections) {
        if (!c.alive) { c.socket.terminate(); continue; }
        c.alive = false;
        c.socket.ping();
        if (c.ready) this.store.seen(id);
      }
    }, 15_000);
    this.heartbeat.unref();
  }
  online(id: string) { const c = this.connections.get(id); return !!c?.ready && c.socket.readyState === WebSocket.OPEN; }
  servers() {
    const metrics = this.metrics?.summaries();
    return this.store.servers().map(s => ({ ...s, online: this.online(s.id), metrics: metrics?.get(s.id) ?? null }));
  }
  attach(serverId: string, socket: WebSocket) {
    this.connections.get(serverId)?.socket.close(4001, 'Replaced by a new connection');
    const connection: Connection = { socket, ready: false, alive: true, capabilities: [] };
    this.connections.set(serverId, connection);
    socket.on('pong', () => { connection.alive = true; });
    let sequence = Promise.resolve();
    // Agents resend every job state on reconnect, each runtime error followed
    // by a fault. A finished job's unchanged error was already reported once.
    const repeatedFaults = new Set<string>();
    socket.on('message', raw => {
      sequence = sequence.then(async () => {
        if (this.connections.get(serverId) !== connection || socket.readyState !== WebSocket.OPEN) return;
        const message = JSON.parse(raw.toString());
        switch (message.type) {
          case 'hello': {
            if (message.protocol !== 1) throw new AppError('PROTOCOL', 'Unsupported agent protocol');
            const server = this.store.server(serverId);
            if (message.user && message.user !== server.executionUser) throw new AppError('USER_MISMATCH', 'Execution account differs from enrollment');
            this.store.seen(serverId, message);
            connection.ready = true;
            // Agents announce optional features; a missing list means none.
            connection.capabilities = Array.isArray(message.capabilities) ? message.capabilities.filter((c: unknown): c is string => typeof c === 'string') : [];
            const metrics = this.metrics && connection.capabilities.includes('metrics');
            socket.send(JSON.stringify({ type: 'welcome', cursors: this.store.cursors(serverId), publicUrl: this.publicUrl, ...(metrics ? { metrics: { intervalMs: this.metrics!.intervalMs } } : {}) }));
            this.metrics?.event(serverId, 'online');
            this.emit('connection', serverId);
            break;
          }
          case 'response': {
            const pending = this.pending.get(message.id);
            if (!pending || pending.serverId !== serverId) return;
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) pending.reject(new AppError(message.error.code ?? 'REMOTE_ERROR', message.error.message ?? 'Remote operation failed', 502));
            else pending.resolve(message.result);
            break;
          }
          case 'state': {
            if (!connection.ready) throw new Error('Agent must send hello first');
            const job = message.job;
            if (!job || !['job', 'terminal'].includes(job.kind) || !['running', 'completed', 'failed', 'interrupted'].includes(job.status)) throw new Error('Invalid job state');
            const previous = this.store.storedJob(serverId, job.id);
            if (job.error && job.status !== 'running' && previous?.status === job.status && previous?.error === job.error) repeatedFaults.add(`${job.id}: ${job.error}`);
            this.store.saveJob(serverId, job);
            this.emit('state', job.id);
            break;
          }
          case 'output': {
            if (!connection.ready || typeof message.data !== 'string' || message.data.length > 100_000) throw new Error('Invalid output chunk');
            const offset = await this.store.appendOutput(serverId, message.jobId, message.offset, Buffer.from(message.data, 'base64'));
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', jobId: message.jobId, offset }));
            this.emit('output', message.jobId);
            break;
          }
          case 'fault': {
            const text = String(message.message);
            if (!repeatedFaults.delete(text)) this.store.fault(serverId, text.slice(0, 2000));
            break;
          }
          case 'metrics': {
            if (!connection.ready || !this.metrics) return;
            const sample = metricsSample.safeParse(message.sample);
            // A malformed sample is dropped; it must not cost the job connection.
            if (sample.success) { this.metrics.record(serverId, sample.data); this.emit('metrics', serverId); }
            break;
          }
          // Unknown message types are ignored.
          default: break;
        }
      }).catch(error => {
        this.store.fault(serverId, error instanceof Error ? error.message : 'Agent communication failed');
        socket.close(1011, 'Agent protocol or storage error');
      });
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.connections.get(serverId) !== connection) return;
      this.connections.delete(serverId);
      // A central shutdown is not the server going offline.
      if (connection.ready && !this.closing) this.metrics?.event(serverId, 'offline');
      for (const [id, p] of this.pending) {
        if (p.serverId === serverId) {
          clearTimeout(p.timer); this.pending.delete(id);
          p.reject(new AppError('EXECUTION_UNKNOWN', 'No confirmed response from the server; the request may or may not have run. Check the job status with the same job ID before retrying.', 503));
        }
      }
      this.emit('connection', serverId);
    });
  }
  async rpc<T = unknown>(serverId: string, method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = randomUUID();
    const traceResult = this.requestLogs?.rpc(serverId, method, id, params);
    try {
      this.store.server(serverId);
      if (!this.online(serverId)) throw new AppError('SERVER_OFFLINE', OFFLINE_MESSAGE, 503);
      const result = await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AppError('EXECUTION_UNKNOWN', 'No confirmed response from the server; the request may or may not have run. Check the job status with the same job ID before retrying.', 504));
        }, timeoutMs);
        this.pending.set(id, { serverId, resolve: value => resolve(value as T), reject, timer });
        this.connections.get(serverId)!.socket.send(JSON.stringify({ type: 'request', id, method, params }), error => {
          if (error && this.pending.has(id)) {
            clearTimeout(timer); this.pending.delete(id);
            reject(new AppError('EXECUTION_UNKNOWN', 'No confirmed response from the server; the request may or may not have run. Check the job status with the same job ID before retrying.', 503));
          }
        });
      });
      traceResult?.(result);
      return result;
    } catch (error) { traceResult?.(undefined, error); throw error; }
  }
  /** The agent removes itself on request while it is connected. */
  canUninstall(id: string) { return this.online(id); }
  /**
   * Deletes the registration. With `uninstall`, the agent is asked to remove
   * itself first, while its token is still valid; the registration is deleted
   * whatever the outcome, and a failure is reported for manual removal.
   */
  async deleteServer(id: string, uninstall = false): Promise<UninstallResult | undefined> {
    this.store.server(id);
    let result: UninstallResult | undefined;
    if (uninstall) {
      try {
        if (!this.canUninstall(id)) throw new AppError('SERVER_OFFLINE', OFFLINE_MESSAGE, 409);
        await this.rpc(id, 'agent.uninstall', {}, 15_000);
        result = { status: 'accepted' };
      } catch (error) {
        result = { status: 'failed', code: error instanceof AppError ? error.code : 'UNINSTALL_FAILED', error: error instanceof Error ? error.message : 'Could not request agent removal.' };
      }
    }
    this.removeServer(id);
    return result;
  }
  removeServer(id: string) {
    this.store.deleteServer(id);
    this.metrics?.forget(id);
    this.connections.get(id)?.socket.close(4003, 'Server registration revoked');
  }
  async start(serverId: string, kind: 'job' | 'terminal', params: Record<string, unknown>, requestId?: string): Promise<Job> {
    const payload = { serverId, kind, ...params };
    if (requestId) {
      const existing = this.store.request(requestId, payload);
      if (existing) {
        this.requestLogs?.job(existing);
        this.requestLogs?.event('job', 'info', { jobId: existing, deduplicated: true });
        return this.store.job(existing);
      }
    }
    this.store.server(serverId);
    if (!this.online(serverId)) throw new AppError('SERVER_OFFLINE', OFFLINE_MESSAGE, 503);
    const id = randomUUID();
    this.store.db.transaction(() => {
      this.store.saveJob(serverId, { id, kind, path: String(params.path), cmd: String(params.cmd ?? ''), status: 'pending', startedAt: new Date().toISOString() });
      if (requestId) this.store.rememberRequest(requestId, payload, id);
    })();
    this.requestLogs?.job(id);
    this.requestLogs?.event('job', 'start', { jobId: id });
    try {
      const state = await this.rpc<Job>(serverId, kind === 'job' ? 'job.start' : 'terminal.create', { ...params, id }, 5000);
      this.store.saveJob(serverId, state);
    } catch (error) {
      const job = this.store.job(id);
      if (job.status === 'pending') {
        const unknown = error instanceof AppError && ['EXECUTION_UNKNOWN', 'SERVER_OFFLINE'].includes(error.code);
        this.store.saveJob(serverId, { ...job, status: unknown ? 'unknown' : 'failed', error: error instanceof Error ? error.message : 'Request failed', errorCode: error instanceof AppError ? error.code : 'START_FAILED', ...(unknown ? {} : { endedAt: new Date().toISOString() }) });
      }
    }
    return this.store.job(id);
  }
  close() {
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const c of this.connections.values()) c.socket.close(1001, 'Central restarting');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AppError('EXECUTION_UNKNOWN', 'No confirmed response from the server; the request may or may not have run. Check the job status with the same job ID before retrying.', 503)); }
    this.pending.clear();
  }
}
