import { AlertTriangle, ArrowUpCircle, Plus, Search, Server as ServerIcon } from 'lucide-react';
import { useState } from 'react';
import { OsIcon, osName } from '../components/brand';
import { BulkUpdate } from '../components/bulk-update';
import { ServerMenu, useServerActions } from '../components/server-actions';
import { ServerRegister } from '../components/server-register';
import { ServerUsage } from '../components/usage';
import { Badge, Button, Card, Empty, ErrorNotice, Input, Loading, PageHeading, Segmented, Status, Time, Tooltip } from '../components/ui';
import { t } from '../i18n';
import { useServerHealth, useServers } from '../lib/app-data';
import { Link, navigate, useQueryState } from '../lib/router';
import type { Server } from '../lib/types';

type Filter = 'all' | 'online' | 'offline' | 'attention';

export function ServerVersion({ server, outdated, latest }: { server: Server; outdated: boolean; latest?: string | null }) {
  return <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">{server.version || '—'}
    {outdated && <Tooltip content={t('servers.updateAvailableHint', { version: latest ?? '' })}><span><Badge tone="info"><ArrowUpCircle className="size-3" />{latest}</Badge></span></Tooltip>}
  </span>;
}

export function LastSeen({ server }: { server: Server }) {
  return server.online ? <span className="text-xs text-muted-foreground">{t('servers.connectedNow')}</span> : <Time value={server.lastSeen} relative className="text-xs text-muted-foreground" />;
}

export function FaultLine({ server, onClear }: { server: Server; onClear: () => void }) {
  if (!server.fault) return null;
  return <div className="mt-1.5 flex max-w-md items-start gap-1.5 text-xs text-danger">
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
    <Tooltip content={server.fault}><p className="line-clamp-1 min-w-0 break-all">{server.fault}</p></Tooltip>
    <button type="button" className="relative z-10 shrink-0 font-medium underline underline-offset-2" onClick={onClear} aria-label={t('servers.acknowledgeFor', { name: server.name })}>{t('servers.acknowledge')}</button>
  </div>;
}

export function Servers() {
  const servers = useServers();
  const health = useServerHealth();
  const [query, setQuery] = useQueryState();
  const [register, setRegister] = useState(query.get('new') === '1');
  const actions = useServerActions();
  const search = query.get('q') ?? '';
  const filter = (query.get('filter') as Filter | null) ?? 'all';
  const matches = (server: Server) => (server.name + ' ' + server.hostname + ' ' + server.executionUser).toLowerCase().includes(search.toLowerCase())
    && (filter === 'all' || (filter === 'online' ? server.online : filter === 'offline' ? !server.online : !server.online || !!server.fault || health.outdated(server)));
  const visible = servers.data?.filter(matches);
  const openRegister = (open: boolean) => { setRegister(open); if (!open && query.get('new')) setQuery({ new: undefined }); };
  const counts: Record<Filter, number> = { all: health.servers.length, online: health.online.length, offline: health.offline.length, attention: health.servers.filter(server => !server.online || server.fault || health.outdated(server)).length };
  return <div className="page-stack">
    <PageHeading title={t('servers.title')} description={t('servers.description')} action={<><BulkUpdate /><Button onClick={() => openRegister(true)}><Plus />{t('servers.register')}</Button></>} />
    <ErrorNotice message={servers.error ?? actions.error} retry={servers.error ? servers.refresh : undefined} />
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b p-4 sm:px-5">
        <div className="relative w-full sm:max-w-xs"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label={t('servers.search')} className="pl-9" placeholder={t('servers.searchPlaceholder')} value={search} onChange={event => setQuery({ q: event.target.value })} /></div>
        <Segmented label={t('servers.filter')} value={filter} onChange={value => setQuery({ filter: value === 'all' ? undefined : value })} className="max-w-full overflow-x-auto"
          options={(['all', 'online', 'offline', 'attention'] as const).map(value => ({ value, label: <>{t(`servers.filter_${value}`)} <span className="tabular-nums opacity-60">{counts[value]}</span></> }))} />
      </div>
      {!visible ? servers.loading ? <Loading /> : null : !visible.length ? <Empty title={search || filter !== 'all' ? t('servers.noMatches') : t('servers.emptyTitle')} description={search || filter !== 'all' ? t('servers.noMatchesHint') : t('servers.emptyDescription')} icon={<ServerIcon className="size-5" />} action={!search && filter === 'all' && <Button variant="outline" onClick={() => openRegister(true)}><Plus />{t('servers.register')}</Button>} /> : <>
        <div className="hidden overflow-x-auto md:block"><table className="data-table">
          <thead><tr><th>{t('servers.server')}</th><th>{t('servers.connection')}</th><th className="w-64">{t('servers.resources')}</th><th>{t('servers.account')}</th><th>{t('servers.agent')}</th><th><span className="sr-only">{t('servers.actions')}</span></th></tr></thead>
          <tbody>{visible.map(server => <tr key={server.id} className="relative cursor-pointer" onClick={event => { if (!(event.target as HTMLElement).closest('a,button,[role=menuitem]')) navigate('/servers/' + server.id); }}>
            <td><div className="flex items-start gap-3"><div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground"><OsIcon os={server.os} /></div><div className="min-w-0 max-w-[320px]">
              <Link href={'/servers/' + server.id} className="block truncate font-medium hover:underline">{server.name}</Link>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{server.hostname || t('servers.pendingRegistration')}{server.os ? ' · ' + osName(server.os) + ' ' + server.arch : ''}</div>
              <FaultLine server={server} onClear={() => actions.clearFault(server)} />
            </div></div></td>
            <td><Status status={server.online ? 'online' : 'offline'} />{!server.online && <div className="mt-1"><LastSeen server={server} /></div>}</td>
            <td><ServerUsage metrics={server.metrics} online={server.online} /></td>
            <td><Badge className="font-mono font-normal">{server.executionUser}</Badge></td>
            <td><ServerVersion server={server} outdated={health.outdated(server)} latest={health.latest} /></td>
            <td className="text-right"><ServerMenu server={server} onAction={actions.open} /></td>
          </tr>)}</tbody>
        </table></div>
        <ul className="divide-y md:hidden">{visible.map(server => <li key={server.id} className="flex items-start gap-3 px-4 py-3.5">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground"><OsIcon os={server.os} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><Link href={'/servers/' + server.id} className="truncate font-medium">{server.name}</Link><Status status={server.online ? 'online' : 'offline'} /></div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{server.hostname || t('servers.pendingRegistration')} · <span className="font-mono">{server.executionUser}</span></div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1"><ServerVersion server={server} outdated={health.outdated(server)} latest={health.latest} /><LastSeen server={server} /></div>
            {server.metrics && <ServerUsage metrics={server.metrics} online={server.online} className="mt-2.5" />}
            <FaultLine server={server} onClear={() => actions.clearFault(server)} />
          </div>
          <ServerMenu server={server} onAction={actions.open} />
        </li>)}</ul>
      </>}
    </Card>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('servers.footnote')}</p>
    <ServerRegister open={register} onOpenChange={openRegister} />
    {actions.dialogs}
  </div>;
}
