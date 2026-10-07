import { AlertTriangle, ArrowUpRight, ChevronLeft, ChevronRight, Info, RefreshCw, ScrollText, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Card, CardHeader, CopyButton, Details, Empty, ErrorNotice, Input, Loading, PageHeading, Segmented, Select, Status, Time } from '../components/ui';
import { formatNumber, t, type MessageKey } from '../i18n';
import { formatBytes, useApi } from '../lib/api';
import { useServers } from '../lib/app-data';
import { Link, useQueryState } from '../lib/router';
import { fromDateTimeInput, toDateTimeInput } from '../lib/time';
import type { RequestLog, RequestLogCollection, RequestLogDetail, RequestLogList, RequestOutcome } from '../lib/types';

const PAGE_SIZE = 50;
const outcomeTone: Record<RequestOutcome, 'neutral' | 'success' | 'danger' | 'warning'> = { pending: 'neutral', success: 'success', error: 'danger', unknown: 'warning' };
const tools = ['servers_list', 'server_metrics', 'job_start', 'jobs_list', 'job_status', 'job_output', 'job_input', 'job_cancel', 'file_list', 'file_read', 'image_read', 'file_search', 'file_write', 'file_edit', 'file_delete', 'file_upload', 'file_download', 'file_transfer_status', 'file_transfer_cancel'];
const periods = { '1h': 3600_000, '24h': 86400_000, '7d': 7 * 86400_000 } as const;
type Period = keyof typeof periods | 'custom';

function label(group: 'stage' | 'eventStatus', value: string) {
  const key = `requestLogs.${group}.${value}` as MessageKey;
  const text = t(key);
  return text === key ? value : text;
}

function Outcome({ outcome }: { outcome: RequestOutcome }) {
  return <Badge tone={outcomeTone[outcome]}>{t(`requestLogs.outcome.${outcome}`)}</Badge>;
}

function CollectionStatus({ collection }: { collection?: RequestLogCollection }) {
  if (!collection) return null;
  if (collection.status === 'degraded') return <div role="alert" className="flex items-start gap-3 rounded-lg border tone-danger p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>{t('requestLogs.degraded', { n: formatNumber(collection.failedWrites) })}{collection.lastErrorAt && <> · <Time value={collection.lastErrorAt} /></>}</p></div>;
  return <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge tone="success">{t('requestLogs.collecting')}</Badge>{t('requestLogs.collectingSince')} <Time value={collection.startedAt} /></p>;
}

function summary(request: RequestLog) {
  if (request.arguments && typeof request.arguments === 'object') {
    const args = request.arguments as Record<string, unknown>;
    return [args.cmd, args.path].filter(value => typeof value === 'string').join(' · ');
  }
  return '';
}
const title = (request: RequestLog) => request.tool || request.method || request.httpMethod + ' ' + request.httpPath;
const detailHref = (request: RequestLog) => '/request-logs/' + encodeURIComponent(request.traceId);
const duration = (request: RequestLog) => request.durationMs === undefined ? '—' : formatNumber(request.durationMs) + ' ms';

function ResultCell({ request }: { request: RequestLog }) {
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-1.5"><Outcome outcome={request.outcome} />{request.incomplete && <Badge tone="warning">{t('requestLogs.incomplete')}</Badge>}</div>
    <p className="text-xs text-muted-foreground">{[request.httpStatus !== undefined && 'HTTP ' + request.httpStatus, request.mcpIsError && t('requestLogs.toolError'), request.jsonRpcErrorCode !== undefined && 'JSON-RPC ' + request.jsonRpcErrorCode].filter(Boolean).join(' · ')}</p>
  </div>;
}

export function RequestLogs({ id }: { id?: string }) {
  if (id) return <RequestDetail key={id} id={id} />;
  return <RequestLogList />;
}

function RequestLogList() {
  const servers = useServers();
  const [query, setQuery] = useQueryState();
  const period = (query.get('period') as Period | null) ?? '24h';
  const server = query.get('server') ?? '', outcome = query.get('outcome') ?? '', tool = query.get('tool') ?? '', search = query.get('q') ?? '';
  const customFrom = query.get('from') ?? '', customTo = query.get('to') ?? '';
  const [draft, setDraft] = useState(search);
  // Follow outside URL changes (sidebar link, back button) so the debounce does not write an old query back.
  useEffect(() => setDraft(search), [search]);
  const [tick, setTick] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => { const timer = setTimeout(() => { if (draft !== search) setQuery({ q: draft }); }, 400); return () => clearTimeout(timer); }, [draft, search, setQuery]);
  const filterKey = [period, server, outcome, tool, search, customFrom, customTo].join('|');
  useEffect(() => setCursors([]), [filterKey]);
  // Preset ranges are fixed when chosen or refreshed, so polling keeps the same window start.
  const range = useMemo(() => period === 'custom' ? { from: customFrom, to: customTo } : { from: new Date(Date.now() - periods[period]).toISOString(), to: '' }, [period, customFrom, customTo, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalidRange = period === 'custom' && (!range.from || (range.to && range.from > range.to));
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (range.from) params.set('from', range.from); if (range.to) params.set('to', range.to);
  for (const [key, value] of [['serverId', server], ['outcome', outcome], ['tool', tool], ['q', search]]) if (value) params.set(key, value);
  const cursor = cursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  const result = useApi<RequestLogList>(invalidRange ? null : '/api/request-logs?' + params, cursor ? 0 : 5000);
  const items = result.data?.items;
  const setPeriod = (value: Period) => setQuery(value === 'custom'
    ? { period: value, from: range.from || new Date(Date.now() - periods['24h']).toISOString(), to: undefined }
    : { period: value === '24h' ? undefined : value, from: undefined, to: undefined });
  const refresh = () => { setTick(value => value + 1); setCursors([]); result.refresh(); };
  return <div className="page-stack">
    <PageHeading title={t('requestLogs.title')} description={t('requestLogs.description')} action={<Button variant="outline" onClick={refresh} disabled={result.loading}><RefreshCw />{t('requestLogs.refresh')}</Button>} />
    <CollectionStatus collection={result.data?.collection} />
    <ErrorNotice message={result.error} retry={result.refresh} />
    <Card>
      <div className="space-y-3 border-b p-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label={t('requestLogs.search')} className="pl-9" value={draft} onChange={event => setDraft(event.target.value)} placeholder={t('requestLogs.searchPlaceholder')} /></div>
          <Segmented label={t('requestLogs.period')} value={period} onChange={setPeriod} options={(['1h', '24h', '7d', 'custom'] as const).map(value => ({ value, label: t(`requestLogs.period_${value}`) }))} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label={t('requestLogs.server')} value={server} onChange={event => setQuery({ server: event.target.value })}><option value="">{t('jobs.allServers')}</option>{servers.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
          <Select aria-label={t('requestLogs.tool')} value={tool} onChange={event => setQuery({ tool: event.target.value })}><option value="">{t('requestLogs.allTools')}</option>{tools.map(name => <option key={name} value={name}>{name}</option>)}</Select>
          <Select aria-label={t('requestLogs.result')} value={outcome} onChange={event => setQuery({ outcome: event.target.value })}><option value="">{t('requestLogs.allResults')}</option>{(['success', 'error', 'unknown', 'pending'] as const).map(value => <option key={value} value={value}>{t(`requestLogs.outcome.${value}`)}</option>)}</Select>
          {period === 'custom' && <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input type="datetime-local" step="1" className="w-auto" aria-label={t('requestLogs.from')} value={toDateTimeInput(customFrom)} onChange={event => setQuery({ from: fromDateTimeInput(event.target.value) })} />
            <span className="text-muted-foreground">–</span>
            <Input type="datetime-local" step="1" className="w-auto" aria-label={t('requestLogs.to')} value={toDateTimeInput(customTo)} onChange={event => setQuery({ to: fromDateTimeInput(event.target.value) })} />
          </div>}
        </div>
        {invalidRange && <ErrorNotice message={t('requestLogs.invalidRange')} />}
      </div>
      {!items ? result.loading ? <Loading label={t('requestLogs.loading')} /> : null : !items.length ? <Empty title={t('requestLogs.emptyTitle')} description={t('requestLogs.emptyDescription')} icon={<ScrollText className="size-5" />} /> : <>
        <div className="hidden overflow-x-auto md:block"><table className="data-table">
          <thead><tr><th>{t('requestLogs.receivedAt')}</th><th>{t('requestLogs.request')}</th><th>{t('requestLogs.server')}</th><th>{t('requestLogs.result')}</th><th>{t('requestLogs.duration')}</th><th><span className="sr-only">{t('requestLogs.detail')}</span></th></tr></thead>
          <tbody>{items.map(request => <tr key={request.traceId}>
            <td className="text-xs text-muted-foreground"><Time value={request.receivedAt} /></td>
            <td className="max-w-[440px]"><Link className="block truncate font-mono text-xs font-medium hover:underline" href={detailHref(request)}>{title(request)}</Link><p className="mt-1 truncate text-xs text-muted-foreground" title={summary(request)}>{summary(request) || request.clientName || request.traceId}</p>{request.error && <p className="mt-1 truncate text-xs text-danger" title={request.error}>{request.errorCode ? String(request.errorCode) + ' · ' : ''}{request.error}</p>}</td>
            <td><p className="text-xs">{request.serverName || request.serverId || '—'}</p>{request.executionUser && <p className="mt-1 font-mono text-xs text-muted-foreground">{request.executionUser}</p>}</td>
            <td><ResultCell request={request} /></td>
            <td className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{duration(request)}</td>
            <td><Button variant="ghost" size="icon-sm" asChild><Link href={detailHref(request)} aria-label={t('requestLogs.detailFor', { id: request.traceId })}><ArrowUpRight /></Link></Button></td>
          </tr>)}</tbody>
        </table></div>
        <ul className="divide-y md:hidden">{items.map(request => <li key={request.traceId}><Link href={detailHref(request)} className="block space-y-1.5 px-4 py-3 hover:bg-muted/35">
          <div className="flex items-center justify-between gap-3"><span className="truncate font-mono text-xs font-medium">{title(request)}</span><Outcome outcome={request.outcome} /></div>
          {summary(request) && <p className="truncate text-xs text-muted-foreground">{summary(request)}</p>}
          {request.error && <p className="truncate text-xs text-danger">{request.error}</p>}
          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"><Time value={request.receivedAt} relative />{request.serverName && <span>{request.serverName}</span>}<span>{duration(request)}</span></div>
        </Link></li>)}</ul>
      </>}
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5"><span>{t('requestLogs.pageSummary', { page: cursors.length + 1, n: items?.length ?? 0 })}</span><div className="flex gap-1"><Button variant="outline" size="icon-sm" disabled={!cursors.length || result.loading} onClick={() => setCursors(values => values.slice(0, -1))} aria-label={t('common.previousPage')}><ChevronLeft /></Button><Button variant="outline" size="icon-sm" disabled={!result.data?.nextCursor || result.loading} onClick={() => { if (result.data?.nextCursor) setCursors(values => [...values, result.data!.nextCursor!]); }} aria-label={t('common.nextPage')}><ChevronRight /></Button></div></div>
    </Card>
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{t('requestLogs.scope')}</p>
  </div>;
}

function JsonValue({ value }: { value: unknown }) {
  return <pre className="max-h-96 overflow-auto rounded-lg bg-muted/60 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{value === undefined ? t('requestLogs.noRecord') : JSON.stringify(value, null, 2)}</pre>;
}

function RequestDetail({ id }: { id: string }) {
  const result = useApi<RequestLogDetail>('/api/request-logs/' + encodeURIComponent(id), 5000);
  const detail = result.data, request = detail?.request;
  const back = { href: '/request-logs', label: t('requestLogs.title') };
  if (!detail || !request) return <div className="page-stack"><PageHeading back={back} title={t('requestLogs.detailTitle')} /><ErrorNotice message={result.error} retry={result.refresh} />{result.loading && <Loading />}</div>;
  const technical: [string, ReactNode][] = [
    [t('requestLogs.traceId'), <span className="flex items-center gap-1"><span className="min-w-0 break-all font-mono text-xs">{request.traceId}</span><CopyButton value={request.traceId} size="icon-sm" variant="ghost" /></span>],
    [t('requestLogs.httpRequest'), request.httpMethod + ' ' + request.httpPath], [t('requestLogs.httpStatus'), request.httpStatus], ['MCP isError', request.mcpIsError === undefined ? undefined : String(request.mcpIsError)],
    [t('requestLogs.rpcMethod'), request.method], [t('requestLogs.rpcId'), request.rpcId], [t('requestLogs.rpcErrorCode'), request.jsonRpcErrorCode],
    [t('requestLogs.errorCode'), request.errorCode], [t('requestLogs.failureStage'), request.failureStage ? label('stage', request.failureStage) : undefined],
    [t('requestLogs.requestId'), request.requestId], [t('requestLogs.serverId'), request.serverId], [t('requestLogs.clientId'), request.clientId], [t('requestLogs.subject'), request.subject], ['User-Agent', request.userAgent],
  ];
  return <div className="page-stack">
    <PageHeading back={back} title={<span className="flex items-center gap-3"><span className="truncate font-mono text-xl">{title(request)}</span><Outcome outcome={request.outcome} /></span>}
      description={<><Time value={request.receivedAt} /> · {duration(request)}</>}
      action={<Button variant="outline" onClick={result.refresh} disabled={result.loading}><RefreshCw />{t('requestLogs.refresh')}</Button>} />
    <ErrorNotice message={result.error} retry={result.refresh} />
    {detail.collection.status === 'degraded' && <CollectionStatus collection={detail.collection} />}
    {request.incomplete && <div role="alert" className="rounded-lg border tone-warning p-4 text-sm"><p className="font-medium">{t('requestLogs.incomplete')}</p><p className="mt-1 leading-relaxed">{t('requestLogs.incompleteHint')}</p></div>}
    <ErrorNotice message={request.error} />
    <Card className="p-5 sm:p-6"><Details className="lg:grid-cols-4" items={[
      [t('requestLogs.receivedAt'), <Time value={request.receivedAt} />], [t('requestLogs.duration'), duration(request)],
      [t('requestLogs.server'), request.serverId ? <Link href={'/servers/' + request.serverId} className="hover:underline">{request.serverName || request.serverId}</Link> : '—'], [t('servers.account'), request.executionUser],
      [t('requestLogs.client'), request.clientName], [t('requestLogs.result'), <ResultCell request={request} />],
    ]} /></Card>
    {(request.jobId || detail.job || request.transferId || detail.transfer) && <Card><CardHeader title={t('requestLogs.linked')} description={t('requestLogs.linkedHint')} /><div className="space-y-5 px-5 pb-5 sm:px-6 sm:pb-6">
      {(request.jobId || detail.job) && <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">{t('requestLogs.job')}</span>{detail.job && <Status status={detail.job.status} />}<Button variant="outline" size="sm" asChild><Link href={'/jobs/' + encodeURIComponent(detail.job?.id || request.jobId!)}>{t('requestLogs.viewJobOutput')}<ArrowUpRight /></Link></Button></div>
        {detail.job ? <Details className="lg:grid-cols-4" items={[[t('jobs.exitCode'), detail.job.exitCode], [t('jobDetail.output'), formatBytes(detail.job.outputBytes)], [t('jobDetail.ended'), <Time value={detail.job.endedAt} />]]} /> : <p className="text-xs text-muted-foreground">{t('requestLogs.jobMissing')}</p>}</div>}
      {(request.transferId || detail.transfer) && <div className="space-y-3"><p className="text-sm font-medium">{t('requestLogs.transfer')}</p><Details className="lg:grid-cols-4" items={[
        [t('requestLogs.transferId'), detail.transfer?.transferId || request.transferId], [t('jobs.status'), detail.transfer ? <Status status={detail.transfer.status} /> : undefined],
        [t('requestLogs.transferred'), detail.transfer ? formatBytes(detail.transfer.bytes) + (detail.transfer.size === undefined ? '' : ' / ' + formatBytes(detail.transfer.size)) : undefined], [t('requestLogs.errorCode'), detail.transfer?.errorCode],
      ]} /><ErrorNotice message={detail.transfer?.error} /></div>}
    </div></Card>}
    <div className="grid gap-5 xl:grid-cols-2"><Card className="min-w-0"><CardHeader title={t('requestLogs.arguments')} description={t('requestLogs.argumentsHint')} /><div className="px-5 pb-5 sm:px-6 sm:pb-6"><JsonValue value={request.arguments} /></div></Card><Card className="min-w-0"><CardHeader title={t('requestLogs.resultSummary')} description={t('requestLogs.resultSummaryHint')} /><div className="px-5 pb-5 sm:px-6 sm:pb-6"><JsonValue value={request.result} /></div></Card></div>
    <Card><CardHeader title={t('requestLogs.stages')} description={t('requestLogs.stagesHint')} />{!detail.events.length ? <Empty title={t('requestLogs.noStages')} /> : <ol className="space-y-5 px-5 pb-5 sm:px-6 sm:pb-6">{detail.events.map(event => <li key={event.seq} className="relative border-l pl-5"><span className={'absolute top-1.5 -left-1 size-2 rounded-full ' + (event.status === 'error' ? 'bg-danger' : 'bg-muted-foreground/60')} /><div className="mb-2 flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{label('stage', event.stage)}</span><Badge tone={event.status === 'error' ? 'danger' : 'neutral'}>{label('eventStatus', event.status)}</Badge><Time value={event.at} className="text-xs text-muted-foreground" /></div>{event.data !== undefined && <JsonValue value={event.data} />}</li>)}</ol>}</Card>
    <Card><details className="group"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 text-sm font-semibold sm:px-6">{t('requestLogs.technical')}<ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" /></summary><div className="px-5 pb-5 sm:px-6 sm:pb-6"><Details className="lg:grid-cols-3" items={technical} /></div></details></Card>
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{t('requestLogs.responseScope')}</p>
  </div>;
}

