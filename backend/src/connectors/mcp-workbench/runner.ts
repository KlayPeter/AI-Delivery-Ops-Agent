import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import { requirePersonalScope } from '@/knowledge/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';

export const MCP_RUN_CAPABILITY = 'mcp.tools.run';
const tool = 'mcp-runner.invoke';
export const runnerConfig = z.object({ allowedTools: z.array(z.string().regex(/^mcp\.[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/)).min(1).max(50) }).strict().refine(value => new Set(value.allowedTools).size === value.allowedTools.length, '工具授权不能重复');
const input = z.object({ toolId: z.string().max(140), arguments: z.record(z.string(), z.unknown()) }).strict();
const schema = { type: 'object', required: ['toolId', 'arguments'], properties: { toolId: { type: 'string', maxLength: 140 }, arguments: { type: 'object' } }, additionalProperties: false };
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.mcp-runner', name: 'MCP 工具运行', version: '1.0.0', description: '运行本地配置明确授予的 MCP 读取工具；参数按当前服务契约校验，保留工具步骤。',
    runtime: { type: 'native' }, capabilities: [MCP_RUN_CAPABILITY], triggers: ['manual', 'agent'], inputSchema: schema, outputSchema: { type: 'object' },
    requirements: { tools: [tool], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 40, maxSteps: 3, maxToolCalls: 2, maxAgentCalls: 0, maxOutputBytes: 3 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['json', 'text'], directDelivery: false },
};
export const mcpRunnerPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'mcp.runner', name: manifest.name, version: '1.0.0', description: manifest.description, requires: ['connector.mcp'] }, Config: runnerConfig,
    agents: [{ manifest, installationId: 'install-mcp-runner' }],
    apply(ctx, value) {
        const config = runnerConfig.parse(value);
        const granted = () => {
            const tools = ctx.delivery.tools.list();
            const selected = config.allowedTools.map(id => {
                const found = tools.find(tool => tool.id === id);
                if (!found || found.sideEffect !== 'read') throw new Error(`MCP 读取授权不可用：${id}`);
                return found;
            });
            if (Buffer.byteLength(JSON.stringify(selected)) > 1024 * 1024) throw new Error('MCP 授权元数据超过 1 MiB');
            return selected;
        };
        granted();
        ctx.delivery.web.register({ id: 'mcp.runner', pages: [{ path: '/mcp-runner', label: '运行工具', section: 'workspace', view: { kind: 'builtin', id: 'mcp-runner', capability: MCP_RUN_CAPABILITY } }],
            api: { prefix: '/api/mcp-runner', routes: [{ method: 'GET', path: '/api/mcp-runner/tools' }], handle(request) {
                if (request.method !== 'GET' || new URL(request.url).pathname !== '/api/mcp-runner/tools') return Response.json({ error: '接口不存在' }, { status: 404 });
                try { return Response.json({ tools: granted().map(({ id, description, inputSchema }) => ({ id, description, inputSchema })) }); }
                catch { return Response.json({ error: '当前工具授权不可用，请检查插件配置' }, { status: 409 }); }
            } },
        });
        ctx.delivery.tools.register({ id: tool, version: '1.0.0', description: 'Invoke one MCP read tool explicitly granted by trusted plugin configuration; no model-controlled grant expansion.', inputSchema: schema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 35 }, async (value, execution) => {
            requirePersonalScope(execution.scope);
            const parsed = input.parse(value);
            if (!granted().some(tool => tool.id === parsed.toolId)) throw new Error('工具未获本地配置授权');
            if (!execution.budget) throw new Error('MCP 运行器必须使用共享 Tool 预算');
            return ctx.delivery.toolGateway.execute(parsed.toolId, parsed.arguments, { ...execution, allowedTools: config.allowedTools, budget: execution.budget });
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope);
            const parsed = input.parse(request.input), budget = new RunToolCallBudget(2);
            const result = await ctx.delivery.toolGateway.execute(tool, parsed, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: manifest.requirements.tools, budget }) as { content?: { type: string; text?: string }[] };
            const data = { toolId: parsed.toolId, result };
            const text = result.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n');
            return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [
                { type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { title: 'MCP 工具结果', privateKnowledge: true, statusPanels: [{ schemaVersion: '1.0', tone: 'success', title: '工具读取已完成', description: '下方展示服务返回的文本；原始结构化结果保留在详情。', items: [{ label: '已授权工具', value: parsed.toolId }, { label: '执行', value: '2 次工具调用 · 0 次模型调用' }] }] } },
                ...(text ? [{ type: 'text' as const, mediaType: 'text/plain', schemaVersion: '1.0', content: text, metadata: { title: parsed.toolId, privateKnowledge: true } }] : []),
            ] };
        });
    },
};
export default mcpRunnerPlugin;
