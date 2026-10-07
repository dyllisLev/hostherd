import { Activity, AlertTriangle, ArrowRight, Gauge, LayoutGrid, Plus, Server as ServerIcon, TerminalSquare, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { OsIcon, osName } from '../components/brand';
import { JobTable, Pager } from '../components/job-table';
import { NewTerminalDialog } from '../components/new-terminal';
import { CurrentUsage, ResourceTab } from '../components/resource-charts';
import { ServerMenu, useServerActions } from '../components/server-actions';
import { CommandBlock } from '../components/server-register';
import { Badge, Button, Card, CardHeader, CopyButton, Details, Empty, ErrorNotice, Loading, PageHeading, Status, Tabs, TabsContent, TabsList, TabsTrigger, Time } from '../components/ui';
import { t } from '../i18n';
import { useApi } from '../lib/api';
import { useServerHealth, useServers } from '../lib/app-data';
import { Link, navigate, useQueryState } from '../lib/router';
import { agentRestartCommand, agentStatusCommand } from '../lib/recovery';
import { formatDateTime } from '../lib/time';
import type { JobPage, Server } from '../lib/types';
import { LastSeen, ServerVersion } from './servers';

const PAGE_SIZE = 20;

function ServerJobs({ server }: { server: Server }) {
  const [page, setPage] = useState(0);
  const jobs = useApi<JobPage>(`/api/jobs?kind=job&serverId=${server.id}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { refreshOn: ['jobs'] });
  return <Card>
    <ErrorNotice message={jobs.error} retry={jobs.refresh} />
    {!jobs.data ? jobs.loading ? <Loading /> : null : <><JobTable jobs={jobs.data.items} showServer={false} empty={<Empty title={t('serverDetail.noJobs')} description={t('serverDetail.noJobsHint')} icon={<Activity className="size-5" />} />} />{jobs.data.total > PAGE_SIZE && <Pager page={page} pageSize={PAGE_SIZE} total={jobs.data.total} onChange={setPage} />}</>}
  </Card>;
}

function ServerTerminals({ server, onCreate }: { server: Server; onCreate: () => void }) {
  const sessions = useApi<JobPage>(`/api/jobs?kind=terminal&serverId=${server.id}&limit=50`, { refreshOn: ['jobs'] });
  const items = sessions.data?.items ?? [];
  return <Card>
    <ErrorNotice message={sessions.error} retry={sessions.refresh} />
    {!sessions.data ? sessions.loading ? <Loading /> : null : !items.length ? <Empty title={t('serverDetail.noTerminals')} description={t('serverDetail.noTerminalsHint')} icon={<TerminalSquare className="size-5" />} action={<Button variant="outline" disabled={!server.online} onClick={onCreate}><Plus />{t('terminals.new')}</Button>} /> :
      <ul className="divide-y">{items.map(session => <li key={session.id}><Link href={'/terminals/' + session.id} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/35">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{session.path}</span>
        <Time value={session.startedAt} relative className="hidden text-xs text-muted-foreground sm:inline" />
        <Status status={session.status} />
      </Link></li>)}</ul>}
  </Card>;
}

/** Offline server that had connected before: commands to run on the target. */
function OfflineRecovery({ server }: { server: Server }) {
  const admin = server.os === 'windows' ? t('serverDetail.offlineRunWindows') : t('serverDetail.offlineRun');
  return <div role="status" className="flex items-start gap-3 rounded-lg border tone-warning p-4 text-sm">
    <WifiOff className="mt-0.5 size-4 shrink-0" />
    <div className="min-w-0 flex-1 space-y-3">
      <div>
        <p className="font-medium">{t('serverDetail.offlineTitle')}{server.lastSeen && <span className="font-normal"> · {t('servers.lastSeen')} <Time value={server.lastSeen} relative /></span>}</p>
        <p className="mt-1 leading-relaxed">{t('serverDetail.offlineHint')}</p>
      </div>
      <CommandBlock label={t('serverDetail.offlineStatus') + ' · ' + admin} command={agentStatusCommand(server.os)} />
      <CommandBlock label={t('serverDetail.offlineRestart') + ' · ' + admin} command={agentRestartCommand(server.os)} />
      <p className="text-xs leading-relaxed">{t('serverDetail.offlineUnreachable')}</p>
    </div>
  </div>;
}

function Overview({ server, onTab }: { server: Server; onTab: (tab: string) => void }) {
  const health = useServerHealth();
  const recent = useApi<JobPage>(`/api/jobs?kind=job&serverId=${server.id}&limit=5`, { refreshOn: ['jobs'] });
  const terminals = useApi<JobPage>(`/api/jobs?kind=terminal&serverId=${server.id}&status=running&limit=1`, { refreshOn: ['jobs'] });
  const running = useApi<JobPage>(`/api/jobs?kind=job&serverId=${server.id}&status=running&limit=1`, { refreshOn: ['jobs'] });
  return <div className="space-y-5">
    <CurrentUsage server={server} />
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card className="min-w-0">
        <CardHeader title={t('serverDetail.recentJobs')} action={<Button variant="ghost" size="sm" onClick={() => onTab('jobs')}>{t('common.viewAll')}<ArrowRight /></Button>} />
        <ErrorNotice message={recent.error} retry={recent.refresh} />
        {!recent.data ? recent.loading ? <Loading /> : null : <JobTable jobs={recent.data.items} showServer={false} empty={<Empty title={t('serverDetail.noJobs')} description={t('serverDetail.noJobsHint')} icon={<Activity className="size-5" />} />} />}
      </Card>
      <Card className="h-fit">
        <CardHeader title={t('serverDetail.system')} />
        <div className="px-5 pb-5 sm:px-6 sm:pb-6"><Details items={[
          [t('serverDetail.hostname'), server.hostname || '—'],
          [t('serverDetail.platform'), server.os ? `${osName(server.os)} · ${server.arch}` : '—'],
          [t('servers.account'), <Badge className="font-mono font-normal">{server.executionUser}</Badge>],
          [t('servers.agent'), <ServerVersion server={server} outdated={health.outdated(server)} latest={health.latest} />],
          [t('serverDetail.runningJobs'), <span className="tabular-nums">{running.data?.total ?? '—'}</span>],
          [t('serverDetail.activeTerminals'), <span className="tabular-nums">{terminals.data?.total ?? '—'}</span>],
          [t('serverDetail.registered'), formatDateTime(server.createdAt)],
          [t('servers.lastSeen'), <LastSeen server={server} />],
        ]} />
        <div className="mt-4 border-t pt-4"><p className="mb-1 text-xs text-muted-foreground">{t('serverDetail.serverId')}</p><span className="flex items-center gap-1"><span className="min-w-0 truncate font-mono text-xs">{server.id}</span><CopyButton value={server.id} size="icon-sm" variant="ghost" /></span></div></div>
      </Card>
    </div>
  </div>;
}

export function ServerDetail({ id }: { id: string }) {
  const servers = useServers();
  const health = useServerHealth();
  const [query, setQuery] = useQueryState();
  const [creating, setCreating] = useState(false);
  const actions = useServerActions({ afterDelete: () => navigate('/servers') });
  const server = servers.data?.find(item => item.id === id);
  const tab = query.get('tab') ?? 'overview';
  const back = { href: '/servers', label: t('servers.title') };
  if (!server) return <div className="page-stack"><PageHeading title={t('serverDetail.title')} back={back} />{servers.data ? <Card><Empty title={t('serverDetail.notFound')} description={t('serverDetail.notFoundHint')} icon={<ServerIcon className="size-5" />} /></Card> : <><ErrorNotice message={servers.error} retry={servers.refresh} />{servers.loading && <Loading />}</>}{actions.dialogs}</div>;
  return <div className="page-stack">
    <PageHeading back={back}
      title={<span className="flex items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground"><OsIcon os={server.os} className="size-5" /></span><span className="truncate">{server.name}</span><Status status={server.online ? 'online' : 'offline'} /></span>}
      description={<span className="ml-[52px] block">{[server.hostname, server.os && `${osName(server.os)} ${server.arch}`, server.executionUser].filter(Boolean).join(' · ')}</span>}
      action={<><Button disabled={!server.online} onClick={() => setCreating(true)}><TerminalSquare />{t('terminals.new')}</Button><ServerMenu server={server} onAction={actions.open} detail={false} /></>} />
    <ErrorNotice message={actions.error} />
    {server.fault && <div role="alert" className="flex items-start gap-3 rounded-lg border tone-danger p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1"><p className="font-medium">{t('serverDetail.faultTitle')}</p><p className="mt-1 break-words">{server.fault}</p></div>
      <Button size="sm" variant="outline" onClick={() => actions.clearFault(server)}>{t('servers.acknowledge')}</Button>
    </div>}
    {!server.online && server.os && <OfflineRecovery server={server} />}
    {health.outdated(server) && server.online && <div className="flex flex-wrap items-center gap-3 rounded-lg border tone-info p-3 text-sm">
      <p className="min-w-0 flex-1">{t('serverDetail.updateBanner', { current: server.version, latest: health.latest ?? '' })}</p>
      <Button size="sm" variant="outline" onClick={() => actions.open(server, 'update')}>{t('servers.update')}</Button>
    </div>}
    <Tabs value={tab} onValueChange={value => setQuery({ tab: value === 'overview' ? undefined : value, range: undefined })}>
      <TabsList className="mb-5">
        <TabsTrigger value="overview"><LayoutGrid />{t('serverDetail.tabOverview')}</TabsTrigger>
        <TabsTrigger value="resources"><Gauge />{t('serverDetail.tabResources')}</TabsTrigger>
        <TabsTrigger value="jobs"><Activity />{t('serverDetail.tabJobs')}</TabsTrigger>
        <TabsTrigger value="terminals"><TerminalSquare />{t('serverDetail.tabTerminals')}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview"><Overview server={server} onTab={value => setQuery({ tab: value })} /></TabsContent>
      <TabsContent value="resources"><ResourceTab server={server} /></TabsContent>
      <TabsContent value="jobs"><ServerJobs server={server} /></TabsContent>
      <TabsContent value="terminals"><ServerTerminals server={server} onCreate={() => setCreating(true)} /></TabsContent>
    </Tabs>
    <NewTerminalDialog serverFilter={server.id} open={creating} onOpenChange={setCreating} />
    {actions.dialogs}
  </div>;
}
