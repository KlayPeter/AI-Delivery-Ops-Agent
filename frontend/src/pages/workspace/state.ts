import useSWR from 'swr';
import { api } from '@/api';

export interface AgentInfo {
  agentId: string; name: string; description: string; runtime: string; version: string;
  capabilities: string[]; status: string; pluginId?: string;
}
export interface RunInfo {
  id: string; capability: string; status: string; createdAt: string; completedAt?: string;
  error?: { message: string }; parentRunId?: string;
}
export interface WorkspaceState {
  agents: AgentInfo[]; runs: RunInfo[];
  plugins: { id: string; name: string; description: string; version: string; requires?: string[]; agents: string[] }[];
  health: { started: boolean; initialized: boolean }; modelConfigured: boolean; knowledgeKind: string; managedByPluginFile: boolean;
}
export interface ConnectionState { values: Record<string, string>; secrets: Record<string, boolean>; restartRequired: boolean }

export const useWorkspace = () => useSWR<WorkspaceState>('workspace', api.fetchWorkspace, { refreshInterval: 5000 });
export const useConnections = () => useSWR<ConnectionState>('connections', api.fetchConnections, { refreshInterval: data => data?.restartRequired ? 3000 : 0 });

const names: Record<string, string> = {
  'delivery.ops.orchestrate': '交付协调', 'task.manage': '任务管理', 'standup.manage': '站会助手',
  'summary.daily.generate': '日报生成', 'summary.weekly.generate': '周报生成', 'dashboard.project.generate': '项目看板',
  'knowledge.ai.news.fetch': 'AI 资讯', 'knowledge.markdown.retrieve': '笔记检索', 'knowledge.web.retrieve': '网页检索',
  'knowledge.answer': '知识问答', 'knowledge.impact.check': '引用复核', 'release.prepare': '发布准备',
};
export const capabilityName = (capability: string) => names[capability] || capability;
const descriptions: Record<string, string> = {
  'delivery.ops.orchestrate': '理解你的目标，选择合适的专业能力，协调任务并汇总结果。',
  'task.manage': '创建、查询和跟踪任务，处理进度、负责人及状态更新。',
  'standup.manage': '处理站会提交、补交和缺交查询，关联成员的任务进展。',
  'summary.daily.generate': '从群聊与项目记录中整理当天重点，生成可追溯的日报。',
  'summary.weekly.generate': '结合站会、任务变化与项目事实，整理本周进展和风险。',
  'dashboard.project.generate': '读取项目任务，生成进度快照、历史看板与图片。',
  'knowledge.ai.news.fetch': '查询多来源 AI 资讯，支持关键词筛选与继续阅读。',
  'knowledge.markdown.retrieve': '只读检索选定的 Markdown 与 Obsidian 笔记，返回原文片段和内容版本。',
  'knowledge.web.retrieve': '读取选定的公开网页，检索正文并保留来源链接与内容版本。',
  'knowledge.answer': '结合知识库片段回答问题，检查引用身份与精确引文，资料不足时明确说明。',
};
export const agentDescription = (agent: AgentInfo) => descriptions[agent.capabilities[0]] || agent.description;
export const pluginName = (id: string, fallback: string) => ({
  'builtin.ai-news': 'AI 资讯', 'builtin.daily-summary': '日报', 'builtin.dashboard': '项目看板', 'builtin.weekly-report': '周报',
  'builtin.task': '任务管理', 'builtin.standup': '站会', 'builtin.orchestrator': '交付协调', 'builtin.meeting-summary': '会议纪要',
  'builtin.ai-hot-schedule': '外部资讯调度', 'knowledge.markdown': 'Markdown / Obsidian', 'knowledge.web': '公开网页', 'knowledge.answer': '知识问答',
} as Record<string, string>)[id] || fallback;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
export const needsModel = (agent?: AgentInfo) => agent?.runtime === 'model-loop' || agent?.capabilities.includes('knowledge.answer');
