import { Activity, Gauge, HardDrive, Wifi, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { formatNumber, t } from '../i18n';
import { formatBytes, useApi } from '../lib/api';
import { usePreferences } from '../lib/preferences';
import { useQueryState } from '../lib/router';
import { formatAxisTime, formatFullDateTime, formatUptime } from '../lib/time';
import { type MetricsPoint, type MetricsRange, type Server, type ServerMetrics } from '../lib/types';
import { cn } from '../lib/utils';
import { Card, CardHeader, Empty, ErrorNotice, Loading, Segmented, Time } from './ui';
import { UsageBar, usageTone } from './usage';

const ranges: MetricsRange[] = ['1h', '6h', '24h', '7d', '30d'];
const rate = (value: number | null | undefined) => value === null || value === undefined ? '—' : formatBytes(value) + '/s';
const percentText = (value: number | null | undefined) => value === null || value === undefined ? '—' : formatNumber(Math.round(value * 10) / 10) + '%';
// A sample with no neighbours draws no line segment; mark it so it stays visible.
function isolatedDot(points: MetricsPoint[], key: keyof MetricsPoint, color: string) {
  return (props: { cx?: number; cy?: number; index?: number }) => {
    const { cx, cy, index = 0 } = props;
    const alone = points[index]?.[key] !== null && points[index - 1]?.[key] == null && points[index + 1]?.[key] == null;
    return alone && cx !== undefined && cy !== undefined ? <circle key={index} cx={cx} cy={cy} r={3} fill={color} /> : <g key={index} />;
  };
}
const tooltipStyle = { borderRadius: 8, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--foreground)', fontSize: 12 };

function ChartCard({ title, value, children }: { title: string; value: ReactNode; children: ReactNode }) {
  return <Card className="min-w-0">
    <div className="flex items-baseline justify-between gap-3 px-5 pt-5"><h3 className="text-sm font-medium">{title}</h3><span className="text-sm tabular-nums text-muted-foreground">{value}</span></div>
    <div className="h-44 px-2 pt-3 pb-3">{children}</div>
  </Card>;
}

/** One series over time; gaps where the agent did not report stay empty. */
function SeriesChart({ points, dataKey, long, unit, max }: { points: MetricsPoint[]; dataKey: keyof MetricsPoint; long: boolean; unit: 'percent' | 'load'; max?: number }) {
  const { resolvedTheme } = usePreferences();
  const format = (value: number) => unit === 'percent' ? Math.round(value) + '%' : formatNumber(Math.round(value * 100) / 100);
  return <ResponsiveContainer width="100%" height="100%"><AreaChart key={resolvedTheme} data={points} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
    <defs><linearGradient id={'fill-' + String(dataKey)} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.25} /><stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} /></linearGradient></defs>
    <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
    <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={40} tickMargin={8} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickFormatter={value => formatAxisTime(String(value), long)} />
    <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} domain={max ? [0, max] : [0, 'auto']} ticks={max ? [0, max / 2, max] : undefined} tickFormatter={format} allowDecimals={unit === 'load'} />
    <ChartTooltip contentStyle={tooltipStyle} labelFormatter={value => formatFullDateTime(String(value))} formatter={value => [format(Number(value)), '']} separator="" />
    <Area type="monotone" dataKey={dataKey} stroke="var(--series-1)" strokeWidth={2} fill={`url(#fill-${String(dataKey)})`} connectNulls={false} isAnimationActive={false} dot={isolatedDot(points, dataKey, 'var(--series-1)')} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }} />
  </AreaChart></ResponsiveContainer>;
}

function NetworkChart({ points, long }: { points: MetricsPoint[]; long: boolean }) {
  const { resolvedTheme } = usePreferences();
  const series = [{ key: 'rx', label: t('metrics.received'), color: 'var(--series-1)' }, { key: 'tx', label: t('metrics.sent'), color: 'var(--series-2)' }] as const;
  return <div className="flex h-full flex-col">
    <div className="min-h-0 flex-1"><ResponsiveContainer width="100%" height="100%"><LineChart key={resolvedTheme} data={points} margin={{ top: 6, right: 10, left: 4, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={40} tickMargin={8} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickFormatter={value => formatAxisTime(String(value), long)} />
      <YAxis tickLine={false} axisLine={false} width={72} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickFormatter={value => formatBytes(Number(value))} />
      <ChartTooltip contentStyle={tooltipStyle} labelFormatter={value => formatFullDateTime(String(value))} formatter={(value, name) => [rate(Number(value)), series.find(item => item.key === name)?.label ?? String(name)]} />
      {series.map(item => <Line key={item.key} type="monotone" dataKey={item.key} stroke={item.color} strokeWidth={2} dot={isolatedDot(points, item.key, item.color)} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }} connectNulls={false} isAnimationActive={false} />)}
    </LineChart></ResponsiveContainer></div>
    <div className="flex justify-center gap-4 pt-1 text-xs text-muted-foreground">{series.map(item => <span key={item.key} className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded-full" style={{ background: item.color }} />{item.label}</span>)}</div>
  </div>;
}

/** Placeholder until the agent's first resource sample arrives. */
export function NoMetrics({ server }: { server: Server }) {
  return <Card><Empty icon={<Gauge className="size-5" />} title={t('metrics.noDataTitle')}
    description={server.online ? t('metrics.waiting') : t('metrics.offline')} /></Card>;
}

/** Current usage cards for the overview tab. */
export function CurrentUsage({ server }: { server: Server }) {
  const result = useApi<ServerMetrics>(`/api/servers/${server.id}/metrics?range=1h`, { refreshOn: ['metrics'] });
  const sample = result.data?.latest?.sample;
  if (!sample) return null;
  const mem = sample.memTotal && sample.memUsed !== undefined ? sample.memUsed * 100 / sample.memTotal : null;
  const fullest = [...sample.disks].sort((a, b) => b.used / (b.used + b.avail || 1) - a.used / (a.used + a.avail || 1))[0];
  const disk = fullest ? fullest.used * 100 / (fullest.used + fullest.avail || 1) : null;
  const cards = [
    { label: 'CPU', value: sample.cpu, detail: t('metrics.cores', { n: sample.cpus }) },
    { label: t('metrics.memory'), value: mem, detail: sample.memTotal ? `${formatBytes(sample.memUsed ?? 0)} / ${formatBytes(sample.memTotal)}` : '—' },
    { label: t('metrics.disk'), value: disk, detail: fullest ? `${fullest.mount} · ${formatBytes(fullest.used)} / ${formatBytes(fullest.used + fullest.avail)}` : '—' },
  ];
  return <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
    {cards.map(card => <Card key={card.label} className="min-w-0 p-4 sm:p-5">
      <p className="text-xs text-muted-foreground sm:text-sm">{card.label}</p>
      <p className={cn('mt-2 text-xl font-semibold tabular-nums sm:text-2xl', card.value !== null && card.value !== undefined && usageTone(card.value) === 'danger' && 'text-danger', card.value !== null && card.value !== undefined && usageTone(card.value) === 'warning' && 'text-warning')}>{percentText(card.value)}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground" title={card.detail}>{card.detail}</p>
    </Card>)}
    <Card className="min-w-0 p-4 sm:p-5"><p className="text-xs text-muted-foreground sm:text-sm">{t('metrics.load')}</p><p className="mt-2 text-xl font-semibold tabular-nums sm:text-2xl">{sample.load1 === undefined ? '—' : formatNumber(Math.round(sample.load1 * 100) / 100)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{t('metrics.uptime')} {formatUptime(sample.uptime)}</p></Card>
  </div>;
}

export function ResourceTab({ server }: { server: Server }) {
  const [query, setQuery] = useQueryState();
  const range = (ranges.includes(query.get('range') as MetricsRange) ? query.get('range') : '1h') as MetricsRange;
  const result = useApi<ServerMetrics>(`/api/servers/${server.id}/metrics?range=${range}`, { refreshOn: ['metrics'] });
  const data = result.data;
  if (!data) return result.loading ? <Loading /> : <ErrorNotice message={result.error} retry={result.refresh} />;
  if (!data.latest) return <NoMetrics server={server} />;
  const long = range === '7d' || range === '30d';
  const last = [...data.points].reverse().find(point => point.cpu !== null || point.mem !== null);
  const sample = data.latest.sample;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Segmented label={t('metrics.range')} value={range} onChange={value => setQuery({ range: value === '1h' ? undefined : value })} options={ranges.map(value => ({ value, label: t(`metrics.range_${value}`) }))} />
      <p className="text-xs text-muted-foreground">{t('metrics.lastSample')} <Time value={data.latest.at} relative /> · {t('metrics.interval', { step: data.step < 60 ? t('time.seconds', { n: data.step }) : data.step < 3600 ? t('time.minutes', { m: Math.round(data.step / 60) }) : t('time.hours', { h: Math.round(data.step / 3600) }) })}</p>
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title={t('metrics.cpuUsage')} value={percentText(last?.cpu)}><SeriesChart points={data.points} dataKey="cpu" long={long} unit="percent" max={100} /></ChartCard>
      <ChartCard title={t('metrics.memoryUsage')} value={percentText(last?.mem)}><SeriesChart points={data.points} dataKey="mem" long={long} unit="percent" max={100} /></ChartCard>
      <ChartCard title={t('metrics.diskUsage')} value={percentText(last?.disk)}><SeriesChart points={data.points} dataKey="disk" long={long} unit="percent" max={100} /></ChartCard>
      {sample.load1 !== undefined && <ChartCard title={t('metrics.loadAverage', { n: sample.cpus })} value={last?.load === null || last?.load === undefined ? '—' : formatNumber(last.load)}><SeriesChart points={data.points} dataKey="load" long={long} unit="load" /></ChartCard>}
      <ChartCard title={t('metrics.network')} value={<>↓ {rate(last?.rx)} · ↑ {rate(last?.tx)}</>}><NetworkChart points={data.points} long={long} /></ChartCard>
      <Card className="min-w-0">
        <CardHeader title={t('metrics.availability')} description={t('metrics.availabilityHint')} action={<span className="text-2xl font-semibold tabular-nums">{data.availability.percent === null ? '—' : formatNumber(data.availability.percent) + '%'}</span>} />
        {data.availability.events.length ? <ul className="max-h-32 divide-y overflow-y-auto border-t text-sm">{data.availability.events.map(event => <li key={event.at + event.type} className="flex items-center gap-2.5 px-5 py-2 sm:px-6">
          {event.type === 'online' ? <Wifi className="size-3.5 text-success" /> : <WifiOff className="size-3.5 text-muted-foreground" />}
          <span className="flex-1">{t(event.type === 'online' ? 'metrics.connected' : 'metrics.disconnected')}</span><Time value={event.at} className="text-xs text-muted-foreground" />
        </li>)}</ul> : <p className="border-t px-5 py-4 text-xs text-muted-foreground sm:px-6">{t('metrics.noEvents')}</p>}
      </Card>
    </div>
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><HardDrive className="size-4 text-muted-foreground" />{t('metrics.filesystems')}</span>} description={t('metrics.filesystemsHint')} />
      {!sample.disks.length ? <p className="px-6 pb-6 text-sm text-muted-foreground">—</p> : <ul className="divide-y border-t">{sample.disks.map(disk => {
        const used = disk.used * 100 / (disk.used + disk.avail || 1);
        return <li key={disk.mount} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:px-6">
          <div className="min-w-0"><p className="truncate font-mono text-sm" title={disk.mount}>{disk.mount}</p><p className="text-xs text-muted-foreground">{disk.fs}</p></div>
          <UsageBar label={t('metrics.used')} value={used} className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" />
          <p className="col-start-2 row-start-1 text-right text-xs tabular-nums text-muted-foreground sm:col-start-auto sm:row-start-auto">{formatBytes(disk.used)} / {formatBytes(disk.used + disk.avail)}</p>
        </li>;
      })}</ul>}
    </Card>
    <p className="flex items-start gap-2 text-xs text-muted-foreground"><Activity className="mt-0.5 size-3.5 shrink-0" />{t('metrics.footnote', { procs: sample.procs ?? '—', swap: sample.swapTotal ? `${formatBytes(sample.swapUsed ?? 0)} / ${formatBytes(sample.swapTotal)}` : '—' })}</p>
  </div>;
}
