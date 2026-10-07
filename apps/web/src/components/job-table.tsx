import { ChevronLeft, ChevronRight, TerminalSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatNumber, t } from '../i18n';
import { Link } from '../lib/router';
import { formatDuration } from '../lib/time';
import type { Job } from '../lib/types';
import { cn } from '../lib/utils';
import { Button, Empty, Status, Time } from './ui';

function ExitCode({ job }: { job: Job }) {
  if (job.exitCode === undefined || job.exitCode === null) return <span className="text-muted-foreground">—</span>;
  return <span className={cn('font-mono text-xs', job.exitCode !== 0 && 'text-danger')}>{job.exitCode}</span>;
}

export function JobTable({ jobs, showServer = true, empty }: { jobs: Job[]; showServer?: boolean; empty?: ReactNode }) {
  if (!jobs.length) return <>{empty ?? <Empty title={t('jobs.emptyTitle')} description={t('jobs.emptyDescription')} icon={<TerminalSquare className="size-5" />} />}</>;
  const href = (job: Job) => '/jobs/' + encodeURIComponent(job.id);
  return <>
    <div className="hidden overflow-x-auto md:block"><table className="data-table">
      <thead><tr><th>{t('jobs.command')}</th>{showServer && <th>{t('jobs.server')}</th>}<th>{t('jobs.status')}</th><th>{t('jobs.started')}</th><th>{t('jobs.duration')}</th><th>{t('jobs.exitCode')}</th></tr></thead>
      <tbody>{jobs.map(job => <tr key={job.id} className="relative">
        <td className="max-w-[420px]"><Link className="block truncate font-mono text-xs font-medium after:absolute after:inset-0 hover:underline" href={href(job)} title={job.cmd}>{job.cmd || t('jobs.terminalSession')}</Link><div className="mt-1 truncate font-mono text-xs text-muted-foreground">{job.path}</div></td>
        {showServer && <td className="whitespace-nowrap">{job.serverName || t('servers.deletedServer')}</td>}
        <td><Status status={job.status} /></td>
        <td className="relative z-10 text-muted-foreground"><Time value={job.startedAt} relative /></td>
        <td className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatDuration(job.startedAt, job.endedAt)}</td>
        <td><ExitCode job={job} /></td>
      </tr>)}</tbody>
    </table></div>
    <ul className="divide-y md:hidden">{jobs.map(job => <li key={job.id}><Link href={href(job)} className="block space-y-2 px-4 py-3 hover:bg-muted/35">
      <div className="flex items-start justify-between gap-3"><span className="min-w-0 truncate font-mono text-xs font-medium">{job.cmd || t('jobs.terminalSession')}</span><Status status={job.status} /></div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{showServer && <span className="font-medium text-foreground">{job.serverName || t('servers.deletedServer')}</span>}<span className="truncate font-mono">{job.path}</span><Time value={job.startedAt} relative /></div>
    </Link></li>)}</ul>
  </>;
}

export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
    <span>{t('common.pageSummary', { total: formatNumber(total), page: page + 1, pages })}</span>
    <div className="flex gap-1"><Button variant="outline" size="icon-sm" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label={t('common.previousPage')}><ChevronLeft /></Button><Button variant="outline" size="icon-sm" disabled={page >= pages - 1} onClick={() => onChange(page + 1)} aria-label={t('common.nextPage')}><ChevronRight /></Button></div>
  </div>;
}
