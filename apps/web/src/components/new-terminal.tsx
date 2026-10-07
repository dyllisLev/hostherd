import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { post, useAction } from '../lib/api';
import { useServers } from '../lib/app-data';
import { navigate } from '../lib/router';
import type { Job } from '../lib/types';
import { Button, ErrorNotice, Field, Input, Modal, Select } from './ui';

/** Starts a persistent shell on an online server and opens it. */
export function NewTerminalDialog({ open, onOpenChange, serverFilter, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; serverFilter?: string; onCreated?: () => void }) {
  const servers = useServers();
  const action = useAction();
  const [server, setServer] = useState(serverFilter ?? '');
  const [path, setPath] = useState('/');
  const [label, setLabel] = useState('');
  useEffect(() => { if (open) { setLabel(''); action.clearError(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const available = servers.data?.filter(item => item.online) ?? [];
  const selected = available.some(item => item.id === server) ? server : available[0]?.id ?? '';
  const windows = available.find(item => item.id === selected)?.os === 'windows';
  // Follow the server's path style unless the user typed their own path.
  useEffect(() => { setPath(current => current === '/' || current === 'C:\\' ? (windows ? 'C:\\' : '/') : current); }, [windows]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      const job = await post<Job>('/api/terminals', { serverId: selected, path: path.trim(), label: label.trim() || undefined, cols: 100, rows: 30 });
      onOpenChange(false); onCreated?.();
      navigate('/terminals/' + job.id);
    });
  };
  return <Modal open={open} onOpenChange={onOpenChange} title={t('terminals.newTitle')} description={t('terminals.newDescription')}>
    <form className="space-y-5" onSubmit={submit}>
      <Field label={t('terminals.server')} htmlFor="terminal-server" hint={!available.length ? t('terminals.noOnlineServers') : undefined}><Select id="terminal-server" className="w-full" value={selected} onChange={event => setServer(event.target.value)} required>{!available.length && <option value="">—</option>}{available.map(item => <option key={item.id} value={item.id}>{item.name} · {item.executionUser}</option>)}</Select></Field>
      <Field label={t('terminals.startPath')} htmlFor="terminal-path"><Input id="terminal-path" className="font-mono" value={path} onChange={event => setPath(event.target.value)} required placeholder={windows ? 'C:\\' : '/'} /></Field>
      <Field label={t('terminals.name')} htmlFor="terminal-label" hint={t('terminals.nameHint')}><Input id="terminal-label" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder={t('terminals.namePlaceholder')} /></Field>
      <ErrorNotice message={action.error} />
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy || !selected || !path.trim()}>{action.busy ? t('terminals.connecting') : t('terminals.open')}</Button></div>
    </form>
  </Modal>;
}
