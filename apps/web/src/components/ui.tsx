// shadcn/ui component patterns, MIT. See THIRD_PARTY.md.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, ArrowLeft, Check, Copy, Inbox, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { Link } from '../lib/router';
import { formatDateTime, formatFullDateTime, formatRelative } from '../lib/time';
import { cn } from '../lib/utils';

export { toast } from 'sonner';

const buttonVariants = cva('inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
      outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
      ghost: 'hover:bg-accent hover:text-accent-foreground',
      destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
    },
    size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3 text-xs', icon: 'size-9', 'icon-sm': 'size-8' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({ className, variant, size, asChild = false, ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('rounded-xl border bg-card text-card-foreground shadow-xs', className)} {...props} />;
}
export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6', className)}>
    <div className="min-w-0 space-y-1"><h2 className="font-semibold tracking-tight">{title}</h2>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>{action}
  </div>;
}
const fieldClass = 'w-full min-w-0 rounded-md border bg-transparent text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50';
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn('flex h-9 px-3 py-1', fieldClass, className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn('min-h-24 resize-y p-3', fieldClass, className)} {...props} />;
}
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn('h-9 rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', className)} {...props} />;
}
export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return <div className="space-y-2"><label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>{children}{hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>;
}

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';
const dotTone: Record<Tone, string> = { neutral: 'bg-muted-foreground/60', success: 'bg-success', info: 'bg-info', warning: 'bg-warning', danger: 'bg-danger' };
export function Badge({ children, className, tone }: { children: ReactNode; className?: string; tone?: Tone }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone && 'tone-' + tone, className)}>{children}</span>;
}
export function Dot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span className={cn('relative inline-flex size-2 shrink-0 rounded-full', dotTone[tone], className)}>{pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', dotTone[tone])} />}</span>;
}
const statusTone: Record<string, Tone> = { online: 'success', completed: 'success', running: 'info', pending: 'neutral', unknown: 'warning', interrupted: 'warning', lost: 'warning', failed: 'danger', offline: 'neutral' };
export function statusLabel(status: string) {
  const key = 'status.' + status;
  const label = t(key as never);
  return label === key ? status : label;
}
export function Status({ status }: { status: string }) {
  const tone = statusTone[status] ?? 'neutral';
  return <Badge tone={tone}><Dot tone={tone} pulse={status === 'running'} />{statusLabel(status)}</Badge>;
}

export function ErrorNotice({ message, retry }: { message?: string; retry?: () => void }) {
  if (!message) return null;
  return <div role="alert" className="flex items-start gap-3 rounded-lg border tone-danger p-3 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0" /><p className="min-w-0 flex-1 break-words">{message}</p>{retry && <button className="shrink-0 underline underline-offset-2" onClick={retry}>{t('common.retry')}</button>}</div>;
}
export function Loading({ label = t('common.loading') }: { label?: string }) {
  return <div role="status" className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{label}</div>;
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}
export function Empty({ title, description, action, icon, className }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col items-center justify-center px-5 py-14 text-center', className)}><div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground">{icon || <Inbox className="size-5" />}</div><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>}{action && <div className="mt-5">{action}</div>}</div>;
}
export function PageHeading({ title, description, action, back }: { title: ReactNode; description?: ReactNode; action?: ReactNode; back?: { href: string; label: string } }) {
  return <div>
    {back && <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2 text-muted-foreground"><Link href={back.href}><ArrowLeft />{back.label}</Link></Button>}
    <div className="flex flex-wrap items-center justify-between gap-4"><div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{description && <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</div>}</div>{action && <div className="flex flex-wrap items-center gap-2">{action}</div>}</div>
  </div>;
}
export function CopyButton({ value, label = t('common.copy'), size = 'sm', variant = 'outline' }: { value: string; label?: string; size?: 'sm' | 'icon-sm'; variant?: 'outline' | 'ghost' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => { if (state === 'idle') return; const timer = setTimeout(() => setState('idle'), 2000); return () => clearTimeout(timer); }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setState('copied'); }
    catch { setState('error'); }
  };
  const text = state === 'copied' ? t('common.copied') : state === 'error' ? t('common.copyManually') : label;
  return <Button type="button" size={size} variant={variant} onClick={() => void copy()} aria-label={size === 'icon-sm' ? text : undefined} title={size === 'icon-sm' ? text : undefined}>{state === 'copied' ? <Check /> : <Copy />}{size !== 'icon-sm' && text}</Button>;
}
export function Modal({ open, onOpenChange, title, description, children, className }: { open: boolean; onOpenChange: (value: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
      <DialogPrimitive.Content className={cn('fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-6 shadow-xl outline-none', className)}>
        <DialogPrimitive.Title className="pr-7 text-lg font-semibold tracking-tight">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description asChild><div className={cn('mt-2 text-sm leading-relaxed text-muted-foreground', !description && 'sr-only')}>{description || title}</div></DialogPrimitive.Description>
        <div className="mt-6">{children}</div>
        <DialogPrimitive.Close className="absolute top-5 right-5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /><span className="sr-only">{t('common.close')}</span></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/** Confirmation for consequential actions; `confirmText` must be typed to enable it. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, busyLabel = t('common.working'), onConfirm, destructive = false, confirmText, error, busy, children }: {
  open: boolean; onOpenChange: (value: boolean) => void; title: string; description?: ReactNode; confirmLabel: string; busyLabel?: string; onConfirm: () => void;
  destructive?: boolean; confirmText?: string; error?: string; busy?: boolean; children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!open) setTyped(''); }, [open]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!confirmText || typed === confirmText) onConfirm(); };
  return <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}>
    <form className="space-y-5" onSubmit={submit}>
      {children}
      {confirmText && <Field label={t('common.typeToConfirm', { text: confirmText })} htmlFor="confirm-text"><Input id="confirm-text" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" autoFocus /></Field>}
      <ErrorNotice message={error} />
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy || (!!confirmText && typed !== confirmText)}>{busy ? busyLabel : confirmLabel}</Button></div>
    </form>
  </Modal>;
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return <TooltipPrimitive.Root delayDuration={300}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal><TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-relaxed text-background shadow-md">{content}</TooltipPrimitive.Content></TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}
export const TooltipProvider = TooltipPrimitive.Provider;

function useNow(interval = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}
/** A timestamp shown relative ("3 minutes ago") or absolute, with the full time on hover. */
export function Time({ value, relative = false, className }: { value?: string | null; relative?: boolean; className?: string }) {
  const now = useNow();
  if (!value) return <span className={className}>—</span>;
  return <Tooltip content={formatFullDateTime(value)}><time dateTime={value} className={cn('whitespace-nowrap', className)}>{relative ? formatRelative(value, now) : formatDateTime(value)}</time></Tooltip>;
}

// Non-modal so dialogs opened from a menu item manage pointer locking alone.
export function Menu(props: ComponentProps<typeof MenuPrimitive.Root>) { return <MenuPrimitive.Root modal={false} {...props} />; }
export const MenuTrigger = MenuPrimitive.Trigger;
export function MenuContent({ className, align = 'end', ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return <MenuPrimitive.Portal><MenuPrimitive.Content align={align} sideOffset={6} className={cn('z-50 min-w-44 rounded-lg border bg-popover p-1 text-sm shadow-lg', className)} {...props} /></MenuPrimitive.Portal>;
}
export function MenuItem({ className, destructive = false, ...props }: ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean }) {
  return <MenuPrimitive.Item className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground', destructive && 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger', className)} {...props} />;
}
export function MenuSeparator() { return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />; }
export function MenuLabel({ children }: { children: ReactNode }) { return <MenuPrimitive.Label className="px-2.5 py-1.5 text-xs text-muted-foreground">{children}</MenuPrimitive.Label>; }
export const MenuRadioGroup = MenuPrimitive.RadioGroup;
export function MenuRadioItem({ children, ...props }: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return <MenuPrimitive.RadioItem className="flex items-center gap-2.5 rounded-md py-2 pr-2.5 pl-8 outline-none select-none data-[highlighted]:bg-accent relative" {...props}><MenuPrimitive.ItemIndicator className="absolute left-2.5"><Check className="size-4" /></MenuPrimitive.ItemIndicator>{children}</MenuPrimitive.RadioItem>;
}

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex gap-1 overflow-x-auto border-b', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn('-mb-px inline-flex items-center gap-2 rounded-t-md border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground [&_svg]:size-4', className)} {...props} />;
}

/** Compact single-choice toggle group. */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (value: T) => void; options: { value: T; label: ReactNode }[]; label: string; className?: string }) {
  return <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg bg-muted p-1', className)}>{options.map(option => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)} className={cn('flex-1 rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors', value === option.value ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{option.label}</button>)}</div>;
}

export function Details({ items, className }: { items: [string, ReactNode][]; className?: string }) {
  return <dl className={cn('grid grid-cols-2 gap-x-6 gap-y-4 text-sm', className)}>{items.map(([label, value]) => <div key={label} className="min-w-0"><dt className="mb-1 text-xs text-muted-foreground">{label}</dt><dd className="break-words">{value ?? '—'}</dd></div>)}</dl>;
}
