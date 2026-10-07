import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ClipboardPaste, Keyboard, Maximize2, Minimize2, Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { decodeBytes } from '../lib/api';
import { isActive, type Job } from '../lib/types';
import { cn } from '../lib/utils';
import { applyXtermImeFix } from '../lib/xterm-ime';
import { errorText, t } from '../i18n';
import { ErrorNotice } from './ui';

type ConnectionState = 'connecting' | 'reconnecting' | 'connected' | 'ended' | 'checking' | 'closed' | 'dropped';

const touchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
const fontSizes = { min: 10, max: 22 };
function readPreference(key: string) { try { return localStorage.getItem('hostherd.terminal.' + key); } catch { return null; } }
function savePreference(key: string, value: string) { try { localStorage.setItem('hostherd.terminal.' + key, value); } catch { /* private mode */ } }

// Chromium only: lets Esc, Ctrl+W and similar reach the shell while fullscreen.
type KeyboardLock = { lock?: () => Promise<void>; unlock?: () => void };
const keyboardLock = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

interface Modifiers { ctrl: boolean; alt: boolean }
function withModifiers(data: string, modifiers: Modifiers) {
  let result = data;
  if (modifiers.ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) result = String.fromCharCode(code - 64);
    else if (data === ' ') result = '\u0000';
    else if (data === '?') result = '\u007f';
  }
  return modifiers.alt ? '\u001b' + result : result;
}

export function TerminalScreen({ id, active, title }: { id: string; active: boolean; title?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const ime = useRef<ReturnType<typeof applyXtermImeFix> | null>(null);
  const activeSession = useRef(active);
  const modifierRef = useRef<Modifiers>({ ctrl: false, alt: false });
  const [modifiers, setModifiersState] = useState<Modifiers>({ ctrl: false, alt: false });
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string>();
  const [maximized, setMaximized] = useState(false);
  const [locked, setLocked] = useState(false);
  const [viewport, setViewport] = useState<{ height: number; top: number }>();
  const [showKeys, setShowKeys] = useState(() => (readPreference('keys') ?? (touchDevice ? '1' : '0')) === '1');
  const [fontSize, setFontSize] = useState(() => {
    const saved = Number(readPreference('fontSize'));
    return saved >= fontSizes.min && saved <= fontSizes.max ? saved : touchDevice ? 13 : 14;
  });
  const initialFontSize = useRef(fontSize);
  const setModifiers = (next: Modifiers) => { modifierRef.current = next; setModifiersState(next); };
  useEffect(() => {
    activeSession.current = active;
    if (terminal.current) terminal.current.options.disableStdin = !active;
  }, [active]);
  const sendRaw = (data: string) => {
    if (activeSession.current && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'input', data }));
      return true;
    }
    setError(t('terminal.inputAfterReconnect'));
    return false;
  };
  // Key bar input: keep the on-screen keyboard open and the pending IME text ordered first.
  const sendKey = (data: string, modified = false) => {
    ime.current?.flush();
    const current = modifierRef.current;
    if (current.ctrl || current.alt) setModifiers({ ctrl: false, alt: false });
    sendRaw(modified ? withModifiers(data, current) : data);
    const term = terminal.current;
    if (term && document.activeElement !== term.textarea) term.focus();
  };
  const cursorKey = (normal: string, application: string) => terminal.current?.modes.applicationCursorKeysMode ? application : normal;
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) terminal.current?.paste(text);
      terminal.current?.focus();
    } catch { setError(t('terminal.pasteFailed')); }
  };
  useEffect(() => {
    if (!element.current) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let frameRequest = 0;
    let receivedCursor = 0;
    let renderedCursor = 0;
    let attempt = 0;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "D2Coding", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK KR", monospace',
      fontSize: initialFontSize.current,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: '#09090b', foreground: '#e4e4e7', cursor: '#fafafa', cursorAccent: '#09090b', selectionBackground: '#52525b',
        black: '#27272a', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8',
        brightBlack: '#71717a', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa',
      },
      allowProposedApi: false,
      disableStdin: !activeSession.current,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current);
    const imeFix = applyXtermImeFix(term);
    ime.current = imeFix;
    terminal.current = term;
    const fitTerminal = () => {
      if (!disposed && element.current && element.current.clientWidth > 0 && element.current.clientHeight > 0) fit.fit();
    };
    fitRef.current = fitTerminal;
    frameRequest = requestAnimationFrame(fitTerminal);
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitTerminal, 50);
    });
    observer.observe(element.current);
    // Terminal-style clipboard keys; plain Ctrl+C/V stay with the shell.
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey && event.shiftKey && key === 'c') || (event.ctrlKey && !event.shiftKey && key === 'insert')) {
        event.preventDefault();
        if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection()).catch(() => setError(t('terminal.copyFailed')));
        return false;
      }
      // Let the browser fire a paste event, which xterm turns into bracketed paste.
      if ((event.ctrlKey && event.shiftKey && key === 'v') || (event.shiftKey && !event.ctrlKey && key === 'insert')) return false;
      return true;
    });
    const input = term.onData(data => {
      const current = modifierRef.current;
      if (current.ctrl || current.alt) {
        modifierRef.current = { ctrl: false, alt: false };
        setModifiersState(modifierRef.current);
        data = withModifiers(data, current);
      }
      if (activeSession.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'input', data }));
      else setError(t('terminal.inputAfterReconnect'));
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (activeSession.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    const connect = () => {
      if (disposed) return;
      // Finish queued xterm writes before resuming from the rendered byte cursor.
      if (renderedCursor !== receivedCursor) { retry = setTimeout(connect, 100); return; }
      const url = new URL('/terminal/' + encodeURIComponent(id), window.location.href);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('cursor', String(renderedCursor));
      setConnection(attempt ? 'reconnecting' : 'connecting');
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        attempt = 0; setConnection(activeSession.current ? 'connected' : 'ended'); setError(undefined);
        fitTerminal();
        if (activeSession.current) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        term.focus();
      };
      ws.onmessage = event => {
        if (disposed || socket.current !== ws) return;
        try {
          const message = JSON.parse(String(event.data)) as { type: string; data?: string; offset?: number; message?: string; code?: string; params?: Record<string, unknown>; job?: Job };
          if (message.type === 'output' && typeof message.data === 'string' && typeof message.offset === 'number') {
            let bytes = decodeBytes(message.data);
            const offset = message.offset;
            if (offset > receivedCursor) {
              setError(t('terminal.recoveringOutput'));
              ws.close();
              return;
            }
            if (offset < receivedCursor) bytes = bytes.slice(receivedCursor - offset);
            if (!bytes.length) return;
            const end = receivedCursor + bytes.length;
            receivedCursor = end;
            term.write(bytes, () => { renderedCursor = end; });
          } else if (message.type === 'error') {
            setError(errorText(message.code, message.params) || message.message || t('terminal.requestFailed'));
          } else if (message.type === 'state' && message.job) {
            activeSession.current = isActive(message.job);
            term.options.disableStdin = !isActive(message.job);
            if (!isActive(message.job)) setConnection('ended');
          }
        } catch { setError(t('terminal.readFailed')); ws.close(); }
      };
      ws.onerror = () => { if (!disposed) setConnection('checking'); };
      ws.onclose = event => {
        if (disposed || socket.current !== ws) return;
        socket.current = null;
        if ([1008, 4003, 4401, 4403].includes(event.code)) {
          setConnection('closed');
          setError(t('terminal.unauthorized'));
          if (event.code === 4003 || event.code === 4401) window.dispatchEvent(new Event('hostherd:unauthorized'));
          return;
        }
        attempt += 1;
        setConnection('dropped');
        retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000));
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry); clearTimeout(resizeTimer); cancelAnimationFrame(frameRequest);
      observer.disconnect(); input.dispose(); resize.dispose();
      imeFix.dispose(); ime.current = null; fitRef.current = null;
      socket.current?.close(); socket.current = null;
      term.dispose(); terminal.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.fontSize = fontSize;
    fitRef.current?.();
    savePreference('fontSize', String(fontSize));
  }, [fontSize]);
  useEffect(() => { savePreference('keys', showKeys ? '1' : '0'); }, [showKeys]);
  useEffect(() => {
    if (!maximized) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Follow the visual viewport so the on-screen keyboard does not cover the prompt.
    const visual = window.visualViewport;
    const update = () => { if (visual) setViewport({ height: visual.height, top: visual.offsetTop }); };
    update();
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    const fullscreenChange = () => {
      if (!document.fullscreenElement) { keyboardLock()?.unlock?.(); setLocked(false); setMaximized(false); }
    };
    document.addEventListener('fullscreenchange', fullscreenChange);
    terminal.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
      document.removeEventListener('fullscreenchange', fullscreenChange);
      setViewport(undefined);
    };
  }, [maximized]);
  const toggleMaximized = async () => {
    if (maximized) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      keyboardLock()?.unlock?.(); setLocked(false); setMaximized(false);
      return;
    }
    setMaximized(true);
    if (!touchDevice && frame.current?.requestFullscreen) {
      try {
        await frame.current.requestFullscreen({ navigationUI: 'hide' });
        await keyboardLock()?.lock?.();
        setLocked(Boolean(keyboardLock()?.lock));
      } catch { /* in-page maximize still applies */ }
    }
  };
  const key = (label: ReactNode, onPress: () => void, options: { name?: string; pressed?: boolean; wide?: boolean } = {}) =>
    <button type="button" aria-label={options.name} aria-pressed={options.pressed} disabled={!active}
      onMouseDown={event => event.preventDefault()} onClick={onPress}
      className={cn('flex h-9 shrink-0 items-center justify-center rounded-md px-2.5 font-mono text-xs text-zinc-200 transition-colors active:bg-zinc-600 disabled:opacity-40 [&_svg]:size-4', options.wide ? 'min-w-14' : 'min-w-10', options.pressed ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-800 hover:bg-zinc-700')}>{label}</button>;
  const tool = (label: string, icon: ReactNode, onPress: () => void, pressed?: boolean, disabled?: boolean) =>
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled}
      onMouseDown={event => event.preventDefault()} onClick={onPress}
      className={cn('flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 [&_svg]:size-3.5', pressed && 'bg-zinc-800 text-zinc-100')}>{icon}</button>;
  return <div className="space-y-3">
    {!maximized && <ErrorNotice message={error} />}
    <div ref={frame} style={maximized && viewport ? { height: viewport.height, top: viewport.top } : undefined}
      className={cn('flex flex-col overflow-hidden bg-zinc-950', maximized ? 'fixed inset-x-0 top-0 z-50 h-dvh' : 'h-[max(380px,calc(100dvh-19rem))] rounded-lg border border-zinc-800')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 pr-1.5 pl-3 text-xs text-zinc-400">
        <span className="flex shrink-0 items-center gap-2"><span className={'size-1.5 rounded-full ' + (connection === 'connected' ? 'bg-emerald-400' : 'bg-zinc-500')} />{t(`terminal.state.${connection}`)}</span>
        {maximized && title && <span className="min-w-0 truncate font-mono text-zinc-500">{title}</span>}
        {maximized && locked && <span className="hidden shrink-0 text-zinc-500 md:inline">· {t('terminal.exitFullscreenHint')}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {tool(t('terminal.fontSmaller'), <Minus />, () => setFontSize(size => Math.max(fontSizes.min, size - 1)), undefined, fontSize <= fontSizes.min)}
          <span className="w-6 text-center tabular-nums text-zinc-500">{fontSize}</span>
          {tool(t('terminal.fontLarger'), <Plus />, () => setFontSize(size => Math.min(fontSizes.max, size + 1)), undefined, fontSize >= fontSizes.max)}
          <span className="mx-1 h-4 w-px bg-zinc-800" />
          {tool(t('terminal.keyBar'), <Keyboard />, () => setShowKeys(value => !value), showKeys)}
          {tool(maximized ? t('terminal.exitFullscreen') : t('terminal.fullscreen'), maximized ? <Minimize2 /> : <Maximize2 />, () => void toggleMaximized())}
        </span>
      </div>
      {maximized && error && <p role="alert" className="shrink-0 bg-red-950 px-3 py-1.5 text-xs text-red-200">{error}</p>}
      <div className="min-h-0 flex-1 p-2"><div ref={element} className="h-full min-w-0" aria-label={t('terminal.label')} /></div>
      {showKeys && <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-zinc-800 p-1.5 [scrollbar-width:none]" aria-label={t('terminal.keyBar')}>
        {key('Esc', () => sendKey('\u001b'))}
        {key('Tab', () => sendKey('\t'))}
        {key('Ctrl', () => setModifiers({ ...modifierRef.current, ctrl: !modifierRef.current.ctrl }), { pressed: modifiers.ctrl })}
        {key('Alt', () => setModifiers({ ...modifierRef.current, alt: !modifierRef.current.alt }), { pressed: modifiers.alt })}
        {key('^C', () => sendKey('\u0003'), { name: 'Ctrl+C' })}
        {key('←', () => sendKey(cursorKey('\u001b[D', '\u001bOD')), { name: t('terminal.keyLeft') })}
        {key('↑', () => sendKey(cursorKey('\u001b[A', '\u001bOA')), { name: t('terminal.keyUp') })}
        {key('↓', () => sendKey(cursorKey('\u001b[B', '\u001bOB')), { name: t('terminal.keyDown') })}
        {key('→', () => sendKey(cursorKey('\u001b[C', '\u001bOC')), { name: t('terminal.keyRight') })}
        {['|', '~', '/', '-'].map(char => <span key={char} className="contents">{key(char, () => sendKey(char, true))}</span>)}
        {key('Home', () => sendKey(cursorKey('\u001b[H', '\u001bOH')), { wide: true })}
        {key('End', () => sendKey(cursorKey('\u001b[F', '\u001bOF')), { wide: true })}
        {key('PgUp', () => sendKey('\u001b[5~'), { wide: true })}
        {key('PgDn', () => sendKey('\u001b[6~'), { wide: true })}
        {key(<ClipboardPaste />, () => void paste(), { name: t('terminal.paste') })}
        {key('Enter', () => sendKey('\r'), { wide: true })}
      </div>}
    </div>
    {!maximized && <p className="text-xs leading-relaxed text-muted-foreground">{t('terminal.footnote')}</p>}
  </div>;
}
