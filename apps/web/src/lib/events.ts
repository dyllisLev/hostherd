import { useSyncExternalStore } from 'react';

// One server-sent event stream tells open views which data changed.
export type Topic = 'servers' | 'jobs' | 'metrics' | 'approvals';
export type LiveStatus = 'connecting' | 'live' | 'offline';

const topics = new Map<Topic, Set<() => void>>();
const statusListeners = new Set<() => void>();
let source: EventSource | undefined;
let status: LiveStatus = 'connecting';
let retry: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;

function setStatus(next: LiveStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}
function publish(topic: Topic) { for (const listener of topics.get(topic) ?? []) listener(); }

let missed = false;
function open() {
  setStatus('connecting');
  const current = new EventSource('/api/events');
  source = current;
  current.onopen = () => {
    attempts = 0;
    setStatus('live');
    // Changes made while disconnected were not announced.
    if (missed) { publish('servers'); publish('jobs'); publish('metrics'); publish('approvals'); }
    missed = false;
  };
  current.onerror = () => {
    missed = true;
    if (current.readyState !== EventSource.CLOSED) { setStatus('connecting'); return; }
    // The browser stops retrying after an HTTP error, e.g. a proxy 502 while
    // the central restarts. Reopen with backoff until stopEvents.
    setStatus('offline');
    attempts++;
    retry = setTimeout(() => { if (source === current) open(); }, Math.min(30_000, 2000 * attempts));
  };
  current.addEventListener('servers', () => publish('servers'));
  current.addEventListener('jobs', () => publish('jobs'));
  current.addEventListener('metrics', () => publish('metrics'));
  current.addEventListener('approvals', () => publish('approvals'));
  // The session ended or was not accepted: recheck login, and keep retrying while the app stays signed in.
  current.addEventListener('unauthorized', () => {
    current.close(); missed = true; setStatus('offline'); attempts++;
    window.dispatchEvent(new Event('hostherd:unauthorized'));
    retry = setTimeout(() => { if (source === current) open(); }, Math.min(30_000, 2000 * attempts));
  });
}

export function startEvents() {
  if (source) return;
  attempts = 0; missed = false;
  open();
}

export function stopEvents() {
  clearTimeout(retry);
  source?.close();
  source = undefined;
  setStatus('offline');
}

export function subscribeTopic(topic: Topic, listener: () => void) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  topics.get(topic)!.add(listener);
  return () => { topics.get(topic)!.delete(listener); };
}

export function useLiveStatus() {
  return useSyncExternalStore(listener => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; }, () => status);
}
export const liveStatus = () => status;
