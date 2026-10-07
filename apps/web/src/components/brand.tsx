import { Apple, Monitor, Server as ServerIcon } from 'lucide-react';
import { cn } from '../lib/utils';

export function Logo({ className }: { className?: string }) {
  return <svg viewBox="0 0 64 64" aria-hidden="true" className={cn('size-8 shrink-0', className)}>
    <rect width="64" height="64" rx="16" className="fill-primary" />
    <path d="M20 47V30a12 12 0 0 1 24 0v17M14 47h36" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="stroke-primary-foreground" />
    <path d="M32 37v10" fill="none" strokeWidth="5" strokeLinecap="round" className="stroke-primary-foreground" />
  </svg>;
}

export function OsIcon({ os, className }: { os?: string; className?: string }) {
  const Icon = os === 'darwin' ? Apple : os === 'windows' ? Monitor : ServerIcon;
  return <Icon className={cn('size-4', className)} aria-hidden="true" />;
}

export function osName(os?: string) {
  if (os === 'darwin') return 'macOS';
  if (os === 'linux') return 'Linux';
  if (os === 'windows') return 'Windows';
  return os || '—';
}
