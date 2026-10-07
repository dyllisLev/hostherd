export interface Me {
  authenticated: boolean;
  setupRequired: boolean;
  username?: string;
}

export interface Server {
  id: string;
  name: string;
  hostname: string;
  online: boolean;
  executionUser: string;
  version: string;
  os: string;
  arch: string;
  lastSeen: string | null;
  createdAt: string;
  fault?: string | null;
  metrics?: LatestMetrics | null;
  /** The agent is online and announced remote uninstall. */
  canUninstall?: boolean;
}

export interface LatestMetrics { at: string; cpu: number | null; memPct: number | null; diskPct: number | null; load1: number | null }
export interface MetricsSample {
  cpu?: number; cpus: number; load1?: number; load5?: number; load15?: number;
  memTotal?: number; memUsed?: number; swapTotal?: number; swapUsed?: number;
  netRx?: number; netTx?: number; uptime?: number; procs?: number;
  disks: { mount: string; fs: string; total: number; used: number; avail: number }[];
}
export interface MetricsPoint { t: string; cpu: number | null; cpuMax: number | null; mem: number | null; disk: number | null; load: number | null; rx: number | null; tx: number | null }
export type MetricsRange = '1h' | '6h' | '24h' | '7d' | '30d';
export interface ServerMetrics {
  range: MetricsRange; step: number; points: MetricsPoint[];
  latest: { at: string; sample: MetricsSample } | null;
  availability: { percent: number | null; events: { type: 'online' | 'offline'; at: string }[] };
}

export interface Job {
  id: string;
  serverId: string;
  serverName: string;
  kind: 'job' | 'terminal';
  path: string;
  cmd: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
  errorCode?: string | null;
  pid?: number;
  cols?: number;
  rows?: number;
  runnerVersion?: string;
  outputBytes: number;
  label?: string | null;
}

export interface Output {
  data: string;
  cursor: number;
  nextCursor: number;
  eof: boolean;
}

export interface JobPage {
  items: Job[];
  total: number;
}

export interface ActivityDay { date: string; completed: number; failed: number; interrupted: number; other: number }

export interface DashboardData {
  runningJobs: number;
  activeTerminals: number;
  failedJobs24h: number;
  jobs24h: number;
  activity: ActivityDay[];
  recentJobs: Job[];
  recentFailures: Job[];
  unacknowledgedFailures24h: number;
  running: Record<string, { jobs: number; terminals: number }>;
  mcp: {
    days: McpDay[];
    summary: { requests: number; errors: number; held: number };
    latest: McpCall[];
    clients: { clientId: string | null; client: string | null; requests: number; errors: number; lastAt: string }[];
  };
}
export interface McpDay { date: string; command: number; file: number; query: number; held: number; error: number }
export interface McpCall {
  traceId: string; receivedAt: string; tool: string; serverId: string | null; serverName: string | null;
  clientId: string | null; client: string | null; outcome: RequestOutcome; errorCode: string | number | null; summary: string | null;
}

export interface SettingsData {
  url: string;
  mcpUrl: string;
  version: string;
  agentVersion: string | null;
  retentionDays: number;
}

/** True when `current` is an older dotted version than `latest`. */
export function isOlderVersion(current: string, latest?: string | null) {
  if (!current || !latest) return false;
  const a = current.split(/[.+-]/).map(Number), b = latest.split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return false;
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export function isActive(job: Job) {
  return !['completed', 'failed', 'interrupted'].includes(job.status);
}

export type RequestOutcome = 'pending' | 'success' | 'error' | 'unknown';

export interface RequestLogCollection {
  startedAt: string;
  status: 'ok' | 'degraded';
  failedWrites: number;
  lastErrorAt?: string;
}

export interface RequestLog {
  traceId: string;
  receivedAt: string;
  endedAt?: string;
  durationMs?: number;
  httpMethod: string;
  httpPath: string;
  httpStatus?: number;
  rpcId?: string | number | null;
  method?: string;
  tool?: string;
  serverId?: string;
  serverName?: string;
  executionUser?: string;
  clientId?: string;
  subject?: string;
  clientName?: string;
  userAgent?: string;
  requestId?: string;
  jobId?: string;
  transferId?: string;
  arguments?: unknown;
  result?: unknown;
  outcome: RequestOutcome;
  incomplete?: boolean;
  errorCode?: string | number;
  error?: string;
  failureStage?: string;
  mcpIsError?: boolean;
  jsonRpcErrorCode?: number;
}

export interface RequestLogList {
  items: RequestLog[];
  nextCursor?: string | null;
  collection: RequestLogCollection;
}

export interface RequestLogDetail {
  request: RequestLog;
  events: { seq: number; at: string; stage: string; status: string; data?: unknown }[];
  job?: { id: string; kind: string; status: string; exitCode?: number | null; outputBytes: number; endedAt?: string | null };
  transfer?: { transferId: string; status: string; bytes: number; size?: number; errorCode?: string; error?: string };
  collection: RequestLogCollection;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'blocked' | 'expired';
export interface Approval {
  id: string; serverId: string; serverName: string | null; tool: string; command: string; path: string | null; rules: string[];
  status: ApprovalStatus; clientId: string | null; createdAt: string; decidedAt: string | null; expiresAt: string | null; usedAt: string | null;
  ruleNames?: string[];
}
export interface ApprovalList { items: Approval[]; total: number; pending: number }
export type RuleMode = 'confirm' | 'allow' | 'block';
export interface CommandRule { id: string; category: 'delete' | 'overwrite' | 'system' | 'custom'; name: string; mode: RuleMode; updatedAt: string | null; matchType?: 'command' | 'regex'; pattern?: string }
export interface AllowedFolder { id: string; serverId: string | null; path: string; createdAt: string }

export type WebhookEvent = 'approval' | 'offline' | 'fault' | 'usage' | 'job_failed';
export type WebhookKind = 'generic' | 'slack' | 'discord' | 'telegram';
export interface Webhook {
  id: string; name: string; kind: WebhookKind; target: string; chatId: string | null; hasSecret: boolean; events: WebhookEvent[];
  enabled: boolean; createdAt: string; lastAt: string | null; lastStatus: 'ok' | 'error' | null; lastError: string | null;
}
