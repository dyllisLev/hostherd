import { createContext, useContext, type ReactNode } from 'react';
import { useApi } from './api';
import { isOlderVersion, type ApprovalList, type Server, type SettingsData } from './types';

// Server list and central settings are shared by the shell and most pages.
interface AppData {
  servers: ReturnType<typeof useApi<Server[]>>;
  settings: ReturnType<typeof useApi<SettingsData>>;
  approvals: ReturnType<typeof useApi<ApprovalList>>;
}
const Context = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const servers = useApi<Server[]>('/api/servers', { refreshOn: ['servers', 'metrics'], interval: 60_000 });
  const settings = useApi<SettingsData>('/api/settings');
  const approvals = useApi<ApprovalList>('/api/approvals?status=pending&limit=50', { refreshOn: ['approvals'] });
  return <Context.Provider value={{ servers, settings, approvals }}>{children}</Context.Provider>;
}

function useAppData() {
  const value = useContext(Context);
  if (!value) throw new Error('AppDataProvider is missing');
  return value;
}
export const useServers = () => useAppData().servers;
export const useSettings = () => useAppData().settings;
/** Pending command approvals, shared by the sidebar badge and the approvals page. */
export const usePendingApprovals = () => useAppData().approvals;

/** Servers needing attention: faults, offline agents and outdated agents. */
export function useServerHealth() {
  const servers = useServers().data ?? [];
  const latest = useSettings().data?.agentVersion;
  const outdated = (server: Server) => isOlderVersion(server.version, latest);
  return {
    servers, latest, outdated,
    online: servers.filter(server => server.online),
    offline: servers.filter(server => !server.online),
    faults: servers.filter(server => server.fault),
    updates: servers.filter(outdated),
  };
}
