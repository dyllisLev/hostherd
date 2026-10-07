import { CheckCircle2, LoaderCircle, TimerOff } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { post, useAction } from '../lib/api';
import { useServers } from '../lib/app-data';
import { navigate } from '../lib/router';
import { formatDateTime } from '../lib/time';
import { cn } from '../lib/utils';
import { Button, CopyButton, ErrorNotice, Field, Input, Modal, Segmented } from './ui';

interface Enrollment { code: string; expiresAt: string; command: string; windowsCommand?: string }

export function CommandBlock({ label, command }: { label: string; command: string }) {
  return <div className="rounded-lg border bg-muted/40">
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2"><p className="text-xs font-medium">{label}</p><CopyButton value={command} /></div>
    <pre className="max-h-48 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{command}</pre>
  </div>;
}

function useCountdown(until?: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!until) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [until]);
  return until ? Math.max(0, Math.floor((Date.parse(until) - now) / 1000)) : 0;
}

/** Issue an install command, then wait for the new agent to connect. */
export function ServerRegister({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const servers = useServers();
  const action = useAction();
  const [name, setName] = useState('');
  const [os, setOs] = useState<'linux' | 'darwin' | 'windows'>('linux');
  const [asSystem, setAsSystem] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [known, setKnown] = useState<Set<string>>(new Set());
  const remaining = useCountdown(enrollment?.expiresAt);
  useEffect(() => { if (open) { setName(''); setEnrollment(undefined); action.clearError(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // The installer registers first; the service then connects.
  const found = useMemo(() => enrollment && servers.data?.find(server => !known.has(server.id) && server.name === name.trim()), [enrollment, servers.data, known, name]);
  const connected = found?.online ? found : undefined;
  const issue = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      setKnown(new Set(servers.data?.map(server => server.id)));
      setEnrollment(await post<Enrollment>('/api/enrollments', { name: name.trim() }));
    });
  };
  const expired = enrollment && !found && remaining === 0;
  const step = !enrollment ? 1 : connected ? 3 : 2;
  return <Modal open={open} onOpenChange={onOpenChange} className="max-w-xl" title={t('register.title')} description={t('register.description')}>
    <ol className="mb-6 flex items-center gap-2 text-xs" aria-label={t('register.steps')}>
      {(['register.stepName', 'register.stepInstall', 'register.stepConnect'] as const).map((label, index) => <li key={label} className="flex flex-1 items-center gap-2" aria-current={step === index + 1 ? 'step' : undefined}>
        <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold', step > index + 1 ? 'border-success bg-success text-background' : step === index + 1 ? 'border-foreground text-foreground' : 'text-muted-foreground')}>{step > index + 1 ? '✓' : index + 1}</span>
        <span className={cn('truncate', step === index + 1 ? 'font-medium' : 'text-muted-foreground')}>{t(label)}</span>
        {index < 2 && <span className="h-px flex-1 bg-border" />}
      </li>)}
    </ol>
    {!enrollment ? <form className="space-y-5" onSubmit={issue}>
      <Field label={t('servers.name')} htmlFor="server-name" hint={t('register.nameHint')}><Input id="server-name" placeholder={t('register.namePlaceholder')} value={name} onChange={event => setName(event.target.value)} required maxLength={80} autoFocus /></Field>
      <ErrorNotice message={action.error} />
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" disabled={action.busy || !name.trim()}>{action.busy ? t('register.issuing') : t('register.issue')}</Button></div>
    </form> : connected ? <div className="space-y-5 text-center">
      <CheckCircle2 className="mx-auto size-10 text-success" />
      <div><p className="font-semibold">{t('register.connectedTitle', { name: connected.name })}</p><p className="mt-1.5 text-sm text-muted-foreground">{t('register.connectedDescription', { user: connected.executionUser, host: connected.hostname || '—' })}</p></div>
      <div className="flex justify-center gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button><Button onClick={() => { onOpenChange(false); navigate('/servers/' + connected.id); }}>{t('register.openServer')}</Button></div>
    </div> : <div className="space-y-4">
      <Segmented label={t('register.platform')} value={os} onChange={setOs} options={[{ value: 'linux', label: 'Linux' }, { value: 'darwin', label: 'macOS' }, ...(enrollment.windowsCommand ? [{ value: 'windows' as const, label: 'Windows' }] : [])]} />
      {os === 'darwin' && <CommandBlock label={t('register.macPrerequisite')} command="brew install openssl@3" />}
      {os === 'windows' && enrollment.windowsCommand ? <>
        <CommandBlock label={t('register.windowsInstall')} command={enrollment.windowsCommand + (asSystem ? ' -RunAsSystem' : '')} />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={asSystem} onChange={event => setAsSystem(event.target.checked)} /><span>{t('register.windowsSystem')}<span className="mt-0.5 block text-xs text-muted-foreground">{t('register.windowsSystemHint')}</span></span></label>
        <p className="text-xs leading-relaxed text-muted-foreground">{asSystem ? t('register.windowsSystemAccount') : t('register.windowsAccountHint')}</p>
      </> : <>
        <CommandBlock label={os === 'darwin' ? t('register.macInstall') : t('register.linuxInstall')} command={enrollment.command} />
        <p className="text-xs leading-relaxed text-muted-foreground">{t('register.accountHint')}</p>
      </>}
      <div className={cn('flex items-center gap-3 rounded-lg border p-3 text-sm', expired ? 'tone-warning' : 'bg-muted/30')} role="status">
        {expired ? <TimerOff className="size-4 shrink-0" /> : <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        <div className="min-w-0 flex-1">{expired ? t('register.expired') : <><p className="font-medium">{found ? t('register.registered') : t('register.waiting')}</p>{!found && <p className="mt-0.5 text-xs text-muted-foreground">{t('register.expiresIn', { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`, at: formatDateTime(enrollment.expiresAt) })}</p>}</>}</div>
        {expired && <Button size="sm" variant="outline" onClick={() => setEnrollment(undefined)}>{t('register.reissue')}</Button>}
      </div>
    </div>}
  </Modal>;
}
