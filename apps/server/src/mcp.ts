import { CLIENT_CAPABILITIES_META_KEY, McpServer, createMcpHandler, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { Express, Request } from 'express';
import path from 'node:path';
import { AgentHub } from './hub.js';
import { AppError, hash } from './store.js';
import { FileTransfers } from './transfers.js';
import { redactText } from './request-logs.js';
import { VERSION } from './version.js';
import { ABSOLUTE_PATH } from './validation.js';
import { classifyCommand, type Approvals, type Match } from './approvals.js';

const serverId = z.string().uuid().describe('Registered target server ID');
const absolutePath = z.string().min(1).regex(ABSOLUTE_PATH, 'Use an absolute target path: /path, or C:\\path on Windows');
const workingDirectory = absolutePath.describe('Existing, accessible working DIRECTORY on the target server where cmd runs. Examples: /, /tmp, /root; on Windows servers C:\\, C:\\Users\\name. This is not the shell or executable path: do not pass /bin/bash. The runner checks this inside the same start request; no separate validation call is needed.').meta({ examples: ['/', '/tmp'] });
const jobId = z.string().uuid().describe('Job ID returned by job_start, jobs_list or job_status. Reuse it to inspect or control that job.');
// Clients sometimes ask for longer waits; cap them instead of rejecting the call.
const waitMs = (description: string) => z.number().int().min(0).default(1000).describe(`${description} Values above 5000 wait 5000.`);
const waitLimit = (ms: number) => Math.min(ms, 5000);
const page = { offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1024 * 1024).optional() };
type Authenticator = (token: string) => Promise<{ subject: string; clientId: string; scopes: string[] } | null>;
type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** A byte chunk as model text: UTF-8 text cut at a character boundary (length = bytes used), or base64 for binary bytes. */
export function textChunk(bytes: Buffer, final: boolean): { text: string; length: number } | { data: string; encoding: 'base64'; length: number } {
  let end = bytes.length;
  if (!final) {
    // Leave a trailing partial character for the next read; a lone character larger than the page is returned as is.
    for (let i = end - 1; i >= Math.max(0, end - 4); i--) {
      const byte = bytes[i];
      if ((byte & 0xc0) === 0x80) continue;
      const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (end - i < size && i > 0) end = i;
      break;
    }
  }
  try { return { text: utf8.decode(bytes.subarray(0, end)), length: end }; }
  catch { return { data: bytes.toString('base64'), encoding: 'base64', length: bytes.length }; }
}

class ToolFailure extends Error {
  constructor(readonly result: unknown) { super('Tool execution failed'); }
}

/** Ends a tool call with an input-required result (the client asks the user, then retries). */
class InputNeeded extends Error {
  constructor(readonly result: ReturnType<typeof inputRequired>) { super('Input required'); }
}
interface RequestContext { mcpReq?: { envelope?: Record<string, unknown>; inputResponses?: Record<string, unknown> } }
interface RunContext { clientId?: string; request?: RequestContext['mcpReq'] }

class ToolContent {
  constructor(readonly content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'resource_link'; uri: string; name: string; mimeType: string; size?: number })[]) {}
}

export function mountMcp(app: Express, hub: AgentHub, authenticate: Authenticator, publicUrl: string, transfers: FileTransfers, approvals: Approvals) {
  const logs = hub.requestLogs;
  const handler = createMcpHandler(() => {
    const trace = logs?.current();
    const server = new McpServer({ name: 'Hostherd', version: VERSION }, {
      instructions: 'Hostherd transfers files and runs commands as each target server\'s registered OS account. On Windows servers (os "windows" in servers_list) cmd runs in PowerShell (pwsh when installed, otherwise Windows PowerShell 5.1) and paths look like C:\\Users\\name. Use file_upload for ChatGPT attachments sent to a server, file_download for a user download link, and file_transfer_status to track large transfers. Keep file bytes out of model text. Use image_read to see saved PNG/JPEG images. Reuse known server IDs; use servers_list when the target ID is unknown. In job_start, path is the working directory and cmd is the shell command; the login shell is selected automatically. Example arguments: {"serverId":"<ID from servers_list>","path":"/","cmd":"hostname; uptime"}. Directory validation occurs locally within that same request. Keep the same requestId when retrying identical arguments after an uncertain outcome; use a new requestId when correcting arguments. Continue running jobs with their jobId and output cursor instead of starting replacements. For visual inspection, create a PNG/JPEG screenshot or chart using job_start, wait for successful completion, then call image_read with the same serverId and absolute saved FILE path. image_read returns image content; it does not capture URLs. No preliminary file read/list is needed. Deleting, overwriting, disk formatting and shutdown may need the user\'s approval: on APPROVAL_REQUIRED show approvalUrl to the user, wait for them to approve in Hostherd, then retry the identical call. Never work around COMMAND_BLOCKED or APPROVAL_DENIED with an equivalent command.',
    });
    const connect = server.connect.bind(server);
    server.connect = async transport => {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => { logs?.message(message, trace); return send(message, options); };
      return connect(transport);
    };
    function add<T extends z.ZodRawShape>(name: string, description: string, schema: T,
      run: (params: z.infer<z.ZodObject<T>>, context: RunContext) => Promise<unknown> | unknown,
      annotations?: ToolAnnotations, meta?: Record<string, unknown>) {
      server.registerTool(name, { description, inputSchema: z.object(schema),
        ...(annotations ? { annotations } : {}), ...(meta ? { _meta: meta } : {}) }, async (params, ctx) => {
        logs?.tool();
        try {
          const value = await run(params as z.infer<z.ZodObject<T>>, { clientId: ctx?.http?.authInfo?.clientId, request: (ctx as RequestContext | undefined)?.mcpReq });
          if (value instanceof ToolContent) {
            const first = value.content.find(c => c.type === 'text');
            if (first?.type === 'text') { try { logs?.result(JSON.parse(first.text)); } catch { /* Only metadata is summarized. */ } }
          } else logs?.result(value);
          logs?.event('tool', 'success');
          return value instanceof ToolContent ? { content: value.content } : { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
        } catch (error) {
          if (error instanceof InputNeeded) { logs?.event('tool', 'input_required'); return error.result; }
          logs?.event('tool', 'error');
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error instanceof ToolFailure ? error.result : { code: error instanceof AppError ? error.code : 'ERROR', error: error instanceof Error ? error.message : 'Operation failed' }) }] };
        }
      });
    }
    const readOnly = { readOnlyHint: true, openWorldHint: false } satisfies ToolAnnotations;
    const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } satisfies ToolAnnotations;
    // Destructive operations follow the command policy before reaching the agent.
    function guard(serverId: string, tool: string, command: string, path: string | null, args: unknown, matches: Match[], context: RunContext) {
      const input = { serverId, tool, command, path, args, matches, clientId: context.clientId };
      let result = approvals.check(input);
      if (result.ok) return;
      if (result.code === 'APPROVAL_REQUIRED') {
        // Clients that can ask the user themselves (elicitation) get the question in place of a link.
        const answer = inputResponse(context.request?.inputResponses, 'approval');
        const decision = answer.kind === 'elicit' && answer.action === 'accept' ? (answer.content as { decision?: unknown } | undefined)?.decision : undefined;
        if (decision === 'approve' || decision === 'always' || decision === 'deny') {
          try { approvals.decide(result.approvalId, decision === 'deny' ? 'deny' : 'approve', decision === 'always'); }
          catch (error) { if (!(error instanceof AppError && error.code === 'NOT_PENDING')) throw error; }
          result = approvals.check(input);
          if (result.ok) return;
        } else if (answer.kind === 'elicit') {
          // Declined or cancelled is not a decision: some clients declare
          // elicitation but dismiss it without asking. The link still works.
        } else if (result.code === 'APPROVAL_REQUIRED' && (context.request?.envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined)?.elicitation) {
          const server = hub.store.server(serverId);
          throw new InputNeeded(inputRequired({ inputRequests: { approval: inputRequired.elicit({
            message: `Hostherd approval request · ${server.name}\n${command.slice(0, 2000)}\nRules: ${approvals.ruleNames(result.rules).join(', ')}\nYou can also approve it on the web: ${publicUrl}/approvals/${result.approvalId}`,
            requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Decision', oneOf: [
              { const: 'approve', title: 'Allow once' }, { const: 'always', title: 'Always allow (these rules)' }, { const: 'deny', title: 'Deny' },
            ] } }, required: ['decision'] },
          }) } }));
        }
      }
      const approvalUrl = `${publicUrl}/approvals/${result.approvalId}`;
      const error = {
        APPROVAL_REQUIRED: 'The user must approve this operation in Hostherd. Show approvalUrl to the user, wait until they say it is approved, then retry the identical call. Changing the arguments needs a new approval.',
        APPROVAL_DENIED: 'The user denied this operation. Do not retry it or run an equivalent command; ask the user how to proceed.',
        COMMAND_BLOCKED: 'Hostherd policy blocks this operation. Do not work around it; tell the user which rule blocked it.',
      }[result.code];
      throw new ToolFailure({ code: result.code, error, approvalId: result.approvalId, rules: approvals.ruleNames(result.rules), ...(result.code === 'APPROVAL_REQUIRED' ? { approvalUrl } : {}) });
    }
    // Text output stops before a split character; nextCursor resumes there.
    async function jobOutput(jobId: string, cursor: number, limit: number, status: string) {
      const { data, eof, ...output } = await hub.store.output(jobId, cursor, limit);
      const bytes = Buffer.from(data, 'base64');
      const { length, ...chunk } = textChunk(bytes, eof && !['running', 'pending', 'unknown'].includes(status));
      return { ...output, ...chunk, nextCursor: cursor + length, eof: eof && length === bytes.length };
    }
    const isWindows = (serverId: string) => hub.store.server(serverId).os === 'windows';
    async function exists(serverId: string, target: string) {
      const api = isWindows(serverId) ? path.win32 : path.posix;
      try {
        const { entries } = await hub.rpc<{ entries: { name: string }[] }>(serverId, 'file.list', { path: api.dirname(target) });
        const name = api.basename(target);
        return entries.some(entry => isWindows(serverId) ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name);
      } catch {
        // An unreadable parent may still hold the file; an offline server fails the write itself.
        return hub.online(serverId);
      }
    }
    add('servers_list', 'List registered servers, IDs, execution accounts, current connection status and latest resource usage (cpu %, memPct, diskPct of the fullest filesystem, load1).', {}, () => hub.servers(), readOnly);
    add('server_metrics', 'Read a server\'s resource usage: the latest full sample (CPU, load, memory, swap, every filesystem, network bytes/s, uptime) and a summary over a time range with a compact series. Use it to check health before or after running commands.', {
      serverId, range: z.enum(['1h', '6h', '24h', '7d', '30d']).default('1h').describe('Time range for the summary and series.'),
    }, ({ serverId, range }) => {
      const server = hub.store.server(serverId);
      if (!hub.metrics) throw new AppError('METRICS_UNAVAILABLE', 'Metrics are not enabled.');
      const latest = hub.metrics.latest(serverId);
      const { step, points } = hub.metrics.series(serverId, range);
      const values = (key: 'cpu' | 'mem' | 'disk' | 'load' | 'rx' | 'tx') => points.map(point => point[key]).filter((value): value is number => value !== null);
      const stats = (key: 'cpu' | 'mem' | 'disk' | 'load' | 'rx' | 'tx') => { const list = values(key); return list.length ? { avg: Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10, max: Math.max(...list) } : null; };
      const every = Math.max(1, Math.ceil(points.length / 24));
      return {
        serverId, name: server.name, online: hub.online(serverId), agentVersion: server.version, latest,
        ...(latest ? {} : { note: 'No samples yet. The agent reports resource usage periodically while it is connected.' }),
        summary: { range, cpuPercent: stats('cpu'), memoryPercent: stats('mem'), fullestDiskPercent: stats('disk'), load1: stats('load'), networkRxBytesPerSecond: stats('rx'), networkTxBytesPerSecond: stats('tx'), availability: hub.metrics.availability(serverId, range, hub.online(serverId)).percent },
        series: { stepSeconds: step * every, points: points.filter((_, index) => index % every === every - 1) },
      };
    }, readOnly);
    add('job_start', 'Run cmd with the target account\'s automatically selected login shell, using path as the working DIRECTORY. Example: path="/", cmd="hostname; uptime". Do not put /bin/bash in path. Returns a jobId and initial output; a running or unknown job must be inspected, not replaced. Use the same requestId for an uncertain retry with identical arguments, and a new requestId after correcting invalid arguments. No default execution timeout.', {
      serverId, path: workingDirectory,
      cmd: z.string().min(1).describe('Shell command text executed inside path. Supports shell operators and pipelines. The shell is selected automatically. Example: hostname; uptime').meta({ examples: ['hostname; uptime', 'pwd; ls -la'] }),
      requestId: z.string().uuid().optional().describe('Client-generated UUID for deduplication. Reuse only with identical arguments; use a new UUID when correcting path or cmd.'),
      env: z.record(z.string(), z.string()).optional().describe('Environment variables to add or override for this command.'),
      timeoutMs: z.number().int().positive().optional().describe('Optional execution time limit in milliseconds. Omit for no execution timeout.'),
      waitMs: waitMs('How long this tool call waits for initial results, in milliseconds. This does not stop a longer-running job.')
    }, async ({ serverId, requestId, waitMs, ...params }, context) => {
      // A retry of an already dispatched request returns that job without asking again.
      if (!requestId || !hub.store.request(requestId, { serverId, kind: 'job', ...params })) {
        guard(serverId, 'job_start', params.cmd, params.path, params, [...classifyCommand(params.cmd, params.path, isWindows(serverId)), ...approvals.customMatches(params.cmd, isWindows(serverId))], context);
      }
      let job = await hub.start(serverId, 'job', params, requestId);
      const deadline = Date.now() + waitLimit(waitMs);
      while (['running', 'pending'].includes(job.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100)); job = hub.store.job(job.id);
      }
      const result = { ...job, jobId: job.id, output: await jobOutput(job.id, 0, 65536, job.status) };
      if (job.status === 'failed') {
        throw new ToolFailure({ ...result, code: job.errorCode ?? 'JOB_FAILED', error: job.error ?? `Command exited with code ${job.exitCode ?? 'unknown'}.` });
      }
      return result;
    }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    add('jobs_list', 'List command jobs, newest first, with their last known state. Long cmd values are shortened; job_status returns the full record. more=true means older jobs exist beyond limit. Offline servers cannot report fresh process state.', {
      serverId: serverId.optional(),
      status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted', 'unknown']).optional().describe('Only jobs in this state.'),
      limit: z.number().int().min(1).max(500).default(50).describe('Maximum jobs to return.'),
    }, ({ serverId, status, limit }) => {
      const { items, total } = hub.store.jobPage({ kind: 'job', serverId, status, limit, offset: 0 });
      return {
        jobs: items.map(job => ({ ...job, ...(job.cmd.length > 300 ? { cmd: `${job.cmd.slice(0, 300)}… [${job.cmd.length} chars; job_status has the full cmd]` } : {}), serverOnline: hub.online(job.serverId) })),
        total, more: total > items.length,
      };
    }, readOnly);
    add('job_status', 'Read a job state by jobId, reconciling with the target when online.', { jobId }, async ({ jobId }) => {
      let job = hub.store.job(jobId);
      if (hub.online(job.serverId) && ['running', 'unknown', 'pending'].includes(job.status)) {
        const state = await hub.rpc<Omit<typeof job, 'serverId' | 'outputBytes'>>(job.serverId, 'job.status', { id: jobId });
        hub.store.saveJob(job.serverId, state); job = hub.store.job(jobId);
      }
      return { ...job, serverOnline: hub.online(job.serverId) };
    }, readOnly);
    add('job_output', 'Read saved output from a byte cursor. Returns UTF-8 text (a page may end a few bytes early so characters are not split), or base64 data with encoding "base64" when the bytes are not UTF-8. Pass nextCursor as the next cursor to continue without repeating output. Output is retained in full on disk.', { jobId, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1024 * 1024).default(65536) }, async ({ jobId, cursor, limit }) => {
      const status = hub.store.job(jobId).status;
      return { ...await jobOutput(jobId, cursor, limit, status), status };
    }, readOnly);
    add('job_input', 'Write text to a running job standard input. Set eof to close standard input after the text.', { jobId, data: z.string().default(''), eof: z.boolean().default(false) }, ({ jobId, ...input }, context) => {
      const job = hub.store.job(jobId);
      // A running shell may have changed directory, so relative targets are not placed.
      guard(job.serverId, 'job_input', input.data, null, { jobId, ...input }, [...classifyCommand(input.data, null, isWindows(job.serverId)), ...approvals.customMatches(input.data, isWindows(job.serverId))], context);
      return hub.rpc(job.serverId, 'job.input', { id: jobId, ...input });
    });
    add('job_cancel', 'Stop a job and its managed child processes.', { jobId }, ({ jobId }) => hub.rpc(hub.store.job(jobId).serverId, 'job.cancel', { id: jobId }), destructive);
    add('file_list', 'List directory entries on a server, using its registered execution account.', { serverId, path: absolutePath.describe('Absolute directory path to list on the target server. Example: /var/log.') }, ({ serverId, ...params }) => hub.rpc(serverId, 'file.list', params), readOnly);
    add('image_read', 'Use this to SEE a saved screenshot, chart or other PNG/JPEG image. Returns actual MCP image content and file metadata, with original bytes preserved. Example: {"serverId":"<target server ID>","path":"/tmp/screenshot.png"}. To capture a webpage, first run your installed headless browser through job_start, wait for that job to complete successfully, then call image_read with the SAME serverId and the saved absolute FILE path. If Playwright and Chrome are already installed, an example capture cmd is: npx --no-install playwright screenshot --channel=chrome https://example.com /tmp/screenshot.png (run in the project directory containing Playwright). This tool reads an existing file; it does not open URLs or take screenshots. Do not pass a directory, URL, jobId or base64 data in path. No preliminary file_list/file_read call is needed. Maximum 8 MiB and 24 million pixels; save a smaller/cropped image when necessary.', {
      serverId,
      path: absolutePath.describe('Absolute path to an existing PNG/JPEG image FILE on this target server, readable by its registered execution account. Example: /tmp/screenshot.png. Not a URL, directory, local-client path, jobId or base64 string. Wait for the screenshot-writing job to complete first.').meta({ examples: ['/tmp/screenshot.png', '/tmp/chart.jpg'] }),
    }, async ({ serverId, path }) => {
      const result = await hub.rpc<{ data: string; mimeType: string; size: number; width: number; height: number }>(serverId, 'file.image', { path });
      const { data, ...metadata } = result;
      return new ToolContent([
        { type: 'text', text: JSON.stringify({ serverId, path, ...metadata }) },
        { type: 'image', data, mimeType: result.mimeType },
      ]);
    }, readOnly);
    add('file_read', 'Read a file page. Returns UTF-8 text (a page may end a few bytes early so characters are not split), or exact bytes as base64 data with encoding "base64" for non-UTF-8 files. To visually inspect a screenshot or PNG/JPEG image, use image_read instead. Continue with offset=nextOffset.', { serverId, path: absolutePath.describe('Absolute file path to read on the target server. Example: /etc/os-release.'), ...page }, async ({ serverId, ...params }) => {
      const { data, encoding: _encoding, ...result } = await hub.rpc<{ data: string; encoding: string; nextOffset: number; eof: boolean }>(serverId, 'file.read', params);
      const bytes = Buffer.from(data, 'base64');
      const { length, ...chunk } = textChunk(bytes, result.eof);
      return { ...result, ...chunk, nextOffset: result.nextOffset - (bytes.length - length), eof: result.eof && length === bytes.length };
    }, readOnly);
    add('file_search', 'Search literal text recursively within a path; paginated matches contain file paths and line numbers.', { serverId, path: absolutePath, query: z.string().min(1), offset: page.offset, limit: z.number().int().min(1).max(1000).default(100) }, ({ serverId, ...params }) => hub.rpc(serverId, 'file.search', params), readOnly);
    add('file_write', 'Create or replace a file using UTF-8 text or base64 data. Set createOnly to avoid replacing an existing file.', { serverId, path: absolutePath, data: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8'), createOnly: z.boolean().default(false) }, async ({ serverId, ...params }, context) => {
      if (!params.createOnly && await exists(serverId, params.path)) {
        guard(serverId, 'file_write', params.path, params.path, { path: params.path, data: hash(params.data), encoding: params.encoding }, [{ rule: 'file-overwrite', targets: [params.path] }], context);
      }
      return hub.rpc(serverId, 'file.write', params);
    }, destructive);
    add('file_edit', 'Replace exactly one occurrence of oldText. Fails if the match is absent or ambiguous.', { serverId, path: absolutePath, oldText: z.string().min(1), newText: z.string() }, ({ serverId, ...params }, context) => {
      guard(serverId, 'file_edit', params.path, params.path, { path: params.path, oldText: hash(params.oldText), newText: hash(params.newText) }, [{ rule: 'in-place-edit', targets: [params.path] }], context);
      return hub.rpc(serverId, 'file.edit', params);
    }, destructive);
    add('file_delete', 'Delete a file or directory. Recursive directory deletion requires recursive=true.', { serverId, path: absolutePath, recursive: z.boolean().default(false) }, ({ serverId, ...params }, context) => {
      guard(serverId, 'file_delete', params.path, params.path, params, [{ rule: 'file-delete', targets: [params.path] }], context);
      return hub.rpc(serverId, 'file.delete', params);
    }, destructive);
    const transferId = z.string().uuid().describe('transferId returned by file_upload or file_download. Keep polling this ID while running; do not start replacements.');
    const transferInput = {
      serverId,
      path: absolutePath.describe('Absolute FILE path on this target server. For upload this is the destination filename; for download this is the existing source file. Never use a directory, sandbox URL or local ChatGPT path.').meta({ examples: ['/tmp/report.zip', '/tmp/data.csv'] }),
      requestId: z.string().uuid().optional().describe('Reuse for an uncertain retry of the same file and path. Use a new ID when changing arguments, refreshing an expired attachment, or starting a new transfer after failure.'),
      waitMs: waitMs('Wait briefly for completion, in milliseconds; a running response contains transferId for file_transfer_status. This does not limit the transfer duration.'),
    };
    function transferResult(state: Awaited<ReturnType<FileTransfers['status']>>) {
      if (state.status === 'failed') throw new ToolFailure({ ...state, code: state.errorCode ?? 'TRANSFER_FAILED' });
      const content: ToolContent['content'] = [{ type: 'text', text: JSON.stringify(state) }];
      if (state.downloadUrl) content.push({ type: 'resource_link', uri: state.downloadUrl, name: state.filename, mimeType: state.mimeType!, size: state.size });
      return new ToolContent(content);
    }
    add('file_upload', 'Send a user-attached ChatGPT file to a target server. ChatGPT supplies the file object through native file parameters: download_url and file_id are required; mime_type and file_name are optional. Use the actual attachment, never invent its URL or file ID, and never put sandbox:/mnt/data paths or base64 in file. Example intent: upload the attached report.zip to serverId=<known target>, path=/tmp/report.zip. Streams original bytes without putting them in model context. Existing destinations are protected unless overwrite=true was explicitly requested. When running, poll file_transfer_status with the returned transferId until completed; report completion only after size and SHA-256 are confirmed. Expired source URLs require a fresh attachment URL and a new requestId.', {
      ...transferInput,
      file: z.object({
        download_url: z.string().min(1).max(16384).describe('Temporary download URL supplied by ChatGPT for the selected attachment. Do not fabricate or derive this URL from a file ID.'),
        file_id: z.string().min(1).max(512).describe('File identifier supplied by ChatGPT for the selected attachment.'),
        mime_type: z.string().max(255).optional(), file_name: z.string().max(1024).optional(),
      }),
      overwrite: z.boolean().default(false).describe('Default false refuses an existing destination. Set true only when replacing that exact file is intended; publication is atomic after checksum verification.'),
    }, async (params, context) => {
      if (params.overwrite && !transfers.known(params.requestId)) {
        guard(params.serverId, 'file_upload', params.path, params.path, { path: params.path, fileId: params.file.file_id }, [{ rule: 'file-overwrite', targets: [params.path] }], context);
      }
      return transferResult(await transfers.upload({ ...params, waitMs: waitLimit(params.waitMs) }));
    }, destructive, { 'openai/fileParams': ['file'] });
    add('file_download', 'Send a target-server file back to the user as a downloadable file. Example: {"serverId":"<known target>","path":"/tmp/report.zip"}. Creates a private byte-exact snapshot and returns a downloadUrl plus an MCP resource link when completed. Present that exact URL to the user as a Markdown download link; do not replace it with a server path, sandbox path or base64. The link works for anyone holding it for one hour, and can be revoked with file_transfer_cancel. Large files return running: poll file_transfer_status with the same transferId until completed. Original server file is not modified. For visually inspecting PNG/JPEG instead of downloading a file, use image_read.',
      transferInput, async params => transferResult(await transfers.download({ ...params, waitMs: waitLimit(params.waitMs) })), readOnly);
    add('file_transfer_status', 'Read file-transfer progress, byte count, completion checksum and download link. Use transferId from file_upload/file_download. Keep polling while running. Unknown means a response was lost; this call checks the original transfer before you retry. Expired downloads need a new file_download with a new requestId.',
      { transferId }, async ({ transferId }) => transferResult(await transfers.status(transferId)), readOnly);
    add('file_transfer_cancel', 'Cancel a running file transfer or revoke a completed download link. Removes transfer temporary files, never deletes the original source or a successfully uploaded destination. An upload already committed returns completed and cannot be undone by cancellation.',
      { transferId }, async ({ transferId }) => transferResult(await transfers.cancel(transferId)));
    return server;
  }, { onerror: error => logs?.failure('sdk', error) });
  const nodeHandler = toNodeHandler({ fetch: async (request, options) => {
    const response = await handler.fetch(request, options);
    // SDK rejections before a transport exists are small JSON error responses.
    if (!response.ok && response.headers.get('content-type')?.includes('application/json')) {
      try { logs?.message(await response.clone().json()); } catch { /* HTTP status still records a non-JSON error. */ }
    }
    return response;
  } }, { onerror: error => logs?.failure('http', error) });
  app.all('/mcp', async (req, res, next) => {
    try {
      logs?.request(req.body);
      logs?.event('auth', 'start');
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const auth = token ? await authenticate(token) : null;
      if (!auth) {
        logs?.failure('auth', { code: 'UNAUTHORIZED', message: 'Authentication required' });
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", scope="mcp"`);
        res.status(401).json({ code: 'UNAUTHORIZED', error: 'Authentication required.' }); return;
      }
      logs?.update({ clientId: redactText(auth.clientId), subject: redactText(auth.subject) });
      logs?.event('auth', 'success');
      logs?.event('sdk', 'start');
      const authenticated = req as Request & { auth: { token: string; clientId: string; scopes: string[] } };
      authenticated.auth = { token: token!, clientId: auth.clientId, scopes: auth.scopes };
      await nodeHandler(authenticated, res, req.body);
    } catch (error) { logs?.failure('http', error); next(error); }
  });
  return handler;
}
