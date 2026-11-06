import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import { requirePersonalScope } from '@/knowledge/scope';
import type { WebTransport } from '@/knowledge/web/network';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { validateSchema } from '@/platform/agents/schema';
import { argumentsSchema, connectorConfig, operationUrl } from './contracts';
import { fetchApiData } from './catalog';

export const OPENAPI_RUN_CAPABILITY = 'openapi.tools.run';
const route = 'openapi-runner.invoke';
const input = z.object({ toolId: z.string().max(150), arguments: z.record(z.string(), z.unknown()) }).strict();
const schema = { type: 'object', properties: { toolId: { type: 'string' }, arguments: { type: 'object' } }, required: ['toolId', 'arguments'], additionalProperties: false };
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.openapi-runner', name: 'OpenAPI 接口读取', version: '1.0.0', description: '调用已审查配置中的匿名公开 HTTPS GET 接口；验证输入并保存来源契约及有界 JSON 响应，不调用模型。',
    runtime: { type: 'native' }, capabilities: [OPENAPI_RUN_CAPABILITY], triggers: ['manual', 'agent'], inputSchema: schema, outputSchema: { type: 'object' },
    requirements: { tools: [route], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 40, maxSteps: 3, maxToolCalls: 2, maxAgentCalls: 0, maxOutputBytes: 3 * 1024 * 1024 }, delivery: { allowedArtifactTypes: ['json', 'text'], directDelivery: false },
};
export function createOpenApiConnectorPlugin(network?: WebTransport): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'connector.openapi', name: 'OpenAPI 读取连接', version: '1.1.0', description: manifest.description }, Config: connectorConfig,
        agents: [{ manifest, installationId: 'install-openapi-runner' }],
        apply(ctx, value) {
            const config = connectorConfig.parse(value);
            const tools = config.operations.map(operation => ({ operation, id: `openapi.${config.serviceId}.${operation.alias}`, inputSchema: argumentsSchema(operation) }));
            for (const tool of tools) {
                // Compile the pinned contract before exposing any operations.
                if (validateSchema({}, tool.inputSchema).some(error => error.includes('invalid or unsupported'))) throw new Error('OpenAPI 参数 Schema 不受支持');
                ctx.delivery.tools.register({ id: tool.id, version: '1.1.0', description: `${tool.operation.key}: ${tool.operation.summary}`, inputSchema: tool.inputSchema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 20,
                    binding: { kind: 'openapi-get', url: tool.operation.serverUrl, sha256: createHash('sha256').update(JSON.stringify({ source: config.source, operation: tool.operation })).digest('hex') } }, async (args, execution) => {
                    requirePersonalScope(execution.scope); execution.signal?.throwIfAborted();
                    const url = operationUrl(tool.operation, args as { path?: Record<string, unknown>; query?: Record<string, unknown> });
                    const response = await fetchApiData(url.href, execution.signal || new AbortController().signal, network);
                    if (!/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.contentType)) throw new Error('OpenAPI 接口没有返回支持的 JSON 类型');
                    let data: unknown;
                    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); } catch { throw new Error('OpenAPI 接口没有返回有效的 UTF-8 JSON'); }
                    return { operation: tool.operation.key, requestedUrl: url.href, source: config.source, receivedAt: new Date().toISOString(), responseBytes: response.body.length, responseSha256: createHash('sha256').update(response.body).digest('hex'), response: data };
                });
            }
            ctx.delivery.web.register({ id: 'connector.openapi', pages: [{ path: '/openapi-runner', label: 'API 工具', section: 'workspace', view: { kind: 'builtin', id: 'openapi-runner', capability: OPENAPI_RUN_CAPABILITY } }],
                api: { prefix: '/api/openapi-runner', routes: [{ method: 'GET', path: '/api/openapi-runner/tools' }], handle(request) {
                    if (request.method !== 'GET' || new URL(request.url).pathname !== '/api/openapi-runner/tools') return Response.json({ error: '接口不存在' }, { status: 404 });
                    return Response.json({ source: config.source, tools: tools.map(tool => ({ id: tool.id, key: tool.operation.key, summary: tool.operation.summary, serverUrl: tool.operation.serverUrl, inputSchema: tool.inputSchema })) });
                } },
            });
            ctx.delivery.tools.register({ id: route, version: '1.1.0', description: 'Route one explicitly granted OpenAPI read operation using its pinned input contract; callers cannot supply URLs or credentials.', inputSchema: { ...schema, properties: { ...schema.properties, toolId: { type: 'string', enum: tools.map(tool => tool.id) } } }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 30 }, async (value, execution) => {
                requirePersonalScope(execution.scope); const parsed = input.parse(value);
                if (!tools.some(tool => tool.id === parsed.toolId)) throw new Error('OpenAPI 接口未获本地配置授权');
                if (!execution.budget) throw new Error('OpenAPI 运行器需要共享调用预算');
                return ctx.delivery.toolGateway.execute(parsed.toolId, parsed.arguments, { ...execution, allowedTools: tools.map(tool => tool.id), budget: execution.budget });
            });
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope); const parsed = input.parse(request.input), budget = new RunToolCallBudget(2);
                const data = await ctx.delivery.toolGateway.execute(route, parsed, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: manifest.requirements.tools, budget }) as { operation: string; receivedAt: string; requestedUrl: string; responseBytes: number; responseSha256: string; response: unknown };
                const text = JSON.stringify(data.response, null, 2), preview = Buffer.from(text).subarray(0, 64 * 1024).toString('utf8');
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [
                    { type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { privateKnowledge: true, title: 'OpenAPI 读取结果', statusPanels: [{ schemaVersion: '1.0', tone: 'success', title: 'API 读取已完成', description: '响应由第三方服务提供，参数和完整 JSON 保留在详情。这里只验证读取及 JSON 格式，不证明服务数据正确。', checkedAt: data.receivedAt, items: [{ label: '已授权接口', value: data.operation }, { label: '规范内容 SHA-256', value: config.source.sha256 }, { label: '响应字节', value: String(data.responseBytes) }] }] } },
                    { type: 'text', mediaType: 'text/markdown', schemaVersion: '1.0', content: `## 响应预览\n\n${Buffer.byteLength(text) > 64 * 1024 ? '预览已截断；完整 JSON 见详情。\n\n' : ''}\`\`\`json\n${preview}\n\`\`\``, metadata: { privateKnowledge: true, title: 'API 响应预览' } },
                ] };
            });
        },
    };
}
export const openApiConnectorPlugin = createOpenApiConnectorPlugin();
export default openApiConnectorPlugin;
