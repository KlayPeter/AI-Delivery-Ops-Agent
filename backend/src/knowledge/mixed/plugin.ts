import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { ToolExecutionContext } from '@/platform/tools/contracts';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { knowledgeSearchInput } from '../search';
import { requirePersonalScope, requirePersonalVersionScope } from '../scope';
import { retrievalEvidence } from '../answer/evidence';
import { contentHash } from '../markdown/parser';
import { versionRequest, versionResult } from '../versions';

export const MIXED_CAPABILITY = 'knowledge.mixed.retrieve';
export const mixedSourcePort = { pluginId: 'knowledge.mixed', searchTool: 'knowledge.mixed.search', toolCalls: 3 };
export const MIXED_VERSIONS_TOOL = 'knowledge.mixed.versions';
const kinds = ['markdown', 'web'] as const;
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.knowledge-mixed', name: '笔记与网页混合检索', version: '1.0.0',
    description: '在明确配置的笔记目录与公开网页中并行检索，交错合并片段，保留各自来源和版本；单个来源失败明确标记。',
    runtime: { type: 'native' }, capabilities: [MIXED_CAPABILITY], triggers: ['manual', 'agent'],
    inputSchema: { type: 'object', required: ['operation', 'query'], properties: { operation: { const: 'search' }, query: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false },
    outputSchema: { type: 'object' }, requirements: { tools: [mixedSourcePort.searchTool], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 60, maxSteps: 3, maxToolCalls: 3, maxAgentCalls: 0, maxOutputBytes: 512 * 1024 },
    delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};

export const knowledgeMixedPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: mixedSourcePort.pluginId, name: manifest.name, version: '1.1.0', description: manifest.description, requires: ['knowledge.markdown', 'knowledge.web'] },
    agents: [{ manifest, installationId: 'install-knowledge-mixed' }],
    apply(ctx) {
        const invoke = (kind: typeof kinds[number], operation: 'search' | 'versions', input: unknown, execution: ToolExecutionContext) => {
            if (!execution.budget) throw new Error('混合知识检索必须沿用共享 Tool 预算');
            const id = `knowledge.${kind}.${operation}`;
            return ctx.delivery.toolGateway.execute(id, input, { ...execution, allowedTools: [id], budget: execution.budget });
        };
        ctx.delivery.tools.register({ id: mixedSourcePort.searchTool, version: '1.0.0', description: manifest.description,
            inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false }, outputSchema: { type: 'object' },
            sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 55 }, async (value, execution) => {
            requirePersonalScope(execution.scope);
            if (!execution.budget) throw new Error('混合知识检索必须沿用共享 Tool 预算');
            const input = knowledgeSearchInput.parse(value);
            const results = await Promise.allSettled(kinds.map(async kind => {
                const result = retrievalEvidence.parse(await invoke(kind, 'search', input, execution));
                if (result.source.partial && result.source.indexed === 0) throw new Error('来源未能读取任何文档');
                if (result.hits.some(hit => hit.sourceKind !== kind || !hit.sourceKey)) throw new Error('来源缺少可复核身份');
                return result;
            }));
            execution.signal.throwIfAborted();
            const budgetError = results.find(result => result.status === 'rejected' && result.reason?.code === 'TOOL_CALL_LIMIT_EXCEEDED');
            if (budgetError?.status === 'rejected') throw budgetError.reason;
            if (results.every(result => result.status === 'rejected')) throw new Error('笔记与网页均无法读取，请检查各自来源配置');
            const sources = results.map((result, index) => result.status === 'fulfilled'
                ? { kind: kinds[index]!, status: 'available' as const, indexed: result.value.source.indexed, partial: result.value.source.partial, version: result.value.source.version }
                : { kind: kinds[index]!, status: 'unavailable' as const, indexed: 0, partial: true });
            const ranked = results.flatMap((result, sourceIndex) => result.status === 'fulfilled' ? result.value.hits.map((hit, rank) => ({ hit, rank, sourceIndex })) : [])
                .sort((a, b) => a.rank - b.rank || a.sourceIndex - b.sourceIndex);
            const seen = new Set<string>();
            const hits = ranked.map(item => item.hit).filter(hit => { if (seen.has(hit.citationId)) return false; seen.add(hit.citationId); return true; }).slice(0, input.limit);
            return { query: input.query, retrieval: 'keyword', merge: 'interleaved', source: { sourceId: 'mixed', version: contentHash(JSON.stringify(sources)),
                syncedAt: new Date().toISOString(), indexed: sources.reduce((sum, source) => sum + source.indexed, 0), partial: sources.some(source => source.partial), sources }, hits };
        });
        ctx.delivery.tools.register({ id: MIXED_VERSIONS_TOOL, version: '1.1.0', description: 'Route saved note and public URL references to their configured source version tools without changing source identity.',
            inputSchema: { type: 'object', required: ['documents'], properties: { documents: { type: 'array' } }, additionalProperties: false }, outputSchema: { type: 'object' },
            sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 55 }, async (value, execution) => {
            requirePersonalVersionScope(execution.scope);
            if (!execution.budget) throw new Error('混合知识检索必须沿用共享 Tool 预算');
            const input = versionRequest.parse(value);
            const results = await Promise.allSettled(kinds.map(async kind => {
                const documents = input.documents.filter(document => /^https?:\/\//i.test(document.path) === (kind === 'web'));
                if (!documents.length) return [];
                try {
                    const result = versionResult.parse(await invoke(kind, 'versions', { documents }, execution));
                    const key = (reference: typeof documents[number]) => JSON.stringify([reference.path, reference.sourceKey, reference.documentVersion]);
                    const expected = new Set(documents.map(key));
                    if (result.documents.length !== documents.length || new Set(result.documents.map(key)).size !== expected.size || result.documents.some(reference => !expected.has(key(reference)))) throw new Error('版本结果不匹配');
                    return result.documents;
                } catch (error: any) {
                    execution.signal.throwIfAborted();
                    if (error?.code === 'TOOL_CALL_LIMIT_EXCEEDED' || !execution.budget) throw error;
                    return documents.map(document => ({ ...document, status: 'unavailable' as const }));
                }
            }));
            execution.signal.throwIfAborted();
            const failed = results.find(result => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
            return { checkedAt: new Date().toISOString(), documents: results.flatMap(result => result.status === 'fulfilled' ? result.value : []) };
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope);
            const { operation: _operation, ...input } = request.input as { operation: string; query: string; limit?: number };
            const parsed = knowledgeSearchInput.parse(input), budget = new RunToolCallBudget(3);
            const data = await ctx.delivery.toolGateway.execute(mixedSourcePort.searchTool, parsed, { runId: request.runId, agentId: manifest.id, scope: request.scope,
                signal, allowedTools: manifest.requirements.tools, budget, idempotencyKey: `${request.runId}:mixed-search` });
            return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data,
                metadata: { privateKnowledge: true, title: manifest.name, retrieval: 'keyword' } }] };
        });
    },
};
export default knowledgeMixedPlugin;
