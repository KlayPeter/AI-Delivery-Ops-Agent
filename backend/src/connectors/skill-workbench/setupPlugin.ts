import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { requirePersonalScope } from '@/knowledge/scope';
import { readSmallJsonBody } from '@/platform/workspace/request';
import type { WebTransport } from '@/knowledge/web/network';
import { inspectSkill } from './source';
import { exportSkillProfile, INSPECT_CAPABILITY, INSPECTION_ROLE, readInspection } from './service';

const input = z.object({ url: z.string().url().max(1024) }).strict(), toolId = 'skills.github.inspect';
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.skill-inspector', name: 'GitHub Skill 接入', version: '1.0.0',
    description: '读取公开 GitHub SKILL.md，固定提交与内容指纹，查看指令和可用许可；审查后导出仅执行文本的本地配置，不安装或运行仓库代码。',
    runtime: { type: 'native' }, capabilities: [INSPECT_CAPABILITY], triggers: ['manual'], inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', maxLength: 1024 } }, additionalProperties: false }, outputSchema: { type: 'object' },
    requirements: { tools: [toolId], secrets: [], networkHosts: ['api.github.com', 'raw.githubusercontent.com'] }, limits: { timeoutSeconds: 40, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 1024 * 1024 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};
export function createSkillSetupPlugin(transport?: WebTransport): FeaturePlugin { return {
    manifest: { apiVersion: '1.0', id: 'skills.setup', name: manifest.name, version: '1.1.0', description: manifest.description }, agents: [{ manifest, installationId: 'install-skill-inspector' }],
    apply(ctx) {
        const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
        ctx.delivery.web.register({ id: 'skills.setup', pages: [{ path: '/skills', label: '接入 Skill', section: 'workspace', view: { kind: 'builtin', id: 'skill-setup', capability: INSPECT_CAPABILITY } }],
            api: { prefix: '/api/skill-setup', routes: [{ method: 'GET', path: '/api/skill-setup/inspection' }, { method: 'POST', path: '/api/skill-setup/profile' }], async handle(request) {
                const url = new URL(request.url);
                try {
                    if (request.method === 'GET' && url.pathname === '/api/skill-setup/inspection' && url.search.length <= 100 && [...url.searchParams.keys()].length === 1 && url.searchParams.has('runId')) return Response.json(await readInspection(ctx.delivery.getContext().store, scope, url.searchParams.get('runId')!));
                    if (request.method === 'POST' && url.pathname === '/api/skill-setup/profile' && !url.search) return Response.json(await exportSkillProfile(ctx.delivery.getContext().store, scope, await readSmallJsonBody(request)));
                    return Response.json({ error: '接口不存在' }, { status: 404 });
                } catch { return Response.json({ error: '无法读取或导出：请核对当前范围内的成功发现记录、内容指纹及两项审查确认' }, { status: 400 }); }
            } },
        });
        ctx.delivery.tools.register({ id: toolId, version: '1.0.0', description: manifest.description, inputSchema: manifest.inputSchema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: false, timeoutSeconds: 35 }, async (value, execution) => {
            requirePersonalScope(execution.scope); if (execution.scope.triggerType !== 'manual') throw new Error('GitHub Skill 接入需要人工发起');
            return inspectSkill(input.parse(value).url, execution.signal, transport);
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope); const value = input.parse(request.input), budget = new RunToolCallBudget(1);
            const bundle = await ctx.delivery.toolGateway.execute(toolId, value, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: [toolId], budget });
            return { status: 'succeeded', data: bundle, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: bundle, metadata: { privateKnowledge: true, artifactRole: INSPECTION_ROLE, title: 'GitHub Skill 来源与审查', statusPanels: [{ schemaVersion: '1.0', tone: 'warning', title: 'Skill 已读取，尚未启用', description: '审查完整指令、固定来源与许可后再导出。仅导入文本，不执行脚本或加载附属资源；不是完整仓库兼容证明。' }] } }] };
        });
    },
}; }
export const skillSetupPlugin = createSkillSetupPlugin();
export default skillSetupPlugin;
