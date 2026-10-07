import { CircleStop, History, Pencil, Plus, TerminalSquare } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { NewTerminalDialog } from '../components/new-terminal';
import { TerminalScreen } from '../components/terminal-screen';
import { Badge, Button, Card, ConfirmDialog, Dot, Empty, ErrorNotice, Field, Input, Loading, Modal, PageHeading, Segmented, Select, Status, Time, Tooltip, toast } from '../components/ui';
import { t } from '../i18n';
import { patch, post, useAction, useApi } from '../lib/api';
import { useServers } from '../lib/app-data';
import { Link } from '../lib/router';
import { isActive, type Job, type JobPage } from '../lib/types';
import { cn } from '../lib/utils';

const sessionName = (session: Job) => session.label || session.path;

export function Terminals({ id, serverFilter }: { id?: string; serverFilter?: string }) {
  const sessionPage = useApi<JobPage>('/api/jobs?kind=terminal&limit=200', { refreshOn: ['jobs'] });
  // The recent page can miss old sessions that are still open, so running ones are fetched on their own.
  const runningPage = useApi<JobPage>('/api/jobs?kind=terminal&status=running&limit=200', { refreshOn: ['jobs'] });
  const servers = useServers();
  const detail = useApi<Job>(id ? '/api/jobs/' + encodeURIComponent(id) : null, { refreshOn: ['jobs'] });
  const [server, setServer] = useState(serverFilter || '');
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState('');
  const action = useAction();
  const sessions = sessionPage.data && runningPage.data
    ? [...runningPage.data.items.filter(session => !sessionPage.data!.items.some(item => item.id === session.id)), ...sessionPage.data.items].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    : undefined;
  const current = detail.data || sessions?.find(session => session.id === id);
  const visible = sessions?.filter(session => (!server || session.serverId === server) && (filter === 'all' || isActive(session)));
  const activeCount = sessions?.filter(isActive).length;
  const closeSession = () => void action.run(async () => {
    if (!current) return;
    await post('/api/terminals/' + current.id + '/close');
    setClosing(false); sessionPage.refresh(); runningPage.refresh(); detail.refresh();
    toast.success(t('terminals.closed'));
  });
  const rename = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await patch('/api/jobs/' + current!.id, { label: label.trim() || null });
      setRenaming(false); detail.refresh(); sessionPage.refresh(); runningPage.refresh();
    });
  };
  return <div className="page-stack">
    <PageHeading title={t('terminals.title')} description={t('terminals.description')} action={<Button onClick={() => setCreating(true)}><Plus />{t('terminals.new')}</Button>} />
    <ErrorNotice message={sessionPage.error || runningPage.error} retry={() => { sessionPage.refresh(); runningPage.refresh(); }} />
    <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
      <Card className={cn('min-w-0', id && 'order-last xl:order-none')}>
        <div className="space-y-3 border-b p-3">
          <div className="flex items-center justify-between px-1"><h2 className="text-sm font-semibold">{t('terminals.sessions')}</h2><Badge>{t('terminals.activeCount', { n: activeCount ?? '—' })}</Badge></div>
          <Select className="w-full" aria-label={t('terminals.serverFilter')} value={server} onChange={event => setServer(event.target.value)}><option value="">{t('jobs.allServers')}</option>{servers.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
          <Segmented className="flex w-full" label={t('terminals.stateFilter')} value={filter} onChange={setFilter} options={[{ value: 'active', label: t('terminals.filterActive') }, { value: 'all', label: t('terminals.filterAll') }]} />
        </div>
        {!visible ? sessionPage.loading || runningPage.loading ? <Loading /> : null : !visible.length ? <Empty className="py-10" title={t('terminals.noSessions')} description={t('terminals.noSessionsHint')} /> :
          <div className="max-h-[62dvh] space-y-0.5 overflow-y-auto p-2">{visible.map(session => <Link key={session.id} href={'/terminals/' + session.id} aria-current={id === session.id ? 'page' : undefined} className={cn('block rounded-lg px-3 py-2.5 hover:bg-accent', id === session.id && 'bg-accent')}>
            <div className="flex items-center gap-2"><Dot tone={isActive(session) ? 'success' : 'neutral'} /><span className={cn('min-w-0 flex-1 truncate text-sm font-medium', !session.label && 'font-mono text-xs')}>{sessionName(session)}</span></div>
            <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-muted-foreground"><span className="truncate">{session.serverName || t('servers.deletedServer')}</span>{session.label && <span className="truncate font-mono">{session.path}</span>}<Time value={session.startedAt} relative className="ml-auto shrink-0" /></div>
          </Link>)}</div>}
      </Card>
      <Card className="min-w-0">{!id ? <Empty title={t('terminals.selectTitle')} description={t('terminals.selectHint')} icon={<TerminalSquare className="size-5" />} action={<Button variant="outline" onClick={() => setCreating(true)}><Plus />{t('terminals.new')}</Button>} /> :
        <div className="space-y-3 p-3 sm:p-4">
          <ErrorNotice message={detail.error} retry={detail.refresh} />
          {!current ? detail.loading ? <Loading /> : null : <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><h2 className={cn('truncate font-semibold', !current.label && 'font-mono text-sm')}>{sessionName(current)}</h2><Status status={current.status} />
                  <Tooltip content={t('terminals.rename')}><Button variant="ghost" size="icon" className="size-7" aria-label={t('terminals.rename')} onClick={() => { action.clearError(); setLabel(current.label ?? ''); setRenaming(true); }}><Pencil /></Button></Tooltip></div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{current.serverName ? <Link href={'/servers/' + current.serverId} className="hover:underline">{current.serverName}</Link> : t('servers.deletedServer')}<span className="font-mono"> · {current.path}</span></p>
              </div>
              <div className="flex gap-1"><Button variant="ghost" size="sm" asChild><Link href={'/jobs/' + current.id}><History />{t('terminals.history')}</Link></Button>{isActive(current) && <Button variant="outline" size="sm" onClick={() => { action.clearError(); setClosing(true); }}><CircleStop />{t('terminals.close')}</Button>}</div>
            </div>
            <TerminalScreen key={current.id} id={current.id} active={isActive(current)} title={(current.serverName || t('servers.deletedServer')) + ' · ' + sessionName(current)} />
          </>}
        </div>}
      </Card>
    </div>
    <NewTerminalDialog open={creating} onOpenChange={setCreating} serverFilter={serverFilter} onCreated={() => { sessionPage.refresh(); runningPage.refresh(); }} />
    <ConfirmDialog open={closing} onOpenChange={setClosing} title={t('terminals.closeTitle')} description={t('terminals.closeDescription')} confirmLabel={t('terminals.close')} destructive onConfirm={closeSession} busy={action.busy} error={action.error} />
    <Modal open={renaming} onOpenChange={setRenaming} title={t('terminals.renameTitle')}>
      <form className="space-y-5" onSubmit={rename}>
        <Field label={t('terminals.name')} htmlFor="terminal-rename" hint={t('terminals.renameHint')}><Input id="terminal-rename" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} autoFocus /></Field>
        <ErrorNotice message={action.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setRenaming(false)}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy}>{t('common.save')}</Button></div>
      </form>
    </Modal>
  </div>;
}
