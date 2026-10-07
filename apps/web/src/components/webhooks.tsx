import { Bell, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { t, type MessageKey } from '../i18n';
import { api, patch, post, useAction, useApi } from '../lib/api';
import type { Webhook, WebhookEvent, WebhookKind } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Empty, ErrorNotice, Field, Input, Loading, Modal, Segmented, Time, toast } from './ui';

const EVENTS: WebhookEvent[] = ['approval', 'offline', 'fault', 'usage', 'job_failed'];
const DEFAULT_EVENTS: WebhookEvent[] = ['approval', 'offline', 'fault', 'usage'];
const KINDS: WebhookKind[] = ['generic', 'slack', 'discord', 'telegram'];
const eventLabel = (event: WebhookEvent) => t(`webhooks.event.${event}` as MessageKey);

interface Draft { name: string; kind: WebhookKind; url: string; botToken: string; chatId: string; secret: string; clearSecret: boolean; events: WebhookEvent[]; enabled: boolean }
const empty: Draft = { name: '', kind: 'generic', url: '', botToken: '', chatId: '', secret: '', clearSecret: false, events: DEFAULT_EVENTS, enabled: true };

function WebhookForm({ editing, onDone }: { editing?: Webhook; onDone: () => void }) {
  const action = useAction();
  const [draft, setDraft] = useState<Draft>(editing ? { ...empty, name: editing.name, kind: editing.kind, chatId: editing.chatId ?? '', events: editing.events, enabled: editing.enabled } : empty);
  const set = (values: Partial<Draft>) => setDraft(current => ({ ...current, ...values }));
  const keep = editing && editing.kind === draft.kind;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      const body = {
        name: draft.name, kind: draft.kind, events: draft.events, enabled: draft.enabled,
        ...(draft.kind === 'telegram' ? { chatId: draft.chatId, ...(draft.botToken ? { botToken: draft.botToken } : {}) } : draft.url ? { url: draft.url } : {}),
        ...(draft.kind === 'generic' ? draft.secret ? { secret: draft.secret } : draft.clearSecret ? { secret: null } : {} : {}),
      };
      if (editing) await patch('/api/webhooks/' + editing.id, body); else await post('/api/webhooks', body);
      toast.success(t(editing ? 'webhooks.saved' : 'webhooks.added'));
      onDone();
    });
  };
  const toggle = (event: WebhookEvent) => set({ events: draft.events.includes(event) ? draft.events.filter(item => item !== event) : [...draft.events, event] });
  return <form className="space-y-5" onSubmit={submit}>
    <Field label={t('webhooks.name')} htmlFor="webhook-name"><Input id="webhook-name" required maxLength={80} value={draft.name} onChange={event => set({ name: event.target.value })} placeholder={t('webhooks.namePlaceholder')} autoFocus /></Field>
    <Field label={t('webhooks.kind')}><Segmented label={t('webhooks.kind')} value={draft.kind} onChange={kind => set({ kind })} options={KINDS.map(value => ({ value, label: t(`webhooks.kinds.${value}`) }))} className="max-w-full overflow-x-auto" /></Field>
    {draft.kind === 'telegram' ? <>
      <Field label={t('webhooks.botToken')} hint={keep ? t('webhooks.keepHint') : t('webhooks.botTokenHint')} htmlFor="webhook-token"><Input id="webhook-token" className="font-mono" autoComplete="off" required={!keep} value={draft.botToken} onChange={event => set({ botToken: event.target.value })} placeholder="123456789:AA…" /></Field>
      <Field label={t('webhooks.chatId')} hint={t('webhooks.chatIdHint')} htmlFor="webhook-chat"><Input id="webhook-chat" className="font-mono" required value={draft.chatId} onChange={event => set({ chatId: event.target.value })} placeholder="-1001234567890" /></Field>
    </> : <Field label={t('webhooks.url')} hint={keep ? t('webhooks.keepHint') : t(`webhooks.urlHint.${draft.kind}` as MessageKey)} htmlFor="webhook-url">
      <Input id="webhook-url" className="font-mono" type="url" autoComplete="off" required={!keep} value={draft.url} onChange={event => set({ url: event.target.value })} placeholder="https://…" /></Field>}
    {draft.kind === 'generic' && <Field label={t('webhooks.secret')} hint={t('webhooks.secretHint')} htmlFor="webhook-secret">
      <Input id="webhook-secret" autoComplete="off" value={draft.secret} onChange={event => set({ secret: event.target.value, clearSecret: false })} placeholder={editing?.hasSecret ? t('webhooks.secretKept') : ''} />
      {editing?.hasSecret && <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={draft.clearSecret} onChange={event => set({ clearSecret: event.target.checked, secret: '' })} />{t('webhooks.clearSecret')}</label>}
    </Field>}
    <fieldset><legend className="mb-2 text-sm font-medium">{t('webhooks.events')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">{EVENTS.map(event => <label key={event} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', draft.events.includes(event) && 'border-foreground/40 bg-muted/40')}>
        <input type="checkbox" className="mt-0.5" checked={draft.events.includes(event)} onChange={() => toggle(event)} />
        <span><span className="block font-medium">{eventLabel(event)}</span><span className="block text-xs text-muted-foreground">{t(`webhooks.eventHint.${event}` as MessageKey)}</span></span>
      </label>)}</div>
    </fieldset>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => set({ enabled: event.target.checked })} />{t('webhooks.enabled')}</label>
    <ErrorNotice message={action.error} />
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onDone}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy || !draft.name.trim()}>{action.busy ? t('common.working') : t(editing ? 'common.save' : 'webhooks.add')}</Button></div>
  </form>;
}

export function Webhooks() {
  const hooks = useApi<Webhook[]>('/api/webhooks');
  const action = useAction();
  const [form, setForm] = useState<{ editing?: Webhook } | null>(null);
  const [removing, setRemoving] = useState<Webhook>();
  const test = (hook: Webhook) => void action.run(async () => {
    const result = await post<Webhook & { ok: boolean; error?: string }>(`/api/webhooks/${hook.id}/test`);
    hooks.refresh();
    if (result.ok) toast.success(t('webhooks.testSent', { name: hook.name })); else toast.error(t('webhooks.testFailed', { error: result.error ?? '' }));
  });
  const toggle = (hook: Webhook) => void action.run(async () => { await patch('/api/webhooks/' + hook.id, { enabled: !hook.enabled }); hooks.refresh(); });
  const remove = () => void action.run(async () => {
    await api('/api/webhooks/' + removing!.id, { method: 'DELETE' });
    setRemoving(undefined); hooks.refresh(); toast.success(t('webhooks.removed'));
  });
  return <Card>
    <CardHeader title={t('webhooks.title')} description={t('webhooks.description')} action={<Button variant="outline" size="sm" onClick={() => setForm({})}><Plus />{t('webhooks.add')}</Button>} />
    <div className="px-5 sm:px-6"><ErrorNotice message={hooks.error ?? (removing ? undefined : action.error)} retry={hooks.error ? hooks.refresh : undefined} /></div>
    {!hooks.data ? hooks.loading ? <Loading /> : null : !hooks.data.length ? <Empty title={t('webhooks.emptyTitle')} description={t('webhooks.emptyDescription')} icon={<Bell className="size-5" />} /> :
      <ul className="divide-y border-t">{hooks.data.map(hook => <li key={hook.id} className="flex flex-col gap-3 px-5 py-4 sm:px-6 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{hook.name}</span><Badge>{t(`webhooks.kinds.${hook.kind}`)}</Badge>{!hook.enabled && <Badge tone="neutral">{t('webhooks.disabled')}</Badge>}</div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{hook.target}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">{hook.events.length ? hook.events.map(event => <Badge key={event} tone="info">{eventLabel(event)}</Badge>) : <span className="text-xs text-muted-foreground">{t('webhooks.noEvents')}</span>}</div>
          <div className="mt-2 text-xs text-muted-foreground">{hook.lastAt ? <>{t('webhooks.lastDelivery')} <Time value={hook.lastAt} relative /> · <span className={hook.lastStatus === 'ok' ? 'text-success' : 'text-danger'}>{hook.lastStatus === 'ok' ? t('webhooks.ok') : hook.lastError}</span></> : t('webhooks.neverSent')}</div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={action.busy} onClick={() => test(hook)}><Send />{t('webhooks.test')}</Button>
          <Button variant="outline" size="sm" disabled={action.busy} onClick={() => toggle(hook)}>{hook.enabled ? t('webhooks.disable') : t('webhooks.enable')}</Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('webhooks.editFor', { name: hook.name })} onClick={() => setForm({ editing: hook })}><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('webhooks.removeFor', { name: hook.name })} onClick={() => { action.clearError(); setRemoving(hook); }}><Trash2 /></Button>
        </div>
      </li>)}</ul>}
    <Modal open={Boolean(form)} onOpenChange={value => { if (!value) setForm(null); }} title={t(form?.editing ? 'webhooks.editTitle' : 'webhooks.addTitle')} description={t('webhooks.formDescription')}>
      {form && <WebhookForm key={form.editing?.id ?? 'new'} editing={form.editing} onDone={() => { setForm(null); hooks.refresh(); }} />}
    </Modal>
    <ConfirmDialog open={Boolean(removing)} onOpenChange={value => { if (!value) setRemoving(undefined); }} title={t('webhooks.removeTitle')} description={t('webhooks.removeDescription', { name: removing?.name ?? '' })} confirmLabel={t('webhooks.remove')} destructive onConfirm={remove} busy={action.busy} error={action.error} />
  </Card>;
}
