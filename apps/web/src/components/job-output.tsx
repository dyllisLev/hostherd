import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronUp, Download, Pause, Radio, Search, WrapText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import { api, decodeBytes, errorMessage, formatBytes } from '../lib/api';
import { outputText } from '../lib/output-text';
import type { Output } from '../lib/types';
import { cn } from '../lib/utils';
import { Button, ErrorNotice, Input, Tooltip } from './ui';

const CHUNK_SIZE = 65536;
const MAX_MATCHES = 1000;
interface Chunk { start: number; end: number; text: string }
function readWrap() { try { return localStorage.getItem('hostherd.output.wrap') !== '0'; } catch { return true; } }

/** Live tail and paged browsing of a job's stored output, with in-view search. */
export function JobOutput({ id, outputBytes }: { id: string; outputBytes: number }) {
  const [live, setLive] = useState(true);
  const [anchor, setAnchor] = useState(Math.max(0, outputBytes - CHUNK_SIZE));
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [cursor, setCursor] = useState(anchor);
  const [eof, setEof] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [wrap, setWrap] = useState(readWrap);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const viewport = useRef<HTMLPreElement>(null);
  const text = outputText(chunks.map(chunk => chunk.text).join(''));
  const start = chunks[0]?.start ?? anchor;
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const decoder = new TextDecoder();
    let offset = anchor;
    setChunks([]); setCursor(anchor); setLoading(true); setError(undefined);
    const read = async () => {
      try {
        const output = await api<Output>('/api/jobs/' + encodeURIComponent(id) + '/output?cursor=' + offset + '&limit=' + CHUNK_SIZE, { signal: controller.signal });
        if (disposed) return;
        const bytes = decodeBytes(output.data);
        const decoded = decoder.decode(bytes, { stream: live });
        if (bytes.length) {
          const chunk = { start: offset, end: output.nextCursor, text: decoded };
          setChunks(previous => live ? [...previous, chunk].slice(-8) : [chunk]);
          offset = output.nextCursor;
        }
        setCursor(offset); setEof(output.eof); setError(undefined); setLoading(false);
        if (live) timer = setTimeout(read, output.eof || !bytes.length ? 1200 : 0);
      } catch (cause) {
        if (!disposed) {
          setError(errorMessage(cause)); setLoading(false);
          if (live) timer = setTimeout(read, 3000);
        }
      }
    };
    void read();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [id, anchor, live]);
  const matches = useMemo(() => {
    if (!query) return [];
    const found: number[] = [];
    const haystack = text.toLowerCase(), needle = query.toLowerCase();
    for (let index = haystack.indexOf(needle); index !== -1 && found.length < MAX_MATCHES; index = haystack.indexOf(needle, index + needle.length)) found.push(index);
    return found;
  }, [text, query]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const box = viewport.current;
    const mark = box?.querySelector<HTMLElement>(`[data-match="${active}"]`);
    // Scroll only the output box, not the page.
    if (query && box && mark) box.scrollTop = mark.offsetTop - box.clientHeight / 2;
    else if (!query && live && box) box.scrollTop = box.scrollHeight;
  }, [text, live, query, active]);
  const browse = (offset: number) => { setLive(false); setAnchor(offset); };
  const toggleWrap = () => { setWrap(!wrap); try { localStorage.setItem('hostherd.output.wrap', wrap ? '0' : '1'); } catch { /* private mode */ } };
  const step = (delta: number) => { if (matches.length) setActive((active + delta + matches.length) % matches.length); };
  const content = !text ? (loading ? t('output.loading') : t('output.empty')) : !matches.length ? text : matches.flatMap((index, number) => [
    text.slice(number ? matches[number - 1] + query.length : 0, index),
    <mark key={index} data-match={number} className={cn('rounded-sm px-px text-zinc-950', number === active ? 'bg-amber-300' : 'bg-amber-100/80')}>{text.slice(index, index + query.length)}</mark>,
  ]).concat(text.slice(matches[matches.length - 1] + query.length));
  const total = Math.max(outputBytes, cursor);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-56">
        <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
        <Input aria-label={t('output.search')} placeholder={t('output.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} className="h-8 pr-28 pl-8" />
        {query && <div className="absolute top-1 right-1 flex items-center gap-0.5"><span className="px-1.5 text-xs tabular-nums text-muted-foreground">{matches.length ? `${active + 1}/${matches.length}${matches.length === MAX_MATCHES ? '+' : ''}` : '0'}</span><Button variant="ghost" size="icon" className="size-6" disabled={!matches.length} onClick={() => step(-1)} aria-label={t('output.previousMatch')}><ChevronUp /></Button><Button variant="ghost" size="icon" className="size-6" disabled={!matches.length} onClick={() => step(1)} aria-label={t('output.nextMatch')}><ChevronDown /></Button></div>}
      </div>
      <div className="flex items-center gap-1">
        <Tooltip content={t('output.first')}><Button variant="outline" size="icon-sm" disabled={!start} aria-label={t('output.first')} onClick={() => browse(0)}><ChevronsLeft /></Button></Tooltip>
        <Tooltip content={t('output.previous')}><Button variant="outline" size="icon-sm" disabled={!start} aria-label={t('output.previous')} onClick={() => browse(Math.max(0, start - CHUNK_SIZE))}><ChevronLeft /></Button></Tooltip>
        <Tooltip content={t('output.next')}><Button variant="outline" size="icon-sm" disabled={eof} aria-label={t('output.next')} onClick={() => browse(cursor)}><ChevronRight /></Button></Tooltip>
      </div>
      <Tooltip content={wrap ? t('output.wrapOff') : t('output.wrapOn')}><Button variant={wrap ? 'secondary' : 'outline'} size="icon-sm" aria-pressed={wrap} aria-label={t('output.wrap')} onClick={toggleWrap}><WrapText /></Button></Tooltip>
      <Tooltip content={t('output.download')}><Button variant="outline" size="icon-sm" asChild><a href={'/api/jobs/' + encodeURIComponent(id) + '/output/download'} download aria-label={t('output.download')}><Download /></a></Button></Tooltip>
      <Button size="sm" variant={live ? 'secondary' : 'outline'} onClick={() => { if (live) { setAnchor(start); setLive(false); } else { setAnchor(Math.max(0, outputBytes - CHUNK_SIZE)); setLive(true); } }}>{live ? <Pause /> : <Radio />}{live ? t('output.pause') : t('output.follow')}</Button>
    </div>
    <ErrorNotice message={error} />
    <pre ref={viewport} tabIndex={0} style={{ position: 'relative' }} aria-label={t('output.label')} className={cn('log-output h-[min(60dvh,560px)] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-200 dark:border-border', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{content}</pre>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{start === 0 && cursor >= total ? t('output.showingAll', { total: formatBytes(total) }) : t('output.showingRange', { from: formatBytes(start), to: formatBytes(cursor), total: formatBytes(total) })}</span>
      <span>{query ? t('output.searchScope') : live ? t('output.liveHint') : t('output.browsingHint')}</span>
    </div>
  </div>;
}
