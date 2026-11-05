export const isLegacyDashboardSearch = (search: string) => {
  const params = new URLSearchParams(search);
  return params.has('dashboardId') || params.has('groupId');
};

export function sourceHref(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) || (url.protocol === 'obsidian:' && url.hostname === 'open')) return url.href;
  } catch { return undefined; }
  return undefined;
}

export function prepareInput(capability: string, prompt: string): Record<string, unknown> {
  if (capability === 'release.prepare') throw new Error('请在发布准备页面选择时间段和个人规则，或填写高级任务参数');
  const text = prompt.trim();
  if (!text) throw new Error('请先填写任务内容');
  if (capability === 'knowledge.answer') return { question: text, limit: 5 };
  if (['knowledge.markdown.retrieve', 'knowledge.web.retrieve', 'knowledge.mixed.retrieve'].includes(capability)) return { operation: 'search', query: text, limit: 5 };
  if (capability === 'knowledge.impact.check') return { runIds: text.split(/[\s,，]+/), operation: 'check' };
  return { prompt: text, source: 'private' };
}
