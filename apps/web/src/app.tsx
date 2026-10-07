import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { AppShell, navigation } from './components/app-shell';
import { Button, Empty, ErrorNotice, Loading, toast, TooltipProvider } from './components/ui';
import { t, type MessageKey } from './i18n';
import { errorMessage, post, useApi } from './lib/api';
import { AppDataProvider } from './lib/app-data';
import { startEvents, stopEvents } from './lib/events';
import { usePreferences } from './lib/preferences';
import { Link, useLocation } from './lib/router';
import type { Me } from './lib/types';
import { AuthPage } from './pages/auth';

const Servers = lazy(() => import('./pages/servers').then(module => ({ default: module.Servers })));
const ServerDetail = lazy(() => import('./pages/server-detail').then(module => ({ default: module.ServerDetail })));
const Jobs = lazy(() => import('./pages/jobs').then(module => ({ default: module.Jobs })));
const JobDetail = lazy(() => import('./pages/jobs').then(module => ({ default: module.JobDetail })));
const Settings = lazy(() => import('./pages/settings').then(module => ({ default: module.Settings })));
const Dashboard = lazy(() => import('./pages/dashboard').then(module => ({ default: module.Dashboard })));
const Terminals = lazy(() => import('./pages/terminals').then(module => ({ default: module.Terminals })));
const RequestLogs = lazy(() => import('./pages/request-logs').then(module => ({ default: module.RequestLogs })));
const Approvals = lazy(() => import('./pages/approvals').then(module => ({ default: module.Approvals })));

const titles: Record<string, MessageKey> = { ...Object.fromEntries(navigation.flatMap(group => group.items).map(item => [item.id, item.label])), settings: 'nav.settings' };

const RELOAD_KEY = 'hostherd:chunk-reload';
const isChunkError = (error: unknown) => error instanceof Error && (error.name === 'ChunkLoadError' || /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(error.message));

/** Keeps a page error from blanking the whole app. A page chunk missing after a deploy reloads once. */
class PageBoundary extends Component<{ resetKey: string; children: ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown) {
    if (!isChunkError(error)) return;
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    window.location.reload();
  }
  componentDidUpdate(previous: { resetKey: string }) { if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: undefined }); }
  render() {
    if (!this.state.error) return this.props.children;
    return <Empty title={t('common.pageError')} description={isChunkError(this.state.error) ? t('common.pageUpdated') : t('common.pageErrorDescription')} action={<Button variant="outline" onClick={() => window.location.reload()}>{t('common.reload')}</Button>} />;
  }
}

function NotFound() {
  return <Empty title={t('common.notFound')} description={t('common.notFoundDescription')} action={<Button variant="outline" asChild><Link href="/">{t('nav.dashboard')}</Link></Button>} />;
}

export function App() {
  const me = useApi<Me>('/api/me', 60000);
  const { resolvedTheme } = usePreferences();
  const { segments, search } = useLocation();
  const authenticated = !!me.data?.authenticated;
  useEffect(() => {
    const unauthorized = () => me.refresh();
    window.addEventListener('hostherd:unauthorized', unauthorized);
    return () => window.removeEventListener('hostherd:unauthorized', unauthorized);
  }, [me.refresh]);
  useEffect(() => { if (!authenticated) return; startEvents(); return stopEvents; }, [authenticated]);
  const [section = 'dashboard', id] = segments;
  const page = section in titles ? section : 'not-found';
  const title = page === 'not-found' ? t('common.notFound') : t(titles[page]);
  useEffect(() => { document.title = title + ' · Hostherd'; }, [title]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [section, id]);
  const logout = async () => {
    try { await post('/api/logout'); me.refresh(); }
    catch (cause) { toast.error(errorMessage(cause)); }
  };
  const toaster = <Toaster theme={resolvedTheme} position="bottom-right" richColors closeButton />;
  if (!me.data) return <div className="flex min-h-dvh items-center justify-center p-5"><div className="w-full max-w-md">{me.loading ? <Loading label={t('common.connecting')} /> : <ErrorNotice message={me.error} retry={me.refresh} />}</div></div>;
  if (!authenticated) return <>{toaster}<AuthPage setup={me.data.setupRequired} onAuthenticated={me.refresh} /></>;
  let content;
  if (page === 'servers') content = id ? <ServerDetail key={id} id={id} /> : <Servers />;
  else if (page === 'jobs') content = id ? <JobDetail key={id} id={id} /> : <Jobs />;
  else if (page === 'request-logs') content = <RequestLogs id={id} />;
  else if (page === 'approvals') content = <Approvals id={id} />;
  else if (page === 'terminals') content = <Terminals key={search.get('server') || 'terminals'} id={id} serverFilter={search.get('server') || undefined} />;
  else if (page === 'settings') content = <Settings username={me.data.username} />;
  else if (page === 'dashboard' && !id) content = <Dashboard />;
  else content = <NotFound />;
  return <TooltipProvider><AppDataProvider>
    <AppShell page={page} title={title} username={me.data.username} onLogout={() => void logout()}><PageBoundary resetKey={segments.join('/')}><Suspense fallback={<Loading />}>{content}</Suspense></PageBoundary></AppShell>
    {toaster}
  </AppDataProvider></TooltipProvider>;
}
