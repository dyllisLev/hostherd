import { Activity, AlertTriangle, ArrowRight, ArrowUpCircle, CheckCircle2, CircleX, Gauge, Plus, ScrollText, Server as ServerIcon, ShieldAlert, WifiOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { ApprovalActions, RuleBadges } from '../components/approval-actions';
import { OsIcon } from '../components/brand';
import { ServerRegister } from '../components/server-register';
import { usageTone } from '../components/usage';
import { Badge, Button, Card, CardHeader, Dot, Empty, ErrorNotice, PageHeading, Segmented, Skeleton, Time, toast, Tooltip, type Tone } from '../components/ui';
import { formatNumber, t, type MessageKey } from '../i18n';
import { errorMessage, post, useApi } from '../lib/api';
import { usePendingApprovals, useServerHealth } from '../lib/app-data';
import { usePreferences } from '../lib/preferences';
import { Link } from '../lib/router';
import { displayOffsetMinutes, formatDay, formatRelative } from '../lib/time';
import type { DashboardData, McpCall, McpDay, Server } from '../lib/types';
import { cn } from '../lib/utils';

function Metric({ label, value, detail, icon: Icon, href, tone }: { label: string; value: ReactNode; detail: ReactNode; icon: typeof ServerIcon; href: string; tone?: 'danger' | 'warning' }) {
  return <Link href={href} className="group min-w-0 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:bg-muted/30 sm:p-5">
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground sm:text-sm"><span className="truncate">{label}</span><Icon className="size-4 shrink-0" /></div>
    <p className={cn('mt-3 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning')}>{value}</p>
    <div className="mt-2 truncate text-xs text-muted-foreground">{detail}</div>
  </Link>;
}

const highUsage = (server: Server) => server.metrics ? ([['CPU', server.metrics.cpu], [t('metrics.memory'), server.metrics.memPct], [t('metrics.disk'), server.metrics.diskPct]] as const)
  .filter(([, value]) => value !== null && value >= 90).map(([label, value]) => `${label} ${Math.round(value!)}%`) : [];

interface Issue { key: string; icon: ReactNode; title: ReactNode; detail: ReactNode; href: string; onAcknowledge?: () => void }

/** Pending approvals first, decided in place, then server and job issues. */
function Attention({ failed, onAcknowledgeFailures }: { failed: number; onAcknowledgeFailures: () => void }) {
  const health = useServerHealth();
  const approvals = usePendingApprovals().data;
  const pending = approvals?.items ?? [];
  const issues: Issue[] = [
    ...health.faults.map(server => ({ key: 'fault-' + server.id, icon: <AlertTriangle className="size-4 text-danger" />, title: t('dashboard.issueFault', { name: server.name }), detail: <span className="line-clamp-1 break-all">{server.fault}</span>, href: '/servers/' + server.id })),
    ...health.offline.map(server => ({ key: 'offline-' + server.id, icon: <WifiOff className="size-4 text-muted-foreground" />, title: t('dashboard.issueOffline', { name: server.name }), detail: server.lastSeen ? <>{t('dashboard.lastSeen')} <Time value={server.lastSeen} relative /></> : t('servers.pendingRegistration'), href: '/servers/' + server.id })),
    ...health.online.filter(server => highUsage(server).length).map(server => ({ key: 'usage-' + server.id, icon: <Gauge className="size-4 text-warning" />, title: t('dashboard.issueUsage', { name: server.name }), detail: highUsage(server).join(' · '), href: '/servers/' + server.id + '?tab=resources' })),
    ...health.updates.map(server => ({ key: 'update-' + server.id, icon: <ArrowUpCircle className="size-4 text-info" />, title: t('dashboard.issueUpdate', { name: server.name }), detail: `${server.version} → ${health.latest}`, href: '/servers/' + server.id })),
    ...(failed ? [{ key: 'failed', icon: <CircleX className="size-4 text-danger" />, title: t('dashboard.issueFailedJobs', { n: failed }), detail: t('dashboard.issueFailedJobsHint'), href: '/jobs?status=failed', onAcknowledge: onAcknowledgeFailures }] : []),
  ];
  if (!health.servers.length) return null;
  const count = pending.length + issues.length;
  if (!count) return <div className="flex items-center gap-3 rounded-xl border tone-success px-4 py-3 text-sm"><CheckCircle2 className="size-4 shrink-0" />{t('dashboard.allHealthy')}</div>;
  const shownIssues = issues.slice(0, Math.max(0, 6 - Math.min(pending.length, 3)));
  return <Card>
    <CardHeader title={<span className="flex items-center gap-2">{t('dashboard.attention')}<span className="rounded-full border tone-danger px-1.5 text-xs tabular-nums">{count}</span></span>} description={t('dashboard.attentionHint')} />
    <ul className="divide-y border-t">
      {pending.slice(0, 3).map(approval => <li key={approval.id} className="flex flex-col gap-3 px-5 py-3 sm:px-6 lg:flex-row lg:items-center">
        <Link href={'/approvals/' + approval.id} className="flex min-w-0 flex-1 items-center gap-3">
          <ShieldAlert className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs font-medium hover:underline">{approval.command}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{t('dashboard.approvalRequest', { server: approval.serverName || approval.serverId })}<Time value={approval.createdAt} relative /><RuleBadges rules={approval.rules} names={approval.ruleNames} /></span>
          </span>
        </Link>
        <ApprovalActions approval={approval} size="sm" className="shrink-0" />
      </li>)}
      {pending.length > 3 && <li><Link href="/approvals" className="flex items-center gap-3 px-5 py-2.5 text-xs text-muted-foreground hover:bg-muted/35 sm:px-6">{t('dashboard.moreApprovals', { n: pending.length - 3 })}<ArrowRight className="size-3.5" /></Link></li>}
      {shownIssues.map(issue => <li key={issue.key} className="relative flex items-center gap-3 px-5 py-3 hover:bg-muted/35 sm:px-6">
        {issue.icon}<Link href={issue.href} className="min-w-0 flex-1 after:absolute after:inset-0"><span className="block truncate text-sm font-medium">{issue.title}</span><span className="block truncate text-xs text-muted-foreground">{issue.detail}</span></Link>
        {issue.onAcknowledge && <Tooltip content={t('dashboard.acknowledgeFailuresHint')}><Button variant="outline" size="sm" className="relative z-10" onClick={issue.onAcknowledge}>{t('dashboard.acknowledge')}</Button></Tooltip>}
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </li>)}
    </ul>
    {issues.length > shownIssues.length && <p className="border-t px-6 py-3 text-xs text-muted-foreground">{t('dashboard.moreIssues', { n: issues.length - shownIssues.length })}</p>}
  </Card>;
}

const kinds = [
  { key: 'command', color: 'var(--series-1)' },
  { key: 'file', color: 'var(--series-3)' },
  { key: 'query', color: 'var(--chart-neutral)' },
  { key: 'held', color: 'var(--chart-warning)' },
  { key: 'error', color: 'var(--chart-danger)' },
] as const;

function McpChart({ data }: { data: McpDay[] }) {
  const { resolvedTheme } = usePreferences();
  const total = data.reduce((sum, day) => sum + day.command + day.file + day.query + day.held + day.error, 0);
  if (!total) return <Empty title={t('dashboard.noMcpActivity')} description={t('dashboard.noMcpActivityHint')} />;
  const label = (key: string) => t(`dashboard.kind.${key}` as MessageKey);
  return <div className="px-3 pb-5 sm:px-5">
    <div className="h-56 w-full" role="img" aria-label={t('dashboard.mcpActivityAria', { n: data.length })}>
      <ResponsiveContainer width="100%" height="100%"><BarChart key={resolvedTheme} data={data} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={16} tickMargin={10} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickFormatter={value => formatDay(String(value))} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} />
        <ChartTooltip cursor={{ fill: 'var(--muted)', opacity: 0.6 }} contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--foreground)', fontSize: 12 }} labelFormatter={value => formatDay(String(value))} formatter={(value, name) => [formatNumber(Number(value)), label(String(name))]} />
        {kinds.map((item, index) => <Bar key={item.key} dataKey={item.key} stackId="calls" fill={item.color} stroke="var(--card)" strokeWidth={1} maxBarSize={28} radius={index === kinds.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={false} />)}
      </BarChart></ResponsiveContainer>
    </div>
    <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">{kinds.map(item => <span key={item.key} className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: item.color }} />{label(item.key)}</span>)}</div>
  </div>;
}

const outcomeTone: Record<string, Tone> = { success: 'success', error: 'danger', pending: 'neutral', unknown: 'warning', APPROVAL_REQUIRED: 'warning', APPROVAL_DENIED: 'danger', COMMAND_BLOCKED: 'danger' };
function CallOutcome({ call }: { call: McpCall }) {
  const code = typeof call.errorCode === 'string' && call.errorCode in outcomeTone ? call.errorCode : call.outcome;
  return <Badge tone={outcomeTone[code] ?? 'neutral'}>{t(`dashboard.callOutcome.${code}` as MessageKey)}</Badge>;
}

function RecentCalls({ calls }: { calls: McpCall[] }) {
  if (!calls.length) return <Empty className="py-8" title={t('dashboard.noCalls')} description={t('dashboard.noMcpActivityHint')} />;
  return <ul className="divide-y border-t">{calls.map(call => <li key={call.traceId}><Link href={'/request-logs/' + call.traceId} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/35 sm:px-6">
    <span className="min-w-0 flex-1">
      <span className="block truncate font-mono text-xs font-medium">{call.summary || call.tool}</span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{call.client || t('dashboard.unknownClient')}</span>{call.summary && <span className="font-mono">{call.tool}</span>}
        {call.serverName && <span>{call.serverName}</span>}<Time value={call.receivedAt} relative />
      </span>
    </span>
    <CallOutcome call={call} />
  </Link></li>)}</ul>;
}

const usageColumns = 'grid w-44 shrink-0 grid-cols-3 gap-2.5';

function UsageCell({ label, value }: { label: string; value: number | null }) {
  const tone = value === null ? 'normal' : usageTone(value);
  return <span className="min-w-0" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value)}>
    <span className={cn('block text-right text-[11px] leading-none tabular-nums', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-foreground')}>{value === null ? '—' : Math.round(value) + '%'}</span>
    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">{value !== null && <span className={cn('block h-full rounded-full', tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-foreground/70')} style={{ width: Math.max(2, Math.min(100, value)) + '%' }} />}</span>
  </span>;
}

function Clients({ clients }: { clients: DashboardData['mcp']['clients'] }) {
  if (!clients.length) return <p className="border-t px-5 py-4 text-xs text-muted-foreground sm:px-6">{t('dashboard.noClients')}</p>;
  const most = Math.max(...clients.map(item => item.requests));
  return <ul className="divide-y border-t">{clients.map(item => <li key={item.clientId ?? 'unknown'} className="px-5 py-2.5 sm:px-6">
    <div className="flex items-baseline justify-between gap-3 text-sm"><span className="truncate font-medium">{item.client || t('dashboard.unknownClient')}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t('dashboard.clientRequests', { n: formatNumber(item.requests) })}{item.errors > 0 && <span className="text-danger"> · {t('dashboard.clientErrors', { n: item.errors })}</span>} · <Time value={item.lastAt} relative /></span></div>
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[var(--series-1)]" style={{ width: Math.max(2, item.requests / most * 100) + '%' }} /></div>
  </li>)}</ul>;
}

/** One line per server: state, usage and what is running there. */
function Fleet({ running }: { running: DashboardData['running'] }) {
  const health = useServerHealth();
  const servers = [...health.servers].sort((a, b) => Number(!!b.fault) - Number(!!a.fault) || Number(a.online) - Number(b.online));
  return <ul className="divide-y border-t">
    <li aria-hidden="true" className="flex justify-end px-5 py-2 text-[11px] text-muted-foreground sm:px-6"><span className={usageColumns}><span className="text-right">CPU</span><span className="text-right">{t('metrics.memoryShort')}</span><span className="text-right">{t('metrics.diskShort')}</span></span></li>
    {servers.map(server => {
    const active = running[server.id];
    return <li key={server.id}><Link href={'/servers/' + server.id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/35 sm:px-6">
      <Dot tone={server.fault ? 'danger' : server.online ? 'success' : 'neutral'} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5"><OsIcon os={server.os} className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate text-sm font-medium">{server.name}</span>{server.fault && <AlertTriangle className="size-3.5 shrink-0 text-danger" />}</span>
        <span className="block truncate text-xs text-muted-foreground">{!server.online ? server.lastSeen ? t('dashboard.offlineSince', { time: formatRelative(server.lastSeen) }) : t('servers.pendingRegistration')
          : active ? t('dashboard.fleetRunning', { jobs: active.jobs, terminals: active.terminals }) : server.hostname}</span>
      </span>
      {server.online && server.metrics ? <span className={usageColumns}><UsageCell label="CPU" value={server.metrics.cpu} /><UsageCell label={t('metrics.memoryShort')} value={server.metrics.memPct} /><UsageCell label={t('metrics.diskShort')} value={server.metrics.diskPct} /></span>
        : <span className="text-xs text-muted-foreground">{server.online ? t('dashboard.noMetrics') : ''}</span>}
    </Link></li>;
  })}</ul>;
}

export function Dashboard() {
  const [days, setDays] = useState<'7' | '14' | '30'>('14');
  const { timeZone } = usePreferences();
  const result = useApi<DashboardData>(`/api/dashboard?days=${days}&tzOffset=${displayOffsetMinutes()}&tz=${timeZone}`, { refreshOn: ['jobs', 'approvals'], interval: 60_000 });
  const health = useServerHealth();
  const approvals = usePendingApprovals().data;
  const [register, setRegister] = useState(false);
  const data = result.data;
  const acknowledgeFailures = async () => {
    try { await post('/api/dashboard/failures/acknowledge'); result.refresh(); }
    catch (cause) { toast.error(errorMessage(cause)); }
  };
  const oldest = approvals?.items.at(-1);
  const failureRate = data?.mcp.summary.requests ? Math.round((data.mcp.summary.errors / data.mcp.summary.requests) * 1000) / 10 : 0;
  return <div className="page-stack">
    <PageHeading title={t('dashboard.title')} description={t('dashboard.description')} action={<Button onClick={() => setRegister(true)}><Plus />{t('servers.register')}</Button>} />
    <ErrorNotice message={result.error} retry={result.refresh} />
    {!data ? result.loading ? <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-32 rounded-xl" />)}</div> : null : <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Metric href="/servers" icon={ServerIcon} label={t('dashboard.servers')} value={<>{health.online.length}<span className="text-lg text-muted-foreground">/{health.servers.length}</span></>}
          detail={health.offline.length ? t('dashboard.serversOffline', { n: health.offline.length }) : t('dashboard.serversAllOnline')} />
        <Metric href="/approvals" icon={ShieldAlert} label={t('dashboard.pendingApprovals')} value={formatNumber(approvals?.pending ?? 0)} tone={approvals?.pending ? 'warning' : undefined}
          detail={oldest ? t('dashboard.pendingApprovalsOldest', { time: formatRelative(oldest.createdAt) }) : t('dashboard.noPendingApprovals')} />
        <Metric href="/jobs?status=running" icon={Activity} label={t('dashboard.runningJobs')} value={formatNumber(data.runningJobs)} detail={t('dashboard.runningDetail', { n: data.activeTerminals })} />
        <Metric href="/request-logs" icon={ScrollText} label={t('dashboard.mcpRequests')} value={formatNumber(data.mcp.summary.requests)}
          detail={data.mcp.summary.requests ? t('dashboard.mcpRequestsHint', { rate: failureRate, held: data.mcp.summary.held }) : t('dashboard.noMcp24h')} />
      </div>
      <Attention failed={data.unacknowledgedFailures24h} onAcknowledgeFailures={() => void acknowledgeFailures()} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title={t('dashboard.aiActivity')} description={t('dashboard.aiActivityHint')} action={<Segmented label={t('dashboard.range')} value={days} onChange={setDays} options={(['7', '14', '30'] as const).map(value => ({ value, label: t('dashboard.days', { n: value }) }))} />} />
            <McpChart data={data.mcp.days} />
          </Card>
          <Card>
            <CardHeader title={t('dashboard.recentCalls')} description={t('dashboard.recentCallsHint')} action={<Button variant="outline" size="sm" asChild><Link href="/request-logs">{t('dashboard.allRequests')}<ArrowRight /></Link></Button>} />
            <RecentCalls calls={data.mcp.latest} />
          </Card>
        </div>
        <div className="min-w-0 space-y-5"><Card>
          <CardHeader title={t('dashboard.fleet')} action={<Button variant="ghost" size="sm" asChild><Link href="/servers">{t('common.viewAll')}<ArrowRight /></Link></Button>} />
          {health.servers.length ? <Fleet running={data.running} /> : <Empty className="py-6" title={t('servers.emptyTitle')} description={t('servers.emptyDescription')} icon={<ServerIcon className="size-5" />} action={<Button variant="outline" onClick={() => setRegister(true)}><Plus />{t('servers.register')}</Button>} />}
        </Card>
        <Card>
          <CardHeader title={t('dashboard.clients')} description={t('dashboard.clientsHint')} />
          <Clients clients={data.mcp.clients} />
        </Card></div>
      </div>
    </>}
    <ServerRegister open={register} onOpenChange={setRegister} />
  </div>;
}
