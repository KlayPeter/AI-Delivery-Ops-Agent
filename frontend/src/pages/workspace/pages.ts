import { dashboardFilenameFromPath } from '../../dashboardFiles';
import { isLegacyDashboardSearch } from './input';

export interface PluginPage {
  path: string; label: string; section: 'workspace' | 'team';
  view: { kind: 'builtin'; id: string } | { kind: 'agent'; capability: string };
}

export const findPluginPage = (pages: PluginPage[] = [], pathname: string, search = '') => {
  const path = dashboardFilenameFromPath(pathname) || (pathname === '/' && isLegacyDashboardSearch(search)) ? '/dashboard' : pathname.replace(/\/$/, '');
  return pages.find(page => page.path === path);
};
export const pluginAgentHref = (capability: string) => `/?capability=${encodeURIComponent(capability)}`;
export const activePluginPage = (pages: PluginPage[] = [], pathname: string, search: string) => findPluginPage(pages, pathname, search)
  || (pathname === '/' ? pages.find(page => page.view.kind === 'agent' && page.view.capability === new URLSearchParams(search).get('capability')) : undefined);
