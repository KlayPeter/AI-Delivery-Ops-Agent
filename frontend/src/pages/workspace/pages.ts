export interface PluginPage {
  path: string; label: string; section: 'workspace' | 'team';
  view: { kind: 'builtin'; id: string } | { kind: 'agent'; capability: string };
}

export const findPluginPage = (pages: PluginPage[] = [], pathname: string) => pages.find(page => page.path === pathname.replace(/\/$/, ''));
export const pluginAgentHref = (capability: string) => `/?capability=${encodeURIComponent(capability)}`;
export const activePluginPage = (pages: PluginPage[] = [], pathname: string, search: string) => findPluginPage(pages, pathname)
  || (pathname === '/' ? pages.find(page => page.view.kind === 'agent' && page.view.capability === new URLSearchParams(search).get('capability')) : undefined);
