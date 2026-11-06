import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AgentRequest, JsonSchema } from '@/platform/agents/contracts';
import { validateSchema } from '@/platform/agents/schema';
import type { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PluginHostServices } from '@/platform/plugins/contracts';

export const externalRequestSchema = { type: 'object', required: ['toolId', 'arguments', 'contractSha256'], properties: {
    toolId: { type: 'string', pattern: '^(mcp|openapi)\\.[a-z][a-z0-9-]{0,63}\\.[a-z][a-z0-9-]{0,63}$' }, arguments: { type: 'object' }, contractSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
}, additionalProperties: false };
const selection = z.object({ toolId: z.string().regex(/^(mcp|openapi)\.[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/), arguments: z.record(z.string(), z.json()), contractSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const selections = z.array(selection).max(3);
const role = 'personal.research.requests', stepName = 'research.external-requests';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message: string) => Object.assign(new Error(message), { code: 'RESEARCH_REQUESTS_NOT_APPROVED', retryable: false });
const routes = [{ prefix: 'mcp.', kind: 'mcp-http', capability: 'mcp.tools.run', route: 'mcp-runner.invoke' }, { prefix: 'openapi.', kind: 'openapi-get', capability: 'openapi.tools.run', route: 'openapi-runner.invoke' }] as const;

export function researchTools(services: PluginHostServices, scope: { workspaceId: string; botInstanceId: string }) {
    const registered = services.tools.list();
    const tools = routes.flatMap(source => {
        let resolved;
        try { resolved = services.agents.resolve(scope.workspaceId, scope.botInstanceId, source.capability); } catch { return []; }
        const route = registered.find(tool => tool.id === source.route);
        if (!route || route.sideEffect !== 'read') return [];
        return registered.filter(tool => tool.id.startsWith(source.prefix) && tool.sideEffect === 'read' && tool.binding?.kind === source.kind
            && !validateSchema({ toolId: tool.id, arguments: {} }, route.inputSchema).length).map(tool => ({
                id: tool.id, capability: source.capability, description: tool.description, inputSchema: tool.inputSchema, destination: tool.binding!.url,
                contractSha256: hash([tool, route, resolved.manifest, resolved.installation.id]),
            }));
    });
    if (tools.length > 70 || Buffer.byteLength(JSON.stringify(tools)) > 1024 * 1024) throw failure('研究工具目录超过预算，请减少装配的工具。');
    return tools;
}

export function createResearchRequests(services: PluginHostServices, runs: PersistentAgentRunStore) {
    const validate = (entries: z.infer<typeof selections>, request: AgentRequest) => {
        if (!entries.length) return [];
        const tools = researchTools(services, request.scope);
        return entries.map(entry => {
            const tool = tools.find(tool => tool.id === entry.toolId && tool.contractSha256 === entry.contractSha256);
            if (!tool || Buffer.byteLength(JSON.stringify(entry.arguments)) > 32768 || validateSchema(entry.arguments, tool.inputSchema).length) throw failure('工具已变更、不可用或参数不符，请重新选择工具并发起研究。');
            return { ...entry, capability: tool.capability, destination: tool.destination };
        });
    };
    const stored = async (request: AgentRequest) => {
        const steps = (await runs.listSteps(request.runId)).filter(step => step.name === stepName);
        if (!steps.length) return null;
        if (steps.length !== 1 || steps[0]!.status !== 'succeeded') throw failure('工具请求确认记录不完整。');
        const marker = steps[0]!.metadata!;
        const artifacts = (await runs.listArtifacts(request.runId)).filter(artifact => artifact.metadata.artifactRole === role);
        if (!marker.count) {
            if (artifacts.length || marker.sha256 !== hash([])) throw failure('工具请求确认记录不一致。');
            return [];
        }
        if (artifacts.length !== 1 || artifacts[0]!.id !== marker.artifactId || hash(artifacts[0]!.content) !== marker.sha256) throw failure('工具请求确认内容已变更。');
        const entries = selections.parse((artifacts[0]!.content as { requests?: unknown })?.requests);
        if (entries.length !== marker.count) throw failure('工具请求确认数量不一致。');
        return entries;
    };
    return {
        async prepare(request: AgentRequest, signal: AbortSignal) {
            const input = request.input as { externalRequests?: unknown; confirmedExternalRequests?: unknown };
            const selected = selections.parse(input.externalRequests === undefined ? [] : input.externalRequests);
            if (selected.some((entry, index) => selected.slice(0, index).some(previous => isDeepStrictEqual(previous, entry)))) throw failure('固定工具请求不能重复。');
            const previous = await stored(request);
            if (previous) {
                if (input.externalRequests !== undefined && !isDeepStrictEqual(selected, previous)) throw failure('继续研究不能新增或修改工具请求，请新建任务。');
                validate(previous, request); return;
            }
            if (selected.length) {
                const run = await runs.get(request.runId);
                if (!run || run.parentRunId || run.triggerType !== 'manual' || input.confirmedExternalRequests !== true
                    || (await runs.listSteps(request.runId)).filter(step => step.kind === 'agent' && !step.name.startsWith('delegate:')).length !== 1) throw failure('固定外部请求必须在新的本机手动研究中明确确认。');
                validate(selected, request);
            }
            signal.throwIfAborted();
            const artifactId = selected.length ? randomUUID() : undefined, now = new Date().toISOString();
            const content = { requests: selected, bindings: selected.length ? validate(selected, request).map(entry => ({ toolId: entry.toolId, destination: entry.destination, capability: entry.capability, contractSha256: entry.contractSha256 })) : [] };
            if (artifactId) await runs.saveArtifacts([{ id: artifactId, runId: request.runId, type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content, createdAt: now,
                metadata: { title: '本次确认的固定外部请求', privateKnowledge: true, artifactRole: role, verification: 'recorded_not_executed',
                    statusPanels: [{ schemaVersion: '1.0', tone: 'neutral', title: '已记录本次固定请求', description: '这里只记录用户确认的范围，不代表工具已执行。参数与当时的服务地址保留在详情，实际结果请查看子任务。', items: [{ label: '允许范围', value: `${selected.length} 份固定请求` }] }] } }]);
            await runs.saveStep({ id: randomUUID(), runId: request.runId, kind: 'guardrail', name: stepName, status: 'succeeded', startedAt: now, completedAt: now,
                metadata: { privateKnowledge: true, count: selected.length, sha256: hash(artifactId ? content : []), ...(artifactId ? { artifactId } : {}) } });
        },
        async schema(request: AgentRequest, capability: string): Promise<JsonSchema | null | undefined> {
            if (!routes.some(route => route.capability === capability)) return undefined;
            const entries = validate(await stored(request) || [], request).filter(entry => entry.capability === capability);
            return entries.length ? { oneOf: entries.map(entry => ({ const: { toolId: entry.toolId, arguments: entry.arguments } })) } : null;
        },
    };
}
