import { Bell, Info, KeyRound, Link2, Monitor, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card, CardHeader, ConfirmDialog, CopyButton, Details, Empty, ErrorNotice, Field, Input, Loading, Modal, PageHeading, Segmented, Tabs, TabsContent, TabsList, TabsTrigger, Time, toast } from '../components/ui';
import { localeNames, locales, setLocale, t, useLocale, type MessageKey } from '../i18n';
import { api, post, useAction, useApi } from '../lib/api';
import { Webhooks } from '../components/webhooks';
import { useSettings } from '../lib/app-data';
import { setThemePreference, setTimeZonePreference, usePreferences } from '../lib/preferences';
import { useQueryState } from '../lib/router';
import { fromDateTimeInput } from '../lib/time';

interface Token { id: string; name: string; createdAt: string; lastUsedAt?: string | null; expiresAt?: string | null }
interface NewToken extends Token { token: string }
interface Grant { id: string; clientId: string; clientName: string; expiresAt?: string | null }

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return <div className="rounded-lg border bg-muted/40">
    <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5"><span className="text-xs text-muted-foreground">{label}</span><CopyButton value={code} /></div>
    <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
  </div>;
}

type Client = 'claude-code' | 'claude-desktop' | 'chatgpt' | 'cursor' | 'vscode' | 'other';
function clientGuide(client: Client, url: string): { steps: MessageKey[]; code?: string; codeLabel?: string } {
  const header = 'Authorization: Bearer <TOKEN>';
  switch (client) {
    case 'claude-code': return { steps: ['mcp.claudeCode1', 'mcp.claudeCode2'], code: `# OAuth\nclaude mcp add --transport http hostherd ${url}\n\n# ${t('mcp.orToken')}\nclaude mcp add --transport http hostherd ${url} \\\n  --header "${header}"`, codeLabel: t('mcp.terminal') };
    case 'claude-desktop': return { steps: ['mcp.claudeDesktop1', 'mcp.claudeDesktop2', 'mcp.claudeDesktop3'] };
    case 'chatgpt': return { steps: ['mcp.chatgpt1', 'mcp.chatgpt2', 'mcp.chatgpt3'] };
    case 'cursor': return { steps: ['mcp.cursor1'], code: JSON.stringify({ mcpServers: { hostherd: { url, headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2), codeLabel: '~/.cursor/mcp.json' };
    case 'vscode': return { steps: ['mcp.vscode1'], code: JSON.stringify({ servers: { hostherd: { type: 'http', url, headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2), codeLabel: '.vscode/mcp.json' };
    default: return { steps: ['mcp.other1', 'mcp.other2'], code: `URL: ${url}\n${header}`, codeLabel: 'HTTP' };
  }
}

function McpGuide({ url, onIssueToken }: { url: string; onIssueToken: () => void }) {
  const [client, setClient] = useState<Client>('claude-code');
  const guide = clientGuide(client, url);
  const clients: { value: Client; label: string }[] = [
    { value: 'claude-code', label: 'Claude Code' }, { value: 'claude-desktop', label: 'Claude' }, { value: 'chatgpt', label: 'ChatGPT' },
    { value: 'cursor', label: 'Cursor' }, { value: 'vscode', label: 'VS Code' }, { value: 'other', label: t('mcp.otherClient') },
  ];
  return <div className="space-y-5">
    <Card><CardHeader title={t('mcp.address')} description={t('mcp.addressHint')} action={<Link2 className="size-5 text-muted-foreground" />} />
      <div className="px-5 pb-5 sm:px-6 sm:pb-6"><div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3"><code className="min-w-0 flex-1 break-all text-sm">{url}</code><CopyButton value={url} /></div></div>
    </Card>
    <Card><CardHeader title={t('mcp.guide')} description={t('mcp.guideHint')} />
      <div className="space-y-5 px-5 pb-5 sm:px-6 sm:pb-6">
        <Segmented label={t('mcp.client')} value={client} onChange={setClient} options={clients} className="max-w-full overflow-x-auto" />
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">{guide.steps.map(step => <li key={step}>{t(step, { url })}</li>)}</ol>
        {guide.code && <CodeBlock code={guide.code} label={guide.codeLabel} />}
        {guide.code?.includes('<TOKEN>') && <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{t('mcp.tokenHint')}<Button variant="outline" size="sm" onClick={onIssueToken}><KeyRound />{t('tokens.issue')}</Button></p>}
      </div>
    </Card>
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{t('mcp.scope')}</p>
  </div>;
}

function Tokens({ creating, setCreating }: { creating: boolean; setCreating: (value: boolean) => void }) {
  const tokens = useApi<Token[]>('/api/tokens', 30_000);
  const action = useAction();
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [issued, setIssued] = useState<NewToken>();
  const [revoke, setRevoke] = useState<Token>();
  const open = setCreating;
  useEffect(() => { if (creating) { setName(''); setExpires(''); setIssued(undefined); action.clearError(); } }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps
  const issue = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      setIssued(await post<NewToken>('/api/tokens', { name: name.trim(), expiresAt: expires ? fromDateTimeInput(expires) : null }));
      tokens.refresh();
    });
  };
  const revokeToken = () => void action.run(async () => {
    await api('/api/tokens/' + encodeURIComponent(revoke!.id), { method: 'DELETE' });
    setRevoke(undefined); tokens.refresh(); toast.success(t('tokens.revoked'));
  });
  const expiry = (token: Token) => token.expiresAt ? <Time value={token.expiresAt} /> : t('tokens.noExpiry');
  return <Card>
    <CardHeader title={t('tokens.title')} description={t('tokens.description')} action={<Button variant="outline" size="sm" onClick={() => open(true)}><Plus />{t('tokens.issue')}</Button>} />
    <div className="px-5 sm:px-6"><ErrorNotice message={tokens.error} retry={tokens.refresh} /></div>
    {!tokens.data ? tokens.loading ? <Loading /> : null : !tokens.data.length ? <Empty title={t('tokens.emptyTitle')} description={t('tokens.emptyDescription')} icon={<KeyRound className="size-5" />} /> : <>
      <div className="hidden overflow-x-auto md:block"><table className="data-table"><thead><tr><th>{t('tokens.name')}</th><th>{t('tokens.created')}</th><th>{t('tokens.lastUsed')}</th><th>{t('tokens.expires')}</th><th><span className="sr-only">{t('tokens.revoke')}</span></th></tr></thead>
        <tbody>{tokens.data.map(token => <tr key={token.id}><td className="font-medium">{token.name}</td><td className="text-xs text-muted-foreground"><Time value={token.createdAt} /></td><td className="text-xs text-muted-foreground">{token.lastUsedAt ? <Time value={token.lastUsedAt} relative /> : t('tokens.neverUsed')}</td><td className="text-xs text-muted-foreground">{expiry(token)}</td><td className="text-right"><Button variant="ghost" size="icon-sm" aria-label={t('tokens.revokeFor', { name: token.name })} onClick={() => { action.clearError(); setRevoke(token); }}><Trash2 /></Button></td></tr>)}</tbody></table></div>
      <ul className="divide-y border-t md:hidden">{tokens.data.map(token => <li key={token.id} className="flex items-center gap-3 px-5 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{token.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{t('tokens.lastUsed')} {token.lastUsedAt ? <Time value={token.lastUsedAt} relative /> : t('tokens.neverUsed')} · {expiry(token)}</p></div><Button variant="ghost" size="icon-sm" aria-label={t('tokens.revokeFor', { name: token.name })} onClick={() => { action.clearError(); setRevoke(token); }}><Trash2 /></Button></li>)}</ul>
    </>}
    <Modal open={creating} onOpenChange={open} title={issued ? t('tokens.issuedTitle') : t('tokens.issueTitle')} description={issued ? t('tokens.issuedDescription') : t('tokens.issueDescription')}>
      {issued ? <div className="space-y-5"><div className="rounded-lg border bg-muted/40 p-4"><code className="block break-all text-sm">{issued.token}</code><div className="mt-4"><CopyButton value={issued.token} label={t('tokens.copy')} /></div></div><Button className="w-full" onClick={() => open(false)}>{t('tokens.done')}</Button></div> :
        <form onSubmit={issue} className="space-y-5">
          <Field label={t('tokens.name')} htmlFor="token-name"><Input id="token-name" required maxLength={100} placeholder={t('tokens.namePlaceholder')} value={name} onChange={event => setName(event.target.value)} autoFocus /></Field>
          <Field label={t('tokens.expiresOptional')} htmlFor="token-expiry" hint={t('tokens.expiresHint')}><Input id="token-expiry" type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></Field>
          <ErrorNotice message={action.error} />
          <Button className="w-full" type="submit" disabled={action.busy || !name.trim()}>{action.busy ? t('tokens.issuing') : t('tokens.issue')}</Button>
        </form>}
    </Modal>
    <ConfirmDialog open={Boolean(revoke)} onOpenChange={value => { if (!value) setRevoke(undefined); }} title={t('tokens.revokeTitle')} description={t('tokens.revokeDescription', { name: revoke?.name ?? '' })} confirmLabel={t('tokens.revoke')} destructive onConfirm={revokeToken} busy={action.busy} error={action.error} />
  </Card>;
}

function Grants() {
  const grants = useApi<Grant[]>('/api/oauth/grants', 30_000);
  const action = useAction();
  const [revoke, setRevoke] = useState<Grant>();
  const revokeGrant = () => void action.run(async () => {
    await api('/api/oauth/grants/' + encodeURIComponent(revoke!.id), { method: 'DELETE' });
    setRevoke(undefined); grants.refresh(); toast.success(t('grants.revoked'));
  });
  return <Card>
    <CardHeader title={t('grants.title')} description={t('grants.description')} action={<ShieldCheck className="size-5 text-muted-foreground" />} />
    <div className="px-5 sm:px-6"><ErrorNotice message={grants.error} retry={grants.refresh} /></div>
    {!grants.data ? grants.loading ? <Loading /> : null : !grants.data.length ? <Empty title={t('grants.emptyTitle')} description={t('grants.emptyDescription')} icon={<Link2 className="size-5" />} /> :
      <ul className="divide-y border-t">{grants.data.map(grant => <li key={grant.id} className="flex items-center gap-3 px-5 py-3 sm:px-6">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{grant.clientName || t('grants.unnamed')}</p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{grant.clientId}</p></div>
        <span className="hidden text-xs text-muted-foreground sm:inline">{t('grants.expires')} <Time value={grant.expiresAt} /></span>
        <Button variant="outline" size="sm" onClick={() => { action.clearError(); setRevoke(grant); }}>{t('grants.revoke')}</Button>
      </li>)}</ul>}
    <ConfirmDialog open={Boolean(revoke)} onOpenChange={value => { if (!value) setRevoke(undefined); }} title={t('grants.revokeTitle')} description={t('grants.revokeDescription', { name: revoke?.clientName || revoke?.clientId || '' })} confirmLabel={t('grants.revoke')} destructive onConfirm={revokeGrant} busy={action.busy} error={action.error} />
  </Card>;
}

function Account({ username }: { username?: string }) {
  const action = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await post('/api/password', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); toast.success(t('account.passwordChanged'));
    });
  };
  return <Card><CardHeader title={t('account.title')} description={username} />
    <form className="max-w-md space-y-5 px-5 pb-5 sm:px-6 sm:pb-6" onSubmit={submit}>
      <Field label={t('account.currentPassword')} htmlFor="current-password"><Input id="current-password" type="password" autoComplete="current-password" required value={current} onChange={event => setCurrent(event.target.value)} /></Field>
      <Field label={t('account.newPassword')} htmlFor="new-password" hint={t('auth.passwordHint')}><Input id="new-password" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={event => setNext(event.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">{t('account.sessionsHint')}</p>
      <ErrorNotice message={action.error} />
      <Button type="submit" disabled={action.busy}>{action.busy ? t('account.changing') : t('account.changePassword')}</Button>
    </form>
  </Card>;
}

function General() {
  const settings = useSettings();
  const preferences = usePreferences();
  const locale = useLocale();
  const items: [string, ReactNode][] = settings.data ? [
    [t('general.version'), 'v' + settings.data.version], [t('general.agentVersion'), settings.data.agentVersion ?? '—'],
    [t('general.retention'), t('general.retentionValue', { n: settings.data.retentionDays })], [t('general.access'), t('general.accessValue')],
  ] : [];
  return <div className="space-y-5">
    <Card><CardHeader title={t('settings.display')} description={t('settings.displayHint')} />
      <div className="grid gap-5 px-5 pb-5 sm:grid-cols-2 sm:px-6 sm:pb-6 xl:grid-cols-3">
        <Field label={t('settings.language')}><Segmented label={t('settings.language')} value={locale} onChange={setLocale} options={locales.map(value => ({ value, label: <span lang={value}>{localeNames[value]}</span> }))} /></Field>
        <Field label={t('theme.label')}><Segmented label={t('theme.label')} value={preferences.theme} onChange={setThemePreference} options={(['system', 'light', 'dark'] as const).map(value => ({ value, label: t(`theme.${value}`) }))} /></Field>
        <Field label={t('settings.timeZone')} hint={t('settings.timeZoneHint')}><Segmented label={t('settings.timeZone')} value={preferences.timeZone} onChange={setTimeZonePreference} options={[{ value: 'local', label: t('settings.timeZoneLocal') }, { value: 'utc', label: 'UTC' }]} /></Field>
      </div>
    </Card>
    <Card><CardHeader title={t('general.about')} />
      <div className="px-5 pb-5 sm:px-6 sm:pb-6">{settings.data ? <Details className="lg:grid-cols-4" items={items} /> : <ErrorNotice message={settings.error} retry={settings.refresh} />}</div>
    </Card>
  </div>;
}

export function Settings({ username }: { username?: string }) {
  const settings = useSettings();
  const [query, setQuery] = useQueryState();
  const [creatingToken, setCreatingToken] = useState(false);
  const tab = query.get('tab') ?? 'general';
  const select = (value: string) => setQuery({ tab: value === 'general' ? undefined : value });
  return <div className="page-stack">
    <PageHeading title={t('settings.title')} description={t('settings.description')} />
    <Tabs value={tab} onValueChange={select}>
      <TabsList className="mb-5">
        <TabsTrigger value="general"><Monitor />{t('settings.tabGeneral')}</TabsTrigger>
        <TabsTrigger value="mcp"><Link2 />{t('settings.tabMcp')}</TabsTrigger>
        <TabsTrigger value="notifications"><Bell />{t('settings.tabNotifications')}</TabsTrigger>
        <TabsTrigger value="tokens"><KeyRound />{t('settings.tabTokens')}</TabsTrigger>
        <TabsTrigger value="oauth"><ShieldCheck />{t('settings.tabOauth')}</TabsTrigger>
        <TabsTrigger value="account"><UserRound />{t('settings.tabAccount')}</TabsTrigger>
      </TabsList>
      <TabsContent value="general"><General /></TabsContent>
      <TabsContent value="mcp">{settings.data ? <McpGuide url={settings.data.mcpUrl} onIssueToken={() => { select('tokens'); setCreatingToken(true); }} /> : <Loading />}</TabsContent>
      <TabsContent value="notifications"><Webhooks /></TabsContent>
      <TabsContent value="tokens"><Tokens creating={creatingToken} setCreating={setCreatingToken} /></TabsContent>
      <TabsContent value="oauth"><Grants /></TabsContent>
      <TabsContent value="account"><Account username={username} /></TabsContent>
    </Tabs>
  </div>;
}
