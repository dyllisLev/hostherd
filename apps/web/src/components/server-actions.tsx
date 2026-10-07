import { CircleArrowUp, MoreHorizontal, Pencil, SquareArrowOutUpRight, TerminalSquare, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { api, patch, post, useAction } from '../lib/api';
import { useServers } from '../lib/app-data';
import { navigate } from '../lib/router';
import type { Server } from '../lib/types';
import { manualUninstallCommand } from '../lib/uninstall';
import { CommandBlock } from './server-register';
import { Button, ConfirmDialog, ErrorNotice, Field, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, toast } from './ui';

type Operation = 'update' | 'rename' | 'delete';

/** Update, rename and delete flows for one server at a time. */
export function useServerActions({ afterDelete }: { afterDelete?: () => void } = {}) {
  const servers = useServers();
  const action = useAction();
  const [target, setTarget] = useState<{ server: Server; operation: Operation }>();
  const [name, setName] = useState('');
  const [uninstall, setUninstall] = useState(false);
  // Shown after the registration is gone but the agent could not remove itself.
  const [manual, setManual] = useState<{ server: Server; error?: string }>();
  const open = (server: Server, operation: Operation) => { action.clearError(); setName(server.name); setUninstall(false); setTarget({ server, operation }); };
  const close = () => setTarget(undefined);
  const server = target?.server;
  const run = (operation: () => Promise<void>, then?: () => void) => void action.run(async () => {
    await operation(); close(); servers.refresh();
    // Let the dialog close before the page that owns it unmounts.
    if (then) setTimeout(then, 0);
  });
  const update = () => run(async () => {
    await post('/api/servers/' + server!.id + '/update');
    toast.success(t('servers.updateRequested', { name: server!.name }), { description: t('servers.updateRequestedHint') });
  });
  const uninstalling = uninstall && !!server?.canUninstall;
  const remove = () => {
    const removing = server!;
    let failed = false;
    run(async () => {
      const result = await api<{ uninstall?: { status: 'accepted' | 'failed'; error?: string } }>('/api/servers/' + removing.id, { method: 'DELETE', ...(uninstalling ? { body: JSON.stringify({ uninstall: true }) } : {}) });
      if (result.uninstall?.status === 'failed') {
        // The registration is gone; leave the page after the manual commands are closed.
        failed = true;
        setManual({ server: removing, error: result.uninstall.error });
        return;
      }
      toast.success(t(uninstalling ? 'servers.deletedUninstalling' : 'servers.deleted', { name: removing.name }), uninstalling ? { description: t('servers.deletedUninstallingHint') } : undefined);
    }, () => { if (!failed) afterDelete?.(); });
  };
  const closeManual = () => { setManual(undefined); afterDelete?.(); };
  const rename = (event: FormEvent) => { event.preventDefault(); run(async () => { await patch('/api/servers/' + server!.id, { name: name.trim() }); toast.success(t('servers.renamed')); }); };
  const clearFault = (item: Server) => void action.run(async () => {
    await api('/api/servers/' + item.id + '/fault', { method: 'DELETE' });
    servers.refresh();
  });
  const dialogs = <>
    <ConfirmDialog open={target?.operation === 'update'} onOpenChange={value => { if (!value) close(); }} title={t('servers.updateTitle')} description={t('servers.updateDescription', { name: server?.name ?? '' })} confirmLabel={t('servers.update')} onConfirm={update} busy={action.busy} error={action.error} />
    <ConfirmDialog open={target?.operation === 'delete'} onOpenChange={value => { if (!value) close(); }} title={t('servers.deleteTitle')} description={uninstalling ? t('servers.deleteUninstallDescription') : t('servers.deleteDescription')} confirmLabel={uninstalling ? t('servers.deleteAndUninstall') : t('servers.delete')} onConfirm={remove} busy={action.busy} error={action.error} destructive confirmText={server?.name}>
      {server && <UninstallOption server={server} checked={uninstall} onChange={setUninstall} />}
    </ConfirmDialog>
    <Modal open={!!manual} onOpenChange={value => { if (!value) closeManual(); }} className="max-w-xl" title={t('servers.uninstallFailedTitle')} description={t('servers.uninstallFailedDescription', { name: manual?.server.name ?? '' })}>
      <div className="space-y-4">
        {manual?.error && <ErrorNotice message={manual.error} />}
        {manual && <CommandBlock label={t('servers.manualUninstall')} command={manualUninstallCommand(manual.server.os)} />}
        <p className="text-xs leading-relaxed text-muted-foreground">{t('servers.manualUninstallHint')}</p>
        <div className="flex justify-end"><Button onClick={closeManual}>{t('common.close')}</Button></div>
      </div>
    </Modal>
    <Modal open={target?.operation === 'rename'} onOpenChange={value => { if (!value) close(); }} title={t('servers.renameTitle')}>
      <form className="space-y-5" onSubmit={rename}>
        <Field label={t('servers.name')} htmlFor="server-rename"><Input id="server-rename" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoFocus /></Field>
        <ErrorNotice message={action.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={close}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy || !name.trim() || name.trim() === server?.name}>{t('common.save')}</Button></div>
      </form>
    </Modal>
  </>;
  return { open, clearFault, dialogs, error: target ? undefined : action.error };
}

/** Agent removal choice in the delete dialog, or manual commands when the agent cannot remove itself. */
function UninstallOption({ server, checked, onChange }: { server: Server; checked: boolean; onChange: (value: boolean) => void }) {
  const available = !!server.canUninstall;
  return <div className="space-y-3">
    <label className={'flex items-start gap-2 text-sm' + (available ? '' : ' opacity-60')}>
      <input type="checkbox" className="mt-1 accent-primary" disabled={!available} checked={available && checked} onChange={event => onChange(event.target.checked)} />
      <span>{t('servers.uninstallAgent')}<span className="mt-0.5 block text-xs text-muted-foreground">{available ? t('servers.uninstallAgentHint') : t('servers.uninstallNeedsOnline')}</span></span>
    </label>
    {available && checked && <div role="alert" className="rounded-lg border tone-warning p-3 text-sm leading-relaxed">{t('servers.uninstallWarning')}</div>}
    {!available && <details className="text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('servers.manualUninstallToggle')}</summary>
      <div className="mt-2 space-y-2"><CommandBlock label={t('servers.manualUninstall')} command={manualUninstallCommand(server.os)} /><p className="text-xs leading-relaxed text-muted-foreground">{t('servers.manualUninstallHint')}</p></div>
    </details>}
  </div>;
}

export function ServerMenu({ server, onAction, detail = true }: { server: Server; onAction: (server: Server, operation: Operation) => void; detail?: boolean }) {
  return <Menu>
    <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('servers.actionsFor', { name: server.name })}><MoreHorizontal /></Button></MenuTrigger>
    <MenuContent>
      {detail && <MenuItem onSelect={() => navigate('/servers/' + server.id)}><SquareArrowOutUpRight />{t('servers.viewDetail')}</MenuItem>}
      <MenuItem onSelect={() => navigate('/terminals?server=' + encodeURIComponent(server.id))}><TerminalSquare />{t('servers.terminals')}</MenuItem>
      <MenuItem disabled={!server.online} onSelect={() => onAction(server, 'update')}><CircleArrowUp />{t('servers.updateAgent')}</MenuItem>
      <MenuItem onSelect={() => onAction(server, 'rename')}><Pencil />{t('servers.rename')}</MenuItem>
      <MenuSeparator />
      <MenuItem destructive onSelect={() => onAction(server, 'delete')}><Trash2 />{t('servers.delete')}</MenuItem>
    </MenuContent>
  </Menu>;
}
