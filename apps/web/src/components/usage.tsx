import { t } from '../i18n';
import type { LatestMetrics } from '../lib/types';
import { cn } from '../lib/utils';
import { Tooltip } from './ui';

// Usage above these thresholds is flagged with the status colors.
export const usageTone = (value: number) => value >= 90 ? 'danger' : value >= 80 ? 'warning' : 'normal';

export function UsageBar({ label, value, className }: { label: string; value: number | null | undefined; className?: string }) {
  const known = value !== null && value !== undefined;
  const tone = known ? usageTone(value) : 'normal';
  return <div className={cn('min-w-0', className)}>
    <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none"><span className="text-muted-foreground">{label}</span><span className={cn('tabular-nums', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-foreground')}>{known ? Math.round(value) + '%' : '—'}</span></div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(value) : undefined}>
      {known && <div className={cn('h-full rounded-full', tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-foreground/70')} style={{ width: Math.max(2, Math.min(100, value)) + '%' }} />}
    </div>
  </div>;
}

/** CPU, memory and fullest-disk usage of a server's latest sample. */
export function ServerUsage({ metrics, online, className }: { metrics?: LatestMetrics | null; online: boolean; className?: string }) {
  if (!metrics) return <Tooltip content={t('metrics.noDataHint')}><span className="text-xs text-muted-foreground">—</span></Tooltip>;
  return <div className={cn('grid w-full min-w-40 grid-cols-3 gap-2.5', !online && 'opacity-50', className)}>
    <UsageBar label="CPU" value={metrics.cpu} /><UsageBar label={t('metrics.memoryShort')} value={metrics.memPct} /><UsageBar label={t('metrics.diskShort')} value={metrics.diskPct} />
  </div>;
}
