import { useCallback, useSyncExternalStore, type ComponentProps, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
  // Links saved before path routing used `#page/id`.
  if (window.location.pathname === '/' && window.location.hash.length > 1) window.history.replaceState(null, '', '/' + window.location.hash.slice(1));
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const snapshot = () => window.location.pathname + window.location.search;

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === snapshot()) return;
  window.history[options.replace ? 'replaceState' : 'pushState'](null, '', to);
  notify();
}

export function useLocation() {
  const value = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(value, window.location.origin);
  return { pathname: url.pathname, search: url.searchParams, segments: url.pathname.split('/').filter(Boolean).map(decodeURIComponent) };
}

/** Query-string state; empty values are removed and history is replaced. */
export function useQueryState() {
  const { search } = useLocation();
  const update = useCallback((values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === '') params.delete(key); else params.set(key, String(value));
    }
    const query = params.toString();
    navigate(window.location.pathname + (query ? '?' + query : ''), { replace: true });
  }, []);
  return [search, update] as const;
}

export function Link({ href, onClick, ...props }: ComponentProps<'a'> & { href: string }) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={click} {...props} />;
}
