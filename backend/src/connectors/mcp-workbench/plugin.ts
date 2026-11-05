import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import { requirePersonalScope } from '@/knowledge/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import type { McpHttpNetwork } from '../mcp/http';
import { inspectInput, inspectMcp, profileRequest } from './catalog';

export const MCP_SETUP_CAPABILITY = 'mcp.server.inspect';
const tool = 'mcp-setup.inspect';
const schema = { type: 'object', required: ['url', 'serverId'], properties: { url: { type: 'string', maxLength: 1024 }, serverId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } }, additionalProperties: false };
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.mcp-inspector', name: 'MCP 接入助手', version: '1.0.0', description: '发现公开 HTTPS MCP 工具，检查参数契约并导出明确授权的本地配置；无需模型。',
    runtime: { type: 'native' }, capabilities: [MCP_SETUP_CAPABILITY], triggers: ['manual', 'agent'], inputSchema: schema, outputSchema: { type: 'object' },
    requirements: { tools: [tool], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 30, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};
export function createMcpSetupPlugin(network?: McpHttpNetwork): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'mcp.setup', name: manifest.name, version: '1.1.0', description: manifest.description }, agents: [{ manifest, installationId: 'install-mcp-inspector' }],
        apply(ctx) {
            ctx.delivery.web.register({ id: 'mcp.setup', pages: [{ path: '/mcp-setup', label: '接入工具', section: 'workspace', view: { kind: 'builtin', id: 'mcp-setup', capability: MCP_SETUP_CAPABILITY } }],
                api: { prefix: '/api/mcp-setup', routes: [{ method: 'POST', path: '/api/mcp-setup/profile' }], async handle(request) {
                    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/mcp-setup/profile') return Response.json({ error: '接口不存在' }, { status: 404 });
                    try { return Response.json(await profileRequest(request)); }
                    catch { return Response.json({ error: '请确认地址、工具选择和只读授权；配置请求最多 16 KiB' }, { status: 400 }); }
                } },
            });
            ctx.delivery.tools.register({ id: tool, version: '1.0.0', description: 'Inspect anonymous public HTTPS MCP tool metadata; never call advertised tools or read local credentials.', inputSchema: schema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 25 }, async (input, execution) => {
                requirePersonalScope(execution.scope);
                return inspectMcp(input, execution.signal, network);
            });
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope);
                const data = await ctx.delivery.toolGateway.execute(tool, inspectInput.parse(request.input), { runId: request.runId, agentId: manifest.id, scope: request.scope, signal,
                    allowedTools: manifest.requirements.tools, budget: new RunToolCallBudget(1) });
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: 1 }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { title: 'MCP 工具目录', privateKnowledge: true } }] };
            });
        },
    };
}
export const mcpSetupPlugin = createMcpSetupPlugin();
export default mcpSetupPlugin;
