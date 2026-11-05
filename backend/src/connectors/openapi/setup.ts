import { z } from 'zod';
import { stringify } from 'yaml';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { requirePersonalScope } from '@/knowledge/scope';
import type { WebTransport } from '@/knowledge/web/network';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { readSmallJsonBody } from '@/platform/workspace/request';
import { connectorConfig, inspectInput, operationSchema, sourceSchema } from './contracts';
import { inspectOpenApi } from './catalog';

export const OPENAPI_SETUP_CAPABILITY = 'openapi.spec.inspect';
const tool = 'openapi-setup.inspect';
const inputSchema = { type: 'object', required: ['url', 'serviceId'], properties: { url: { type: 'string', maxLength: 1024 }, serviceId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } }, additionalProperties: false };
const profileInput = z.object({ inspectionRunId: z.string().uuid(), reviewedReadOnly: z.literal(true), selections: z.array(z.object({ key: z.string().min(1).max(520), serverUrl: inspectInput.shape.url }).strict()).min(1).max(20), includePersonalWorkspace: z.boolean().optional() }).strict();
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.openapi-inspector', name: 'OpenAPI 接入助手', version: '1.0.0', description: '读取公开 OpenAPI JSON/YAML 目录，列出匿名 GET 的支持边界，审查后导出固定契约配置；不调用目录内接口。',
    runtime: { type: 'native' }, capabilities: [OPENAPI_SETUP_CAPABILITY], triggers: ['manual', 'agent'], inputSchema, outputSchema: { type: 'object' },
    requirements: { tools: [tool], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 30, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};
export async function exportOpenApiProfile(store: PersistentKeyValueStore, input: unknown) {
    const selected = profileInput.parse(input);
    if (new Set(selected.selections.map(operation => operation.key)).size !== selected.selections.length) throw new Error('不能重复授权同一接口');
    const runs = new PersistentAgentRunStore(store), run = await runs.get(selected.inspectionRunId);
    if (!run || run.workspaceId !== DEFAULT_WORKSPACE_ID || run.botInstanceId !== DEFAULT_BOT_INSTANCE_ID || run.parentRunId || run.status !== 'succeeded' || run.capability !== OPENAPI_SETUP_CAPABILITY) throw new Error('找不到当前工作区的成功发现记录');
    const artifacts = (await runs.listArtifacts(run.id)).filter(artifact => artifact.type === 'json' && artifact.metadata.artifactRole === 'openapi.catalog');
    if (artifacts.length !== 1) throw new Error('发现记录缺少规范目录');
    const catalog = z.object({ serviceId: inspectInput.shape.serviceId, source: sourceSchema, operations: z.array(z.record(z.string(), z.unknown())).max(200) }).parse(artifacts[0]!.content);
    const operations = selected.selections.map(selection => {
        const found = catalog.operations.find(operation => operation.key === selection.key);
        if (!found || found.issue || !Array.isArray(found.servers) || !found.servers.includes(selection.serverUrl)) throw new Error('接口或服务器不在该次可用目录中');
        const operation = operationSchema.parse(Object.fromEntries(['key', 'alias', 'method', 'path', 'summary', 'parameters'].map(key => [key, found[key]])));
        return { ...operation, serverUrl: selection.serverUrl };
    });
    const config = connectorConfig.parse({ serviceId: catalog.serviceId, source: catalog.source, reviewedReadOnly: true, operations });
    return { filename: `openapi-${config.serviceId}${selected.includePersonalWorkspace ? '.personal' : ''}.local.yaml`, yaml: '# Save under backend/examples/. Review the fixed GET contracts before restarting.\n' + stringify({ apiVersion: '1.0', ...(selected.includePersonalWorkspace ? { base: 'personal' } : {}), plugins: [
        { module: '../src/connectors/openapi/plugin.ts', config }, { module: '../src/connectors/openapi/setup.ts' },
    ] }) };
}
export function createOpenApiSetupPlugin(network?: WebTransport): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'openapi.setup', name: manifest.name, version: '1.1.0', description: manifest.description }, agents: [{ manifest, installationId: 'install-openapi-inspector' }],
        apply(ctx) {
            ctx.delivery.web.register({ id: 'openapi.setup', pages: [{ path: '/openapi-setup', label: '接入 API', section: 'workspace', view: { kind: 'builtin', id: 'openapi-setup', capability: OPENAPI_SETUP_CAPABILITY } }],
                api: { prefix: '/api/openapi-setup', routes: [{ method: 'POST', path: '/api/openapi-setup/profile' }], async handle(request) {
                    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/openapi-setup/profile') return Response.json({ error: '接口不存在' }, { status: 404 });
                    try { return Response.json(await exportOpenApiProfile(ctx.delivery.getContext().store, await readSmallJsonBody(request))); }
                    catch { return Response.json({ error: '请核对发现记录、接口和服务器选择及只读审查；配置请求最多 16 KiB' }, { status: 400 }); }
                } },
            });
            ctx.delivery.tools.register({ id: tool, version: '1.0.0', description: 'Inspect an anonymous public HTTPS OpenAPI document without invoking advertised operations or following remote references.', inputSchema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 25 }, async (value, execution) => {
                requirePersonalScope(execution.scope); return inspectOpenApi(value, execution.signal || new AbortController().signal, network);
            });
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope);
                const data = await ctx.delivery.toolGateway.execute(tool, inspectInput.parse(request.input), { runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: manifest.requirements.tools, budget: new RunToolCallBudget(1) });
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: 1 }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { privateKnowledge: true, artifactRole: 'openapi.catalog', title: 'OpenAPI 接口目录' } }] };
            });
        },
    };
}
export const openApiSetupPlugin = createOpenApiSetupPlugin();
export default openApiSetupPlugin;
