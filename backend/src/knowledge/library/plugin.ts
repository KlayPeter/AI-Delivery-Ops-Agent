import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { StatusPanel } from '@/platform/plugins/runActions';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { knowledgeSearchInput } from '@/knowledge/search';
import { requirePersonalScope } from '@/knowledge/scope';
import { KnowledgeLibrary, librarySources, type LibraryItem } from './service';

export const LIBRARY_CAPABILITY = 'knowledge.library.manage';
const saveInput = z.object({ runId: z.string().uuid() }).strict();
const inputSchema = z.discriminatedUnion('operation', [saveInput.extend({ operation: z.literal('save') }), knowledgeSearchInput.extend({ operation: z.literal('search') })]);
const schema = { type: 'object', required: ['operation'], properties: { operation: { type: 'string', enum: ['save', 'search'] }, runId: { type: 'string', format: 'uuid' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false };
const savedPanel = (item: LibraryItem): StatusPanel => ({ schemaVersion: '1.0', tone: 'success', title: '资料已收录', description: '保存于应用自己的本地资料库，可立即检索。原始结果和个人笔记保持原样。', checkedAt: item.savedAt,
    items: [{ label: item.title, value: 'Markdown 资料' }, { label: '收录内容 SHA-256', value: item.importedSha256 }], relatedRun: { id: item.runId, label: '查看原始结果' } });
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.knowledge-library', name: '个人资料库', version: '1.0.0', description: '显式收录成功的网页/文档结果，保留来源和内容指纹，并在本地检索；不调用模型。',
    runtime: { type: 'native' }, capabilities: [LIBRARY_CAPABILITY], triggers: ['manual', 'agent'], inputSchema: schema, outputSchema: { type: 'object' },
    requirements: { tools: ['knowledge.library.save', 'knowledge.library.search'], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 30, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};
export const knowledgeLibraryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'knowledge.library', name: '个人资料库', version: '1.0.0', description: manifest.description }, agents: [{ manifest, installationId: 'install-knowledge-library' }],
    async apply(ctx) {
        const library = new KnowledgeLibrary(ctx.delivery.getContext().config.data_path, ctx.delivery.getContext().store);
        await library.initialize();
        ctx.delivery.web.register({ id: 'knowledge.library', pages: [{ path: '/library', label: '资料库', section: 'workspace', view: { kind: 'builtin', id: 'knowledge-library', capability: LIBRARY_CAPABILITY } }],
            api: { prefix: '/api/library', routes: [{ method: 'GET', path: '/api/library' }], async handle(request) {
                if (request.method !== 'GET' || new URL(request.url).pathname !== '/api/library') return Response.json({ error: '当前插件未提供此接口' }, { status: 404 });
                try { return Response.json({ items: (await library.list()).map(({ item, modified }) => ({ ...item, modified })) }); }
                catch { return Response.json({ error: '无法读取本地资料库，请检查目录权限与资料文件' }, { status: 500 }); }
            } },
        });
        ctx.delivery.runActions.register({ id: 'knowledge.collect', label: '收录到资料库', description: '把此 Markdown 结果保存到应用的本地资料库，供后续检索；不会覆盖个人笔记。', capability: LIBRARY_CAPABILITY, appliesTo: librarySources,
            input: runId => ({ operation: 'save', runId }), async readState(run) {
                const saved = (await library.list(run)).find(entry => entry.item.runId === run.id);
                return saved ? { ...savedPanel(saved.item), checkedAt: new Date().toISOString(), relatedRun: undefined, ...(saved.modified ? { tone: 'warning' as const, title: '收录资料已有改动', description: '当前文件与收录时的内容不同，重复收录不会覆盖它。' } : {}) }
                    : { schemaVersion: '1.0', tone: 'neutral', title: '此资料尚未收录', description: '确认内容后点击收录，保存到应用自己的本地资料库。' };
            },
        });
        ctx.delivery.tools.register({ id: 'knowledge.library.save', version: '1.0.0', description: 'Explicitly save the one private Markdown artifact of a successful, same-scope capture/conversion run to the application library; never accept file paths or model-written content.', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string', format: 'uuid' } }, additionalProperties: false }, outputSchema: { type: 'object' }, sideEffect: 'write', riskLevel: 'low', idempotent: true, timeoutSeconds: 20 }, async (input, execution) => {
            requirePersonalScope(execution.scope); return library.save(execution.scope, saveInput.parse(input).runId, execution.signal);
        });
        ctx.delivery.tools.register({ id: 'knowledge.library.search', version: '1.0.0', description: 'Search explicitly collected local Markdown materials with exact excerpts, versions and source identity; no model calls.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 20 }, async (input, execution) => {
            requirePersonalScope(execution.scope); const query = knowledgeSearchInput.parse(input); await library.initialize(execution.scope);
            return library.source(execution.scope).search(query.query, query.limit, execution.signal);
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope); const input = inputSchema.parse(request.input);
            const saving = input.operation === 'save';
            const data = await ctx.delivery.toolGateway.execute(saving ? 'knowledge.library.save' : 'knowledge.library.search', saving ? { runId: input.runId } : { query: input.query, limit: input.limit }, {
                runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: manifest.requirements.tools, budget: new RunToolCallBudget(1), idempotencyKey: `${request.runId}:${input.operation}`,
            });
            return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: 1 }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data,
                metadata: { privateKnowledge: true, title: saving ? '资料收录' : '资料库检索', ...(saving ? { statusPanels: [savedPanel(data as LibraryItem)] } : {}) } }] };
        });
    },
};
export default knowledgeLibraryPlugin;
