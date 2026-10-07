import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';
import type { Express } from 'express';
import { AgentHub, OFFLINE_MESSAGE } from './hub.js';
import { AppError } from './store.js';
import { attachmentUrl, openAttachment } from './file-source.js';

const chunkBytes = 512 * 1024;
const downloadLifetime = 60 * 60_000;
export interface ChatFile { download_url: string; file_id: string; mime_type?: string; file_name?: string }
export interface Transfer {
  transferId: string; serverId: string; direction: 'upload' | 'download'; path: string; filename: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'expired';
  phase: string; bytes: number; size?: number; sha256?: string; generation?: string;
  createdAt: string; updatedAt: string; expiresAt?: string; errorCode?: string; error?: string;
}
interface RemoteTransfer { id: string; generation: string; direction: string; status: string; bytes: number; size: number; sha256?: string }
interface TransferRow { state: string; payload_hash: string }
interface TransferInput { serverId: string; path: string; requestId?: string; waitMs: number }

async function* chunks(stream: Readable) {
  let pending = Buffer.allocUnsafe(chunkBytes), used = 0;
  for await (const value of stream) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (let offset = 0; offset < data.length;) {
      const n = Math.min(chunkBytes - used, data.length - offset);
      data.copy(pending, used, offset, offset + n); used += n; offset += n;
      if (used === chunkBytes) { yield pending; pending = Buffer.allocUnsafe(chunkBytes); used = 0; }
    }
  }
  if (used) yield pending.subarray(0, used);
}

export class FileTransfers {
  readonly directory: string;
  private key: Buffer;
  private running = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private cleanupTimer: NodeJS.Timeout;
  private closed = false;

  constructor(private hub: AgentHub, private publicUrl: string) {
    this.directory = path.join(hub.store.dataDir, 'file-transfers');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = path.join(this.directory, 'download.key');
    try { this.key = readFileSync(keyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32); writeFileSync(keyPath, this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw new Error('Invalid file download signing key');
    hub.store.db.exec(`CREATE TABLE IF NOT EXISTS file_transfers (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id),
      request_id TEXT UNIQUE, payload_hash TEXT NOT NULL, state TEXT NOT NULL
    )`);
    for (const state of this.all()) {
      if (state.status === 'running') {
        state.status = 'unknown'; state.errorCode = 'TRANSFER_INTERRUPTED';
        state.error = 'Central restarted during transfer. Query file_transfer_status before retrying; an upload commit may already have completed.';
        this.save(state);
      }
      if (state.status !== 'completed') rmSync(this.partial(state.transferId), { force: true });
    }
    this.cleanupTimer = setInterval(() => { void this.prune().catch(() => {}); }, 60_000);
    this.cleanupTimer.unref();
  }

  private partial(id: string) { return path.join(this.directory, id + '.part'); }
  private snapshot(id: string) { return path.join(this.directory, id + '.bin'); }
  private all() { return (this.hub.store.db.prepare('SELECT state FROM file_transfers').all() as { state: string }[]).map(row => JSON.parse(row.state) as Transfer); }
  private save(state: Transfer) {
    state.updatedAt = new Date().toISOString();
    this.hub.store.db.prepare('UPDATE file_transfers SET state=? WHERE id=?').run(JSON.stringify(state), state.transferId);
  }
  private get(id: string) {
    const row = this.hub.store.db.prepare('SELECT state FROM file_transfers WHERE id=?').get(id) as { state: string } | undefined;
    if (!row) throw new AppError('TRANSFER_NOT_FOUND', 'Transfer ID was not found or its history expired. Start a new transfer.', 404);
    const state = JSON.parse(row.state) as Transfer;
    this.hub.store.server(state.serverId);
    return state;
  }
  private token(state: Transfer) { return createHmac('sha256', this.key).update(state.transferId + ':' + state.expiresAt).digest('base64url'); }
  private result(state: Transfer) {
    return { ...state, ...(state.direction === 'download' && state.status === 'completed' && Date.parse(state.expiresAt!) > Date.now()
      ? { downloadUrl: `${this.publicUrl}/files/download/${state.transferId}/${this.token(state)}`, mimeType: 'application/octet-stream' } : {}) };
  }
  private async remote<T = RemoteTransfer>(state: Transfer, method: string, params: Record<string, unknown> = {}) {
    return await this.hub.rpc<T>(state.serverId, 'file.transfer.' + method, { id: state.transferId, ...(method === 'open' ? {} : { generation: state.generation }), ...params });
  }
  private async release(state: Transfer) {
    if (!state.generation || !this.hub.online(state.serverId)) return;
    try { await this.remote(state, 'abort'); } catch { /* Idle remote descriptors expire after 15 minutes. */ }
  }

  /** Whether a transfer was already started with this requestId. */
  known(requestId?: string) {
    return Boolean(requestId && this.hub.store.db.prepare('SELECT 1 FROM file_transfers WHERE request_id=?').get(requestId));
  }
  async upload(input: TransferInput & { file: ChatFile; overwrite: boolean }) {
    attachmentUrl(input.file.download_url, this.publicUrl);
    return this.start('upload', input, { fileId: input.file.file_id, sourceHash: createHash('sha256').update(input.file.download_url).digest('hex'), overwrite: input.overwrite },
      (state, signal) => this.receiveUpload(state, input.file, input.overwrite, signal));
  }
  async download(input: TransferInput) {
    return this.start('download', input, {}, (state, signal) => this.prepareDownload(state, signal));
  }
  private async start(direction: Transfer['direction'], input: TransferInput, identity: object, run: (state: Transfer, signal: AbortSignal) => Promise<void>) {
    if (this.closed) throw new AppError('TRANSFER_UNAVAILABLE', 'Central is restarting. Retry when it is available.', 503);
    const server = this.hub.store.server(input.serverId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ direction, serverId: input.serverId, path: input.path, ...identity })).digest('hex');
    if (input.requestId) {
      const row = this.hub.store.db.prepare('SELECT state,payload_hash FROM file_transfers WHERE request_id=?').get(input.requestId) as TransferRow | undefined;
      if (row) {
        if (row.payload_hash !== fingerprint) throw new AppError('REQUEST_CONFLICT', 'requestId was already used with different arguments. Use a new requestId for a different file or destination.');
        return this.status((JSON.parse(row.state) as Transfer).transferId);
      }
    }
    if (!this.hub.online(input.serverId)) throw new AppError('SERVER_OFFLINE', OFFLINE_MESSAGE, 503);
    const now = new Date().toISOString();
    const state: Transfer = { transferId: randomUUID(), serverId: input.serverId, direction, path: input.path,
      filename: (server.os === 'windows' ? path.win32 : path.posix).basename(input.path), status: 'running', phase: 'preparing', bytes: 0, createdAt: now, updatedAt: now };
    this.hub.store.db.prepare('INSERT INTO file_transfers(id,server_id,request_id,payload_hash,state) VALUES(?,?,?,?,?)')
      .run(state.transferId, state.serverId, input.requestId ?? null, fingerprint, JSON.stringify(state));
    const controller = new AbortController();
    const task = (async () => {
      try { await run(state, controller.signal); }
      catch (error) {
        const uncertain = state.direction === 'upload' && state.phase === 'committing' && error instanceof AppError && error.code === 'EXECUTION_UNKNOWN';
        state.status = uncertain ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed';
        state.errorCode = uncertain ? 'TRANSFER_COMMIT_UNKNOWN' : controller.signal.aborted ? 'TRANSFER_CANCELLED' : error instanceof AppError ? error.code : 'TRANSFER_FAILED';
        state.error = uncertain ? 'Upload commit response was lost. Query file_transfer_status before retrying; the destination may already contain the complete file.'
          : controller.signal.aborted ? 'Transfer was cancelled. No incomplete file is published.'
          : error instanceof AppError ? error.message : 'File transfer failed. The attachment may be incomplete or the storage unavailable. Start a new transfer after checking the source and destination.';
        this.save(state);
      } finally {
        if (state.status !== 'unknown') await this.release(state);
        await rm(this.partial(state.transferId), { force: true }).catch(() => {});
      }
    })().catch(error => {
      console.error('File transfer state could not be saved:', error instanceof Error ? error.message : 'Storage failure');
    }).finally(() => this.running.delete(state.transferId));
    this.running.set(state.transferId, { controller, task });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([task, new Promise<void>(resolve => { timer = setTimeout(resolve, input.waitMs); })]);
    if (timer) clearTimeout(timer);
    return this.result(this.get(state.transferId));
  }

  private async receiveUpload(state: Transfer, file: ChatFile, overwrite: boolean, signal: AbortSignal) {
    const opened = await this.remote(state, 'open', { direction: 'upload', path: state.path, overwrite });
    state.generation = opened.generation; state.phase = 'receiving'; this.save(state);
    signal.throwIfAborted();
    const source = await openAttachment(file.download_url, signal, this.publicUrl);
    const expected = source.headers['content-length'] === undefined ? undefined : Number(source.headers['content-length']);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
      source.destroy(); throw new AppError('ATTACHMENT_DOWNLOAD_FAILED', 'Attachment returned an invalid byte length.');
    }
    state.size = expected; this.save(state);
    const digest = createHash('sha256');
    try {
      for await (const data of chunks(source)) {
        signal.throwIfAborted();
        const accepted = await this.remote(state, 'write', { offset: state.bytes, data: data.toString('base64') });
        if (accepted.bytes !== state.bytes + data.length) throw new AppError('TRANSFER_OFFSET', 'Target reported an unexpected byte offset. The destination was not published.');
        digest.update(data); state.bytes = accepted.bytes; this.save(state);
      }
    } finally { source.destroy(); }
    if (expected !== undefined && expected !== state.bytes) throw new AppError('CHECKSUM_MISMATCH', 'Attachment length differs from the received bytes. The destination was not published.');
    signal.throwIfAborted();
    state.phase = 'committing'; state.size = state.bytes; state.sha256 = digest.digest('hex'); this.save(state);
    const committed = await this.remote(state, 'commit', { size: state.size, sha256: state.sha256 });
    if (committed.status !== 'completed' || committed.sha256 !== state.sha256 || committed.size !== state.size) throw new AppError('CHECKSUM_MISMATCH', 'Target did not confirm the complete file checksum. Inspect transfer status before retrying.');
    state.status = 'completed'; state.phase = 'completed'; this.save(state);
  }

  private async prepareDownload(state: Transfer, signal: AbortSignal) {
    const opened = await this.remote(state, 'open', { direction: 'download', path: state.path });
    state.generation = opened.generation; state.phase = 'receiving'; state.size = opened.size; this.save(state);
    if (!Number.isSafeInteger(state.size) || state.size < 0) throw new AppError('INVALID_FILE_SIZE', 'Target returned an invalid file size.');
    signal.throwIfAborted();
    const destination = await open(this.partial(state.transferId), 'wx', 0o600);
    const digest = createHash('sha256');
    try {
      // Read an empty file once as well, to validate its descriptor and state.
      do {
        signal.throwIfAborted();
        const part = await this.remote<{ data: string; nextOffset: number; eof: boolean }>(state, 'read', { offset: state.bytes });
        const data = Buffer.from(part.data, 'base64');
        if (data.length > chunkBytes || part.nextOffset !== state.bytes + data.length || part.nextOffset > state.size || part.eof !== (part.nextOffset === state.size) || (!data.length && !part.eof)) {
          throw new AppError('TRANSFER_OFFSET', 'Target returned an incomplete or inconsistent file chunk.');
        }
        let written = 0;
        while (written < data.length) {
          const result = await destination.write(data, written, data.length - written);
          if (!result.bytesWritten) throw new AppError('FILE_IO_ERROR', 'Snapshot storage stopped accepting bytes.');
          written += result.bytesWritten;
        }
        digest.update(data); state.bytes = part.nextOffset; this.save(state);
      } while (state.bytes < state.size);
      await destination.sync();
    } finally { await destination.close(); }
    signal.throwIfAborted();
    await rename(this.partial(state.transferId), this.snapshot(state.transferId));
    state.sha256 = digest.digest('hex'); state.status = 'completed'; state.phase = 'completed';
    state.expiresAt = new Date(Date.now() + downloadLifetime).toISOString(); this.save(state);
  }

  async status(id: string) {
    const state = this.get(id);
    if (state.status === 'unknown' && this.hub.online(state.serverId)) {
      try {
        if (state.generation) {
          const remote = await this.remote(state, 'status');
          if (state.direction === 'upload' && remote.status === 'completed') {
            state.status = 'completed'; state.phase = 'completed'; state.bytes = remote.bytes; state.size = remote.size; state.sha256 = remote.sha256;
            delete state.error; delete state.errorCode; this.save(state);
          } else {
            await this.release(state);
            state.status = 'failed'; state.errorCode = 'TRANSFER_INTERRUPTED'; state.error = 'Transfer was interrupted before completion. Start a new transfer with a fresh attachment URL or download request.'; this.save(state);
          }
        } else if (state.phase !== 'committing') {
          state.status = 'failed'; state.errorCode = 'TRANSFER_INTERRUPTED'; state.error = 'Transfer was interrupted before any file could be published. Start a new transfer.'; this.save(state);
        }
      } catch { /* Preserve unknown when completion cannot be established. */ }
    }
    if (state.status === 'completed' && state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
      state.status = 'expired'; this.save(state); await rm(this.snapshot(id), { force: true });
    }
    return this.result(state);
  }

  async cancel(id: string) {
    let state = this.get(id);
    const active = this.running.get(id);
    if (active) { active.controller.abort(); await active.task; state = this.get(id); }
    if (state.direction === 'upload' && state.status === 'completed') return this.result(state);
    if (state.status === 'unknown') return this.status(id);
    await this.release(state);
    await rm(this.snapshot(id), { force: true }); await rm(this.partial(id), { force: true });
    state.status = 'cancelled'; state.errorCode = 'TRANSFER_CANCELLED'; state.error = 'Transfer cancelled or download link revoked.'; this.save(state);
    return this.result(state);
  }

  mount(app: Express) {
    const invalid = { code: 'DOWNLOAD_LINK_INVALID', error: 'Download link is invalid or expired. Request a new file_download through Hostherd.' };
    app.get('/files/download/:id/:token', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      const id = String(req.params.id), token = String(req.params.token);
      if (!/^[a-f0-9-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token)) { res.status(404).json(invalid); return; }
      let state: Transfer;
      try { state = this.get(id); } catch { res.status(404).json(invalid); return; }
      const valid = timingSafeEqual(Buffer.from(token), Buffer.from(this.token(state)));
      if (!valid || state.direction !== 'download' || state.status !== 'completed' || !state.expiresAt || Date.parse(state.expiresAt) <= Date.now()) {
        res.status(404).json(invalid); return;
      }
      res.download(this.snapshot(id), state.filename, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }, error => {
        if (error && !res.headersSent) res.status(404).json({ code: 'DOWNLOAD_UNAVAILABLE', error: 'Download file is unavailable. Request a new file_download through Hostherd.' });
      });
    });
  }

  private async prune() {
    for (const state of this.all()) {
      if (this.running.has(state.transferId)) continue;
      if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
        await rm(this.snapshot(state.transferId), { force: true });
        if (state.status === 'completed') { state.status = 'expired'; this.save(state); }
      }
      if (Date.now() - Date.parse(state.updatedAt) > 24 * 60 * 60_000) {
        await rm(this.snapshot(state.transferId), { force: true }); await rm(this.partial(state.transferId), { force: true });
        this.hub.store.db.prepare('DELETE FROM file_transfers WHERE id=?').run(state.transferId);
      }
    }
  }

  async close() {
    this.closed = true; clearInterval(this.cleanupTimer);
    const running = [...this.running.values()];
    for (const item of running) item.controller.abort();
    await Promise.allSettled(running.map(item => item.task));
  }
}
