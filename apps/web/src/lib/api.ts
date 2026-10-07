import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, locale, t } from '../i18n';
import { subscribeTopic, type Topic } from './events';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') {
      window.dispatchEvent(new Event('hostherd:unauthorized'));
    }
    // Prefer the localized text for the server's error code, then its (English) message.
    const message = errorText(data?.code, data?.params) || data?.error || t('common.requestFailedStatus', { status: response.status });
    throw new ApiError(message, response.status, data?.code, data?.params);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly params?: Record<string, unknown>) { super(message); }
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t('common.requestFailed');
}

/**
 * Loads JSON and keeps it current. `refreshOn` refetches when the server
 * announces a change to those topics, and then also every minute in case the
 * event stream is down; `interval` polls (ms) for data without events.
 */
export function useApi<T>(path: string | null, options: number | { interval?: number; refreshOn?: Topic[] } = {}) {
  const { refreshOn = [], interval = refreshOn.length ? 60_000 : 0 } = typeof options === 'number' ? { interval: options } : options;
  const topics = refreshOn.join(',');
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(path));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const lastPath = useRef(path);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    if (lastPath.current !== path) {
      setData(undefined);
      lastPath.current = path;
    }
    const load = async () => {
      try {
        const result = await api<T>(path, { signal: controller.signal });
        if (!disposed) { setData(result); setError(undefined); }
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause));
      } finally {
        if (!disposed) {
          setLoading(false);
          if (interval) timer = setTimeout(load, interval);
        }
      }
    };
    setLoading(true);
    void load();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [path, interval, revision]);
  useEffect(() => {
    if (!path || !topics) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
    const unsubscribe = topics.split(',').map(topic => subscribeTopic(topic as Topic, schedule));
    return () => { clearTimeout(timer); for (const stop of unsubscribe) stop(); };
  }, [path, topics, refresh]);
  return { data, error, loading, refresh };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(undefined);
    try { return await action(); }
    catch (cause) { setError(errorMessage(cause)); return undefined; }
    finally { setBusy(false); }
  };
  return { busy, error, run, clearError: () => setError(undefined) };
}

export function decodeBytes(base64: string) {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

export { formatDateTime as formatDate } from './time';

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** index).toLocaleString(locale, { maximumFractionDigits: index ? 1 : 0 }) + ' ' + units[index];
}
