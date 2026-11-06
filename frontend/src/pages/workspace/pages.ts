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
  return active.includes('delivery.ops.orchestrate') ? 'delivery.ops.orchestrate' : active.includes('knowledge.mixed.retrieve') ? 'knowledge.mixed.retrieve' : active[0] || '';
}

export const findPluginPage = (pages: PluginPage[] = [], pathname: string, search = '') => {
  const path = dashboardFilenameFromPath(pathname) || (pathname === '/' && isLegacyDashboardSearch(search)) ? '/dashboard' : pathname.replace(/\/$/, '');
  return pages.find(page => page.path === path);
};
export const pluginAgentHref = (capability: string) => `/?capability=${encodeURIComponent(capability)}`;
export const agentPageHref = (pages: PluginPage[] = [], capability: string) => pages.find(page => page.view.kind === 'builtin' && page.view.capability === capability)?.path || pluginAgentHref(capability);
export const activePluginPage = (pages: PluginPage[] = [], pathname: string, search: string) => findPluginPage(pages, pathname, search)
  || (pathname === '/' ? pages.find(page => page.view.kind === 'agent' && page.view.capability === new URLSearchParams(search).get('capability')) : undefined);

export function navigationSection(page: PluginPage | undefined, pathname: string): string | undefined {
  if (page?.section === 'team' || pathname === '/debug') return 'team';
  if (['/agents', '/plugins'].includes(pathname) || (page?.section === 'workspace' && !homeTasks([page]).length)) return 'extensions';
  if (['/logs', '/contexts', '/config'].includes(pathname)) return 'manage';
}

export function homeTasks(pages: PluginPage[] = []) {
  const tasks = [
    { id: 'knowledge', title: '问自己的资料', description: '检索笔记和网页原文，按需生成带引用的回答。' },
    { id: 'personal-research', title: '整理一份研究稿', description: '围绕问题收集资料、拆分子任务，保留来源与过程。' },
    { id: 'knowledge-reviews', title: '复核旧结果的依据', description: '检查已引用资料的版本变化，保留原回答与证据。' },
    { id: 'release-preparation', title: '准备版本发布材料', description: '结合仓库变化与个人规则，整理证据和待确认项。' },
  ] as const;
  return tasks.flatMap(task => {
    const page = pages.find(page => page.section === 'workspace' && page.navigation !== false && page.view.kind === 'builtin' && page.view.id === task.id);
    return page ? [{ ...task, path: page.path }] : [];
  });
}
