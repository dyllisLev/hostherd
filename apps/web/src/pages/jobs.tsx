import { CornerDownLeft, Search, Square, TerminalSquare } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { JobOutput } from '../components/job-output';
import { JobTable, Pager } from '../components/job-table';
import { Button, Card, CardHeader, ConfirmDialog, CopyButton, Details, Empty, ErrorNotice, Input, Loading, PageHeading, Select, Status, statusLabel, Textarea, Time, toast } from '../components/ui';
import { t } from '../i18n';
import { formatBytes, post, useAction, useApi } from '../lib/api';
import { formatDuration } from '../lib/time';
import { useServers } from '../lib/app-data';
import { Link, useQueryState } from '../lib/router';
import { isActive, type Job, type JobPage } from '../lib/types';

const PAGE_SIZE = 25;
const statuses = ['running', 'completed', 'failed', 'interrupted', 'unknown'] as const;

export function Jobs() {
  const servers = useServers();
  const [query, setQuery] = useQueryState();
  const search = query.get('q') ?? '', status = query.get('status') ?? '', server = query.get('server') ?? '';
  const page = Math.max(0, Number(query.get('page') ?? 0) || 0);
  const [draft, setDraft] = useState(search);
  // Follow outside URL changes (sidebar link, back button) so the debounce does not write an old query back.
  useEffect(() => setDraft(search), [search]);
  useEffect(() => { const timer = setTimeout(() => { if (draft !== search) setQuery({ q: draft, page: undefined }); }, 300); return () => clearTimeout(timer); }, [draft, search, setQuery]);
  const params = new URLSearchParams({ kind: 'job', limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (search) params.set('q', search); if (status) params.set('status', status); if (server) params.set('serverId', server);
  const result = useApi<JobPage>('/api/jobs?' + params, { refreshOn: ['jobs'] });
  return <div className="page-stack">
    <PageHeading title={t('jobs.title')} description={t('jobs.description')} />
    <ErrorNotice message={result.error} retry={result.refresh} />
    <Card><div className="flex flex-wrap items-center gap-3 border-b p-4 sm:px-5"><div className="relative w-full sm:mr-auto sm:max-w-sm"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label={t('jobs.search')} placeholder={t('jobs.searchPlaceholder')} value={draft} onChange={event => setDraft(event.target.value)} className="pl-9" /></div><Select aria-label={t('jobs.serverFilter')} value={server} onChange={event => setQuery({ server: event.target.value, page: undefined })}><option value="">{t('jobs.allServers')}</option>{servers.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select aria-label={t('jobs.statusFilter')} value={status} onChange={event => setQuery({ status: event.target.value, page: undefined })}><option value="">{t('jobs.allStatuses')}</option>{statuses.map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</Select></div>
      {result.data ? <><JobTable jobs={result.data.items} empty={search || status || server ? <Empty title={t('jobs.noMatches')} description={t('jobs.noMatchesHint')} /> : undefined} />{result.data.total > 0 && <Pager page={page} pageSize={PAGE_SIZE} total={result.data.total} onChange={next => setQuery({ page: next || undefined })} />}</> : result.loading ? <Loading /> : null}
    </Card>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('jobs.retention')}</p>
  </div>;
}

export function JobDetail({ id }: { id: string }) {
  const result = useApi<Job>('/api/jobs/' + encodeURIComponent(id), { refreshOn: ['jobs'], interval: 15_000 });
  const action = useAction();
  const [input, setInput] = useState('');
  const [newline, setNewline] = useState(true);
  const [confirm, setConfirm] = useState<'cancel' | 'eof'>();
  const job = result.data;
  const send = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await post('/api/jobs/' + id + '/input', { data: input + (newline ? '\n' : '') });
      setInput(''); toast.success(t('jobDetail.inputSent'));
    });
  };
  const confirmAction = () => void action.run(async () => {
    if (confirm === 'eof') await post('/api/jobs/' + id + '/input', { data: '', eof: true });
    else await post('/api/jobs/' + id + '/cancel');
    toast.success(confirm === 'eof' ? t('jobDetail.eofSent') : t('jobDetail.cancelRequested'));
    setConfirm(undefined); result.refresh();
  });
  const back = { href: '/jobs', label: t('jobs.title') };
  if (!job) return <div className="page-stack"><PageHeading back={back} title={t('jobDetail.title')} /><ErrorNotice message={result.error} retry={result.refresh} />{result.loading && <Loading />}</div>;
  const terminal = job.kind === 'terminal';
  return <div className="page-stack">
    <PageHeading back={back} title={<span className="flex min-w-0 items-start gap-3"><span className="line-clamp-3 font-mono text-lg break-all whitespace-pre-wrap sm:text-xl" title={job.cmd}>{terminal ? job.label || t('jobs.terminalSession') : job.cmd}</span><span className="mt-1 shrink-0"><Status status={job.status} /></span></span>}
      description={<>{job.serverName ? <Link href={'/servers/' + job.serverId} className="font-medium text-foreground hover:underline">{job.serverName}</Link> : t('servers.deletedServer')}<span className="font-mono"> · {job.path}</span></>}
      action={<>{!terminal && <CopyButton value={job.cmd} label={t('jobDetail.copyCommand')} />}{terminal ? <Button variant="outline" asChild><Link href={'/terminals/' + job.id}><TerminalSquare />{t('jobDetail.openTerminal')}</Link></Button> : isActive(job) && <Button variant="outline" onClick={() => { action.clearError(); setConfirm('cancel'); }}><Square />{t('jobDetail.cancel')}</Button>}</>} />
    <ErrorNotice message={result.error} retry={result.refresh} />
    {job.error && <ErrorNotice message={job.error} />}
    <Card className="p-5 sm:p-6"><Details className="lg:grid-cols-4" items={[
      [t('jobDetail.started'), <Time value={job.startedAt} />], [t('jobDetail.ended'), <Time value={job.endedAt} />],
      [t('jobs.duration'), formatDuration(job.startedAt, job.endedAt)],
      [t('jobs.exitCode'), job.exitCode === undefined || job.exitCode === null ? (job.signal ? t('jobDetail.signal', { signal: job.signal }) : '—') : <span className={job.exitCode ? 'text-danger' : undefined}>{job.exitCode}{job.signal ? ' · ' + job.signal : ''}</span>],
      [t('jobDetail.output'), formatBytes(job.outputBytes)], [t('jobDetail.runner'), job.runnerVersion || '—'], [t('jobDetail.pid'), job.pid ?? '—'],
      [t('jobDetail.id'), <span className="flex items-center gap-1"><span className="min-w-0 truncate font-mono text-xs">{job.id}</span><CopyButton value={job.id} size="icon-sm" variant="ghost" /></span>],
    ]} /></Card>
    <Card><CardHeader title={t('jobDetail.output')} /><div className="px-5 pb-5 sm:px-6 sm:pb-6"><JobOutput key={job.id} id={job.id} outputBytes={job.outputBytes} /></div></Card>
    {!terminal && isActive(job) && <Card><CardHeader title={t('jobDetail.stdin')} description={t('jobDetail.stdinHint')} />
      <form onSubmit={send} className="space-y-4 px-5 pb-5 sm:px-6 sm:pb-6">
        <Textarea aria-label={t('jobDetail.stdin')} className="font-mono" value={input} onChange={event => setInput(event.target.value)} placeholder={t('jobDetail.stdinPlaceholder')} />
        <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={newline} onChange={event => setNewline(event.target.checked)} className="accent-primary" />{t('jobDetail.appendNewline')}</label>
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={action.busy} onClick={() => { action.clearError(); setConfirm('eof'); }}>{t('jobDetail.sendEof')}</Button><Button type="submit" disabled={action.busy || (!input && !newline)}><CornerDownLeft />{t('jobDetail.send')}</Button></div></div>
        {!confirm && <ErrorNotice message={action.error} />}
      </form></Card>}
    <ConfirmDialog open={Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(undefined); }} title={confirm === 'eof' ? t('jobDetail.eofTitle') : t('jobDetail.cancelTitle')} description={confirm === 'eof' ? t('jobDetail.eofDescription') : t('jobDetail.cancelDescription')}
      confirmLabel={confirm === 'eof' ? t('jobDetail.sendEof') : t('jobDetail.cancel')} destructive={confirm === 'cancel'} onConfirm={confirmAction} busy={action.busy} error={action.error} />
  </div>;
}
