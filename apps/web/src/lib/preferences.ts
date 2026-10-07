import { useSyncExternalStore } from 'react';

// Browser-local display preferences.
export type ThemePreference = 'system' | 'light' | 'dark';
export type TimeZonePreference = 'local' | 'utc';

const listeners = new Set<() => void>();
function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem('hostherd.' + key) as T | null; return value && allowed.includes(value) ? value : fallback; }
  catch { return fallback; }
}
function write(key: string, value: string) {
  try { localStorage.setItem('hostherd.' + key, value); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

const themes = ['system', 'light', 'dark'] as const;
const zones = ['local', 'utc'] as const;
export const themePreference = () => read('theme', themes, 'system');
export const timeZonePreference = () => read('timezone', zones, 'local');
export const sidebarCollapsed = () => read('sidebar', ['collapsed', 'expanded'] as const, 'expanded') === 'collapsed';

const darkQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
export const resolvedTheme = (): 'light' | 'dark' => {
  const theme = themePreference();
  return theme === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : theme;
};
export function applyTheme() {
  const dark = resolvedTheme() === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#09090b' : '#fafafa');
}
darkQuery?.addEventListener('change', () => { applyTheme(); for (const listener of listeners) listener(); });

export function setThemePreference(value: ThemePreference) { write('theme', value); applyTheme(); }
export function setTimeZonePreference(value: TimeZonePreference) { write('timezone', value); }
export function setSidebarCollapsed(value: boolean) { write('sidebar', value ? 'collapsed' : 'expanded'); }

export function usePreferences() {
  const theme = useSyncExternalStore(subscribe, themePreference);
  const resolved = useSyncExternalStore(subscribe, resolvedTheme);
  const timeZone = useSyncExternalStore(subscribe, timeZonePreference);
  const collapsed = useSyncExternalStore(subscribe, sidebarCollapsed);
  return { theme, resolvedTheme: resolved, timeZone, collapsed };
}
