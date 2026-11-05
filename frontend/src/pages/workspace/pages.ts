import { dashboardFilenameFromPath } from '../../dashboardFiles';
import { isLegacyDashboardSearch } from './input';

export interface PluginPage {
  path: string; label: string; section: 'workspace' | 'team'; navigation?: boolean;
  view: { kind: 'builtin'; id: string; capability?: string } | { kind: 'agent'; capability: string };
}

export const hasTeamNavigation = (pages: PluginPage[] = [], manualJobs: string[] = []) => manualJobs.length > 0
  || pages.some(page => page.section === 'team' && page.navigation !== false);

export function defaultCapability(agents: { status: string; capabilities: string[] }[] = [], requested?: string | null): string {
  if (requested) return requested;
  const active = agents.filter(agent => agent.status === 'active').flatMap(agent => agent.capabilities);
  return active.includes('delivery.ops.orchestrate') ? 'delivery.ops.orchestrate' : active[0] || '';
}

export const findPluginPage = (pages: PluginPage[] = [], pathname: string, search = '') => {
  const path = dashboardFilenameFromPath(pathname) || (pathname === '/' && isLegacyDashboardSearch(search)) ? '/dashboard' : pathname.replace(/\/$/, '');
  return pages.find(page => page.path === path);
};
export const pluginAgentHref = (capability: string) => `/?capability=${encodeURIComponent(capability)}`;
export const agentPageHref = (pages: PluginPage[] = [], capability: string) => pages.find(page => page.view.kind === 'builtin' && page.view.capability === capability)?.path || pluginAgentHref(capability);
export const activePluginPage = (pages: PluginPage[] = [], pathname: string, search: string) => findPluginPage(pages, pathname, search)
  || (pathname === '/' ? pages.find(page => page.view.kind === 'agent' && page.view.capability === new URLSearchParams(search).get('capability')) : undefined);
