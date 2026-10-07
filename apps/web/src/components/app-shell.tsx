import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Activity, ChevronsUpDown, LayoutDashboard, LogOut, Monitor, Moon, PanelLeft, ScrollText, Server, Settings as SettingsIcon, ShieldAlert, Sun, TerminalSquare, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { localeNames, locales, setLocale, t, useLocale, type Locale, type MessageKey } from '../i18n';
import { usePendingApprovals, useServerHealth } from '../lib/app-data';
import { useLiveStatus } from '../lib/events';
import { setSidebarCollapsed, setThemePreference, usePreferences, type ThemePreference } from '../lib/preferences';
import { Link } from '../lib/router';
import { cn } from '../lib/utils';
import { Logo } from './brand';
import { Button, Dot, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Tooltip } from './ui';

export interface NavItem { id: string; href: string; label: MessageKey; icon: LucideIcon }
export const navigation: { label: MessageKey; items: NavItem[] }[] = [
  { label: 'nav.groupOverview', items: [{ id: 'dashboard', href: '/', label: 'nav.dashboard', icon: LayoutDashboard }] },
  { label: 'nav.groupInfrastructure', items: [
    { id: 'servers', href: '/servers', label: 'nav.servers', icon: Server },
    { id: 'terminals', href: '/terminals', label: 'nav.terminals', icon: TerminalSquare },
  ] },
  { label: 'nav.groupActivity', items: [
    { id: 'jobs', href: '/jobs', label: 'nav.jobs', icon: Activity },
    { id: 'request-logs', href: '/request-logs', label: 'nav.requestLogs', icon: ScrollText },
    { id: 'approvals', href: '/approvals', label: 'nav.approvals', icon: ShieldAlert },
  ] },
];
const settingsItem: NavItem = { id: 'settings', href: '/settings', label: 'nav.settings', icon: SettingsIcon };
const themeIcons: Record<ThemePreference, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

function NavLink({ item, active, collapsed, badge }: { item: NavItem; active: boolean; collapsed: boolean; badge?: ReactNode }) {
  const link = <Link href={item.href} aria-current={active ? 'page' : undefined} aria-label={collapsed ? t(item.label) : undefined}
    className={cn('flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground', active && 'bg-sidebar-accent font-medium text-foreground', collapsed && 'justify-center px-0')}>
    <span className="relative"><item.icon className="size-4" />{collapsed && badge && <span className="absolute -top-1 -right-1 size-2 rounded-full bg-danger" />}</span>
    {!collapsed && <span className="flex-1 truncate">{t(item.label)}</span>}{!collapsed && badge}
  </Link>;
  return collapsed ? <Tooltip content={t(item.label)} side="right">{link}</Tooltip> : link;
}

function ThemeItems() {
  const { theme } = usePreferences();
  return <MenuRadioGroup value={theme} onValueChange={value => setThemePreference(value as ThemePreference)}>
    {(['system', 'light', 'dark'] as const).map(value => <MenuRadioItem key={value} value={value}>{t(`theme.${value}`)}</MenuRadioItem>)}
  </MenuRadioGroup>;
}

function LanguageItems() {
  const locale = useLocale();
  return <MenuRadioGroup value={locale} onValueChange={value => setLocale(value as Locale)}>
    {locales.map(value => <MenuRadioItem key={value} value={value} lang={value}>{localeNames[value]}</MenuRadioItem>)}
  </MenuRadioGroup>;
}

function Sidebar({ page, collapsed, username, onLogout }: { page: string; collapsed: boolean; username?: string; onLogout: () => void }) {
  const health = useServerHealth();
  const attention = new Set([...health.offline, ...health.faults].map(server => server.id)).size;
  const pending = usePendingApprovals().data?.pending ?? 0;
  const badges: Record<string, ReactNode> = {
    approvals: pending ? <span className="rounded-full tone-warning border px-1.5 text-[11px] font-medium tabular-nums" aria-label={t('nav.pendingApprovals', { n: pending })}>{pending}</span> : undefined,
    servers: attention ? <span className="rounded-full tone-danger border px-1.5 text-[11px] font-medium tabular-nums" aria-label={t('nav.attention', { n: attention })}>{attention}</span> : undefined,
  };
  return <div className="flex h-full flex-col">
    <Link href="/" className={cn('mb-6 flex items-center gap-2.5 px-1.5 py-1', collapsed && 'justify-center px-0')} aria-label="Hostherd"><Logo />{!collapsed && <span className="text-lg font-semibold tracking-tight">Hostherd</span>}</Link>
    <nav className="space-y-5" aria-label={t('nav.main')}>
      {navigation.map(group => <div key={group.label}>
        {!collapsed && <div className="mb-1.5 px-2.5 text-[11px] font-medium text-muted-foreground">{t(group.label)}</div>}
        <div className="space-y-0.5">{group.items.map(item => <NavLink key={item.id} item={item} active={page === item.id} collapsed={collapsed} badge={badges[item.id]} />)}</div>
      </div>)}
    </nav>
    <div className="mt-auto space-y-1 pt-6">
      <NavLink item={settingsItem} active={page === 'settings'} collapsed={collapsed} />
      <Menu>
        <MenuTrigger asChild><button className={cn('flex w-full items-center gap-3 rounded-lg p-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring', collapsed && 'justify-center')} aria-label={t('nav.account')}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-xs font-semibold">{(username || 'A').slice(0, 2).toUpperCase()}</span>
          {!collapsed && <><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{username || t('nav.administrator')}</span><span className="block text-xs text-muted-foreground">{t('nav.administrator')}</span></span><ChevronsUpDown className="size-4 text-muted-foreground" /></>}
        </button></MenuTrigger>
        <MenuContent side={collapsed ? 'right' : 'top'} align="start" className="w-56">
          <MenuLabel>{t('theme.label')}</MenuLabel><ThemeItems /><MenuSeparator />
          <MenuLabel>{t('settings.language')}</MenuLabel><LanguageItems /><MenuSeparator />
          <MenuItem onSelect={onLogout}><LogOut />{t('nav.logout')}</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  </div>;
}

function LiveIndicator() {
  const status = useLiveStatus();
  const tone = status === 'live' ? 'success' : status === 'connecting' ? 'warning' : 'danger';
  return <Tooltip content={t(`live.${status}Hint`)}><span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex" role="status"><Dot tone={tone} pulse={status === 'live'} />{t(`live.${status}`)}</span></Tooltip>;
}

export function AppShell({ page, title, username, onLogout, children }: { page: string; title: string; username?: string; onLogout: () => void; children: ReactNode }) {
  const { collapsed, theme } = usePreferences();
  const [mobileMenu, setMobileMenu] = useState(false);
  const ThemeIcon = themeIcons[theme];
  return <div className="min-h-dvh bg-sidebar">
    <aside className={cn('fixed inset-y-0 left-0 z-20 hidden p-3 lg:block', collapsed ? 'w-16' : 'w-60')}><Sidebar page={page} collapsed={collapsed} username={username} onLogout={onLogout} /></aside>
    <main className={cn('min-w-0 p-0 sm:p-2', collapsed ? 'lg:pl-16' : 'lg:pl-60')}>
      <div className="min-h-[calc(100dvh-1rem)] overflow-hidden bg-background sm:rounded-xl sm:border sm:shadow-xs">
        <header className="flex h-14 items-center gap-3 border-b px-4 sm:px-6">
          <Button variant="ghost" size="icon-sm" className="-ml-1.5 lg:hidden" aria-label={t('nav.openMenu')} onClick={() => setMobileMenu(true)}><PanelLeft /></Button>
          <Button variant="ghost" size="icon-sm" className="-ml-1.5 hidden lg:inline-flex" aria-label={collapsed ? t('nav.expand') : t('nav.collapse')} onClick={() => setSidebarCollapsed(!collapsed)}><PanelLeft /></Button>
          <span className="h-4 w-px bg-border" /><span className="truncate text-sm font-medium">{title}</span>
          <div className="ml-auto flex items-center gap-3"><LiveIndicator />
            <Menu><MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('theme.label')}><ThemeIcon /></Button></MenuTrigger><MenuContent className="w-40"><ThemeItems /></MenuContent></Menu>
          </div>
        </header>
        <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-7">{children}</div>
      </div>
    </main>
    <DialogPrimitive.Root open={mobileMenu} onOpenChange={setMobileMenu}>
      <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r bg-sidebar p-3 shadow-xl outline-none" onClick={event => { if ((event.target as HTMLElement).closest('a')) setMobileMenu(false); }}>
          <DialogPrimitive.Title className="sr-only">{t('nav.main')}</DialogPrimitive.Title><DialogPrimitive.Description className="sr-only">{t('nav.main')}</DialogPrimitive.Description>
          <Sidebar page={page} collapsed={false} username={username} onLogout={onLogout} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  </div>;
}
