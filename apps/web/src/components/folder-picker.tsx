import { ArrowUp, Folder, FolderOpen, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { useApi } from '../lib/api';
import { cn } from '../lib/utils';
import { Button, ErrorNotice, Input } from './ui';

interface DirectoryListing { path: string; parent: string | null; directories: { name: string; path: string }[] }

/** A path field with a browser of the server's real folders; typing a path is always allowed. */
export function FolderPicker({ id, serverId, value, onChange, placeholder }: { id?: string; serverId?: string; value: string; onChange: (path: string) => void; placeholder?: string }) {
  const [browse, setBrowse] = useState<string>();
  useEffect(() => setBrowse(undefined), [serverId]);
  const listing = useApi<DirectoryListing>(serverId ? `/api/servers/${serverId}/directories` + (browse ? '?path=' + encodeURIComponent(browse) : '') : null);
  const open = (path: string) => { onChange(path); setBrowse(path); };
  return <div className="space-y-2">
    <div className="flex gap-2">
      <Input id={id} className="font-mono" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} required
        onKeyDown={event => { if (event.key === 'Enter' && serverId && value.trim()) { event.preventDefault(); setBrowse(value.trim()); } }} />
      {serverId && <Button type="button" variant="outline" disabled={!value.trim()} onClick={() => setBrowse(value.trim())}><FolderOpen />{t('folderPicker.open')}</Button>}
    </div>
    {serverId && <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1.5">
        <Button type="button" variant="ghost" size="icon" className="size-7" disabled={!listing.data?.parent || listing.loading} onClick={() => listing.data?.parent && open(listing.data.parent)} aria-label={t('folderPicker.up')}><ArrowUp /></Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={listing.data?.path}>{listing.data?.path ?? browse ?? '…'}</span>
        {listing.loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      {listing.error ? <div className="p-2"><ErrorNotice message={listing.error} /></div> : !listing.data ? <p className="px-3 py-4 text-xs text-muted-foreground">{t('folderPicker.loading')}</p>
        : !listing.data.directories.length ? <p className="px-3 py-4 text-xs text-muted-foreground">{t('folderPicker.empty')}</p>
          : <ul className="max-h-56 overflow-y-auto py-1">{listing.data.directories.map(directory => <li key={directory.path}>
            <button type="button" onClick={() => open(directory.path)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent', value === directory.path && 'bg-accent font-medium')}>
              <Folder className="size-4 shrink-0 text-muted-foreground" /><span className="truncate font-mono text-xs">{directory.name}</span>
            </button>
          </li>)}</ul>}
    </div>}
    <p className="text-xs text-muted-foreground">{serverId ? t('folderPicker.hint') : t('folderPicker.allServersHint')}</p>
  </div>;
}
