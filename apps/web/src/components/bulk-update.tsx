import { CircleArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { errorMessage, post } from '../lib/api';
import { useServerHealth, useServers } from '../lib/app-data';
import { Button, Modal, Status, toast, Tooltip } from './ui';
import { OsIcon } from './brand';

/** Requests the latest agent on every selected outdated, online server. */
export function BulkUpdate() {
  const servers = useServers();
  const health = useServerHealth();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const online = health.updates.filter(server => server.online);
  const offline = health.updates.filter(server => !server.online);
  useEffect(() => { if (open) setSelected(new Set(online.map(server => server.id))); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const run = async () => {
    setBusy(true);
    const targets = online.filter(server => selected.has(server.id));
    const results = await Promise.allSettled(targets.map(server => post('/api/servers/' + server.id + '/update')));
    setBusy(false); setOpen(false); servers.refresh();
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${targets[index].name}: ${errorMessage(result.reason)}`] : []);
    const succeeded = targets.length - failed.length;
    if (succeeded) toast.success(t('bulkUpdate.requested', { n: succeeded }), { description: t('servers.updateRequestedHint') });
    if (failed.length) toast.error(t('bulkUpdate.failed', { n: failed.length }), { description: failed.join('\n'), duration: 15_000 });
  };
  const button = <Button variant="outline" disabled={!online.length} onClick={() => setOpen(true)}><CircleArrowUp />{t('bulkUpdate.button')}{online.length > 0 && <span className="rounded-full bg-info-soft px-1.5 text-xs text-info tabular-nums">{online.length}</span>}</Button>;
  return <>
    {online.length ? button : <Tooltip content={health.latest ? t('bulkUpdate.allCurrent', { version: health.latest }) : undefined}><span>{button}</span></Tooltip>}
    <Modal open={open} onOpenChange={setOpen} title={t('bulkUpdate.title')} description={t('bulkUpdate.description', { version: health.latest ?? '' })}>
      <ul className="max-h-80 space-y-1 overflow-y-auto">
        {online.map(server => <li key={server.id}><label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent">
          <input type="checkbox" className="accent-primary" checked={selected.has(server.id)} onChange={() => toggle(server.id)} />
          <OsIcon os={server.os} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{server.name}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{server.version} → {health.latest}</span>
        </label></li>)}
        {offline.map(server => <li key={server.id} className="flex items-center gap-3 px-2 py-2 opacity-60">
          <input type="checkbox" disabled aria-label={server.name} />
          <OsIcon os={server.os} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{server.name}</span>
          <Status status="offline" />
        </li>)}
      </ul>
      {offline.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{t('bulkUpdate.offlineHint')}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
        <Button disabled={busy || !selected.size} onClick={() => void run()}>{busy ? t('common.working') : t('bulkUpdate.confirm', { n: selected.size })}</Button>
      </div>
    </Modal>
  </>;
}
