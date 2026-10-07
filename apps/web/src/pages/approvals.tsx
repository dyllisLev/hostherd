import { FolderLock, ListChecks, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApprovalActions, RuleBadges, ruleLabel } from '../components/approval-actions';
import { FolderPicker } from '../components/folder-picker';
import { Pager } from '../components/job-table';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Empty, ErrorNotice, Field, Input, Loading, Modal, PageHeading, Segmented, Select, Tabs, TabsContent, TabsList, TabsTrigger, Time, toast, type Tone } from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post, useAction, useApi } from '../lib/api';
import { usePendingApprovals, useServers } from '../lib/app-data';
import { Link, useQueryState } from '../lib/router';
import type { AllowedFolder, Approval, ApprovalList, ApprovalStatus, CommandRule, RuleMode } from '../lib/types';

const PAGE_SIZE = 25;
const statusTone: Record<ApprovalStatus, Tone> = { pending: 'warning', approved: 'success', denied: 'danger', blocked: 'danger', expired: 'neutral' };

function ApprovalStatusBadge({ approval }: { approval: Approval }) {
  return <span className="inline-flex flex-wrap items-center gap-1.5"><Badge tone={statusTone[approval.status]}>{t(`approvals.state.${approval.status}`)}</Badge>
    {approval.usedAt && approval.status === 'approved' && <Badge tone="info">{t('approvals.used')}</Badge>}</span>;
}

/** One request with its full command and, while pending, the decision buttons. */
function ApprovalCard({ approval, highlight = false }: { approval: Approval; highlight?: boolean }) {
  return <div className={highlight ? 'rounded-xl border-2 border-warning-border p-4 sm:p-5' : 'p-4 sm:px-5'}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      <ApprovalStatusBadge approval={approval} />
      <Link className="font-medium text-foreground hover:underline" href={`/servers/${approval.serverId}`}>{approval.serverName || approval.serverId}</Link>
      <span className="font-mono">{approval.tool}</span>
      <Time value={approval.createdAt} relative />
    </div>
    <pre className="mt-3 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{approval.command}</pre>
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {approval.path && approval.path !== approval.command && <span>{t('approvals.workdir')} <span className="font-mono text-foreground">{approval.path}</span></span>}
      <RuleBadges rules={approval.rules} names={approval.ruleNames} />
    </div>
    {approval.status === 'pending' && <ApprovalActions approval={approval} className="mt-4" />}
  </div>;
}

function Requests({ id }: { id?: string }) {
  const pending = usePendingApprovals();
  const [query, setQuery] = useQueryState();
  const status = query.get('status') ?? '';
  const page = Math.max(0, Number(query.get('page') ?? 0) || 0);
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (status) params.set('status', status);
  const history = useApi<ApprovalList>('/api/approvals?' + params, { refreshOn: ['approvals'] });
  const focused = useApi<Approval>(id ? '/api/approvals/' + encodeURIComponent(id) : null, { refreshOn: ['approvals'] });
  const items = pending.data?.items ?? [];
  return <div className="space-y-6">
    {id && <><ErrorNotice message={focused.error} retry={focused.refresh} />{focused.data && <ApprovalCard approval={focused.data} highlight />}</>}
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">{t('approvals.pendingTitle')}{(pending.data?.pending ?? 0) > 0 && <Badge tone="warning">{pending.data!.pending}</Badge>}</span>} description={t('approvals.pendingDescription')} />
      <ErrorNotice message={pending.error} retry={pending.refresh} />
      {pending.data ? items.filter(item => item.id !== id).length
        ? <div className="divide-y">{items.filter(item => item.id !== id).map(item => <ApprovalCard key={item.id} approval={item} />)}</div>
        : <Empty title={t('approvals.noPending')} description={t('approvals.noPendingHint')} icon={<ShieldCheck className="size-5" />} />
        : pending.loading ? <Loading /> : null}
    </Card>
    <Card>
      <CardHeader title={t('approvals.history')} description={t('approvals.historyHint')} action={<Select aria-label={t('approvals.statusFilter')} value={status} onChange={event => setQuery({ status: event.target.value, page: undefined })}>
        <option value="">{t('approvals.allStatuses')}</option>{(['pending', 'approved', 'denied', 'blocked', 'expired'] as const).map(value => <option key={value} value={value}>{t(`approvals.state.${value}`)}</option>)}
      </Select>} />
      <ErrorNotice message={history.error} retry={history.refresh} />
      {history.data ? history.data.items.length ? <>
        <div className="overflow-x-auto"><table className="data-table">
          <thead><tr><th>{t('approvals.command')}</th><th>{t('approvals.server')}</th><th>{t('approvals.rules')}</th><th>{t('approvals.status')}</th><th>{t('approvals.requestedAt')}</th><th>{t('approvals.decidedAt')}</th></tr></thead>
          <tbody>{history.data.items.map(item => <tr key={item.id} className="relative">
            <td className="max-w-[420px]"><Link className="block truncate font-mono text-xs font-medium after:absolute after:inset-0 hover:underline" href={`/approvals/${item.id}`} title={item.command}>{item.command}</Link><div className="mt-1 font-mono text-xs text-muted-foreground">{item.tool}</div></td>
            <td className="whitespace-nowrap">{item.serverName || item.serverId}</td>
            <td><RuleBadges rules={item.rules} /></td>
            <td><ApprovalStatusBadge approval={item} /></td>
            <td className="text-muted-foreground"><Time value={item.createdAt} relative /></td>
            <td className="text-muted-foreground">{item.decidedAt ? <Time value={item.decidedAt} relative /> : '—'}</td>
          </tr>)}</tbody>
        </table></div>
        <Pager page={page} pageSize={PAGE_SIZE} total={history.data.total} onChange={next => setQuery({ page: next || undefined })} />
      </> : <Empty title={t('approvals.noHistory')} description={t('approvals.noHistoryHint')} /> : history.loading ? <Loading /> : null}
    </Card>
  </div>;
}

function Rules() {
  const rules = useApi<CommandRule[]>('/api/command-rules', { refreshOn: ['approvals'] });
  const save = async (rule: CommandRule, mode: RuleMode) => {
    try {
      await api('/api/command-rules/' + encodeURIComponent(rule.id), { method: 'PUT', body: JSON.stringify({ mode }) });
      rules.refresh(); toast.success(t('approvals.ruleSaved'));
    } catch (cause) { toast.error(errorMessage(cause)); }
  };
  const modes = (['confirm', 'allow', 'block'] as const).map(value => ({ value, label: t(`approvals.mode.${value}`) }));
  return <div className="space-y-4">
    <Card>
      <CardHeader title={t('approvals.rulesTitle')} description={t('approvals.rulesDescription')} />
      <ErrorNotice message={rules.error} retry={rules.refresh} />
      {rules.data ? <div className="divide-y">{(['delete', 'overwrite', 'system'] as const).map(category => <div key={category} className="px-4 py-3 sm:px-5">
        <div className="mb-1 text-xs font-medium text-muted-foreground">{t(`approvals.category.${category}`)}</div>
        <ul className="divide-y">{rules.data!.filter(rule => rule.category === category).map(rule => <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
          <span className="text-sm">{ruleLabel(rule.id)}</span>
          <Segmented label={t('approvals.modeFor', { name: ruleLabel(rule.id) })} value={rule.mode} onChange={mode => void save(rule, mode)} options={modes} />
        </li>)}</ul>
      </div>)}</div> : rules.loading ? <Loading /> : null}
    </Card>
    <CustomRules rules={rules.data?.filter(rule => rule.category === 'custom')} onChange={rules.refresh} save={save} />
    <p className="text-xs leading-relaxed text-muted-foreground">{t('approvals.rulesFootnote')}</p>
  </div>;
}

/** User-defined rules: a command prefix or a regular expression, set to confirm or block. */
function CustomRules({ rules, onChange, save }: { rules?: CommandRule[]; onChange: () => void; save: (rule: CommandRule, mode: RuleMode) => Promise<void> }) {
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CommandRule>();
  const [name, setName] = useState('');
  const [matchType, setMatchType] = useState<'command' | 'regex'>('command');
  const [pattern, setPattern] = useState('');
  const [mode, setMode] = useState<'confirm' | 'block'>('confirm');
  const open = () => { setName(''); setPattern(''); setMatchType('command'); setMode('confirm'); action.clearError(); setAdding(true); };
  const add = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await post('/api/command-rules', { name: name.trim() || pattern.trim(), matchType, pattern: pattern.trim(), mode });
      setAdding(false); onChange(); toast.success(t('approvals.customAdded'));
    });
  };
  const remove = () => void action.run(async () => {
    await api('/api/command-rules/' + encodeURIComponent(removing!.id), { method: 'DELETE' });
    setRemoving(undefined); onChange(); toast.success(t('approvals.customRemoved'));
  });
  const modes = (['confirm', 'block'] as const).map(value => ({ value, label: t(`approvals.mode.${value}`) }));
  return <Card>
    <CardHeader title={t('approvals.customTitle')} description={t('approvals.customDescription')} action={<Button size="sm" onClick={open}><Plus />{t('approvals.addRule')}</Button>} />
    {!rules ? null : !rules.length ? <Empty className="py-8" title={t('approvals.noCustom')} description={t('approvals.noCustomHint')} icon={<ListChecks className="size-5" />} />
      : <ul className="divide-y border-t">{rules.map(rule => <li key={rule.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-5">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{rule.name}</p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground"><Badge className="mr-1.5 font-sans">{t(`approvals.matchType.${rule.matchType ?? 'command'}`)}</Badge>{rule.pattern}</p></div>
        <Segmented label={t('approvals.modeFor', { name: rule.name })} value={rule.mode === 'block' ? 'block' : 'confirm'} onChange={value => void save(rule, value)} options={modes} />
        <Button variant="ghost" size="icon-sm" aria-label={t('approvals.removeRuleFor', { name: rule.name })} onClick={() => { action.clearError(); setRemoving(rule); }}><Trash2 /></Button>
      </li>)}</ul>}
    <Modal open={adding} onOpenChange={setAdding} title={t('approvals.addRuleTitle')} description={t('approvals.customDescription')}>
      <form className="space-y-5" onSubmit={add}>
        <Field label={t('approvals.matchTypeLabel')}><Segmented label={t('approvals.matchTypeLabel')} value={matchType} onChange={setMatchType} options={(['command', 'regex'] as const).map(value => ({ value, label: t(`approvals.matchType.${value}`) }))} /></Field>
        <Field label={t('approvals.pattern')} htmlFor="rule-pattern" hint={matchType === 'command' ? t('approvals.patternCommandHint') : t('approvals.patternRegexHint')}>
          <Input id="rule-pattern" className="font-mono" value={pattern} onChange={event => setPattern(event.target.value)} placeholder={matchType === 'command' ? 'docker rm' : 'git\\s+push\\s+.*--force'} required maxLength={300} autoFocus />
        </Field>
        <Field label={t('approvals.ruleName')} htmlFor="rule-name" hint={t('approvals.ruleNameHint')}><Input id="rule-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder={pattern || t('approvals.ruleNamePlaceholder')} /></Field>
        <Field label={t('approvals.ruleMode')}><Segmented label={t('approvals.ruleMode')} value={mode} onChange={setMode} options={modes} /></Field>
        <ErrorNotice message={action.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAdding(false)}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy || !pattern.trim()}>{action.busy ? t('common.working') : t('approvals.addRule')}</Button></div>
      </form>
    </Modal>
    <ConfirmDialog open={Boolean(removing)} onOpenChange={value => { if (!value) setRemoving(undefined); }} title={t('approvals.removeRule')} description={removing?.name} confirmLabel={t('approvals.removeRule')} destructive onConfirm={remove} busy={action.busy} error={action.error} />
  </Card>;
}

function Folders() {
  const servers = useServers();
  const folders = useApi<AllowedFolder[]>('/api/allowed-folders', { refreshOn: ['approvals'] });
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const [serverId, setServerId] = useState('');
  const [path, setPath] = useState('');
  const [removing, setRemoving] = useState<AllowedFolder>();
  const serverName = (id: string | null) => id ? servers.data?.find(server => server.id === id)?.name ?? id : t('approvals.allServers');
  const add = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await post('/api/allowed-folders', { serverId: serverId || null, path: path.trim() });
      setAdding(false); setPath(''); folders.refresh(); toast.success(t('approvals.added'));
    });
  };
  const remove = () => void action.run(async () => {
    await api('/api/allowed-folders/' + removing!.id, { method: 'DELETE' });
    setRemoving(undefined); folders.refresh(); toast.success(t('approvals.removed'));
  });
  return <div className="space-y-4">
    <Card>
      <CardHeader title={t('approvals.foldersTitle')} description={t('approvals.foldersDescription')} action={<Button size="sm" onClick={() => { action.clearError(); setAdding(true); }}><Plus />{t('approvals.addFolder')}</Button>} />
      <ErrorNotice message={folders.error} retry={folders.refresh} />
      {folders.data ? folders.data.length ? <div className="overflow-x-auto"><table className="data-table">
        <thead><tr><th>{t('approvals.path')}</th><th>{t('approvals.server')}</th><th>{t('approvals.createdAt')}</th><th><span className="sr-only">{t('approvals.removeFolder')}</span></th></tr></thead>
        <tbody>{folders.data.map(folder => <tr key={folder.id}>
          <td className="font-mono text-xs">{folder.path}</td>
          <td className="whitespace-nowrap">{serverName(folder.serverId)}</td>
          <td className="text-muted-foreground"><Time value={folder.createdAt} /></td>
          <td className="text-right"><Button variant="ghost" size="icon-sm" aria-label={t('approvals.removeFolderFor', { path: folder.path })} onClick={() => { action.clearError(); setRemoving(folder); }}><Trash2 /></Button></td>
        </tr>)}</tbody>
      </table></div> : <Empty title={t('approvals.noFolders')} description={t('approvals.noFoldersHint')} icon={<FolderLock className="size-5" />} /> : folders.loading ? <Loading /> : null}
    </Card>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('approvals.unknownLocation')}</p>
    <Modal open={adding} onOpenChange={setAdding} title={t('approvals.addFolderTitle')} description={t('approvals.foldersDescription')}>
      <form className="space-y-5" onSubmit={add}>
        <Field label={t('approvals.server')} htmlFor="folder-server"><Select id="folder-server" className="w-full" value={serverId} onChange={event => setServerId(event.target.value)}>
          <option value="">{t('approvals.allServers')}</option>{servers.data?.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}
        </Select></Field>
        <Field label={t('approvals.path')} hint={t('approvals.pathHint')} htmlFor="folder-path"><FolderPicker id="folder-path" serverId={serverId || undefined} value={path} onChange={setPath} placeholder={t('approvals.pathPlaceholder')} /></Field>
        <ErrorNotice message={action.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAdding(false)}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy || !path.trim()}>{action.busy ? t('common.working') : t('approvals.addFolder')}</Button></div>
      </form>
    </Modal>
    <ConfirmDialog open={Boolean(removing)} onOpenChange={value => { if (!value) setRemoving(undefined); }} title={t('approvals.removeFolder')} description={removing?.path} confirmLabel={t('approvals.removeFolder')} destructive onConfirm={remove} busy={action.busy} error={action.error} />
  </div>;
}

/** Master switch for every rule: while off, nothing asks or blocks. */
function ApprovalSwitch() {
  const settings = useApi<{ enabled: boolean }>('/api/approval-settings', { refreshOn: ['approvals'] });
  const save = async (enabled: boolean) => {
    try {
      await api('/api/approval-settings', { method: 'PUT', body: JSON.stringify({ enabled }) });
      settings.refresh(); toast.success(t(enabled ? 'approvals.switchedOn' : 'approvals.switchedOff'));
    } catch (cause) { toast.error(errorMessage(cause)); }
  };
  if (!settings.data) return <ErrorNotice message={settings.error} retry={settings.refresh} />;
  const enabled = settings.data.enabled;
  return <Card className={enabled ? undefined : 'border-2 border-warning-border'}>
    <CardHeader title={t('approvals.switchTitle')} description={t(enabled ? 'approvals.switchOnHint' : 'approvals.switchOffHint')}
      action={<Segmented label={t('approvals.switchTitle')} value={enabled ? 'on' : 'off'} onChange={value => void save(value === 'on')}
        options={[{ value: 'on', label: t('approvals.switchOn') }, { value: 'off', label: t('approvals.switchOff') }]} />} />
  </Card>;
}

export function Approvals({ id }: { id?: string }) {
  const [query, setQuery] = useQueryState();
  const tab = id ? 'requests' : query.get('tab') ?? 'requests';
  return <div className="page-stack">
    <PageHeading title={t('approvals.title')} description={t('approvals.description')} back={id ? { href: '/approvals', label: t('approvals.title') } : undefined} />
    {!id && <ApprovalSwitch />}
    <Tabs value={tab} onValueChange={value => setQuery({ tab: value === 'requests' ? undefined : value, status: undefined, page: undefined })}>
      {!id && <TabsList className="mb-5">
        <TabsTrigger value="requests"><ShieldAlert />{t('approvals.tabRequests')}</TabsTrigger>
        <TabsTrigger value="rules"><ListChecks />{t('approvals.tabRules')}</TabsTrigger>
        <TabsTrigger value="folders"><FolderLock />{t('approvals.tabFolders')}</TabsTrigger>
      </TabsList>}
      <TabsContent value="requests"><Requests id={id} /></TabsContent>
      <TabsContent value="rules"><Rules /></TabsContent>
      <TabsContent value="folders"><Folders /></TabsContent>
    </Tabs>
  </div>;
}
