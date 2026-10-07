import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ko, type Dictionary } from './ko';

// Strings live in per-locale dictionaries; Korean is the reference shape and
// `en` is typed against it, so both must have identical keys.
type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>
}[keyof T & string];
export type MessageKey = Leaves<Dictionary>;
export type Values = Record<string, string | number>;

export const locales = ['en', 'ko'] as const;
export type Locale = typeof locales[number];
/** Language names are always shown in their own language. */
export const localeNames: Record<Locale, string> = { en: 'English', ko: '한국어' };

const dictionaries: Record<Locale, Dictionary> = { en, ko };
const STORAGE_KEY = 'hostherd.language';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (locales as readonly string[]).includes(saved)) return saved as Locale;
  } catch { /* storage unavailable */ }
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return preferred[0]?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Current UI locale; an ES live binding, so importers always see the latest value. */
export let locale: Locale = initialLocale();
let messages: Dictionary = dictionaries[locale];
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = locale;

/** Switches the UI language in place, remembers it in this browser and tells the server (admin default for MCP and notifications). */
export function setLocale(next: Locale) {
  if (next === locale) return;
  locale = next;
  messages = dictionaries[next];
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
  document.documentElement.lang = next;
  for (const listener of listeners) listener();
  // Older servers do not have this endpoint; the browser choice still applies.
  void fetch('/api/settings/language', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: next }),
  }).catch(() => undefined);
}

/** Re-renders the caller when the locale changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => locale,
  );
}

// `{name}` inserts a value; `{name:one|other}` picks a word by whether the value is 1.
const interpolate = (text: string, values?: Values) =>
  values ? text.replace(/\{(\w+)(?::([^|}]*)\|([^}]*))?\}/g, (match, name: string, one?: string, other?: string) =>
    !(name in values) ? match : one === undefined ? String(values[name]) : Number(values[name]) === 1 ? one : other!) : text;

/** Looks up a message and fills `{name}` and `{name:one|other}` placeholders. */
export function t(key: MessageKey, values?: Values): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)?.[part];
  return interpolate(typeof node === 'string' ? node : key, values);
}

/** Localized text for a server error code, if the dictionary has one. */
export function errorText(code: unknown, params?: Record<string, unknown>): string | undefined {
  const errors: Record<string, string> = messages.errors;
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(errors, code)) return undefined;
  const values: Values = {};
  for (const [name, value] of Object.entries(params ?? {})) if (value !== null && value !== undefined) values[name] = typeof value === 'number' ? value : String(value);
  return interpolate(errors[code], values);
}

export function formatNumber(value: number) { return value.toLocaleString(locale); }
