import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { KNOWLEDGE_MARKDOWN_VERSIONS_TOOL } from '../markdown/plugin';
import { requirePersonalVersionScope } from '../scope';
import { versionResult, versionRequest, quoteBudget, acceptsQuoteChecks } from '../versions';
import { KnowledgeImpactService, type ImpactReport } from './service';
import { knowledgeReviewPanel } from './presentation';

export const KNOWLEDGE_IMPACT_CAPABILITY = 'knowledge.impact.check';
const inputSchema = z.object({ runIds: z.array(z.string().min(1).max(256)).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Duplicate target run ID'), operation: z.enum(['check', 'status']).default('check') }).strict();
const reviewIds = z.array(z.string().min(1).max(256)).max(50).refine(ids => new Set(ids).size === ids.length);
const referenceKey = (item: { path: string; sourceKey: string; documentVersion: string }) => JSON.stringify([item.sourceKey, item.path, item.documentVersion]);

export function createKnowledgeImpactPlugin(source = { pluginId: 'knowledge.markdown', versionsTool: KNOWLEDGE_MARKDOWN_VERSIONS_TOOL, kind: 'markdown' as 'markdown' | 'web' | 'mixed' }): FeaturePlugin {
    const maxToolCalls = source.kind === 'mixed' ? 3 : 1;
    const accepts = (kind: string) => source.kind === 'mixed' ? ['markdown', 'web'].includes(kind) : kind === source.kind;
    const manifest: AgentManifest = {
        schemaVersion: '1.1', id: 'native.knowledge-impact', name: 'Knowledge change impact', version: '1.2.0',
        description: 'Check actual cited knowledge versions in selected past runs, preserve immutable artifacts, and record a review assessment without a model.',
        runtime: { type: 'native' }, capabilities: [KNOWLEDGE_IMPACT_CAPABILITY], triggers: ['manual', 'agent', 'schedule'],
        inputSchema: { type: 'object', required: ['runIds'], properties: { runIds: { type: 'array', items: { type: 'string' } }, operation: { type: 'string', enum: ['check', 'status'] } } },
        outputSchema: { type: 'object' }, requirements: { tools: [source.versionsTool], secrets: [], networkHosts: [] },
        limits: { timeoutSeconds: 90, maxSteps: 1, maxToolCalls, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 },
        delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
    };
    return {
        manifest: { apiVersion: '1.0', id: 'knowledge.impact', name: manifest.name, version: '1.3.0', description: manifest.description, requires: [source.pluginId] },
        agents: [{ manifest, installationId: 'install-knowledge-impact' }],
        apply(ctx) {
            ctx.delivery.web.register({ id: 'knowledge.impact', pages: [{ path: '/knowledge-reviews', label: '知识复核', section: 'workspace', view: { kind: 'builtin', id: 'knowledge-reviews', capability: KNOWLEDGE_IMPACT_CAPABILITY } }],
                api: { prefix: '/api/knowledge-impact', routes: [{ method: 'GET', path: '/api/knowledge-impact/reviews' }], async handle(request) {
                    const url = new URL(request.url);
                    if (request.method !== 'GET' || url.pathname !== '/api/knowledge-impact/reviews') return Response.json({ error: '当前插件未提供此接口' }, { status: 404 });
                    if (url.search.length > 15000) return Response.json({ error: '查询超过大小限制' }, { status: 413 });
                    const input = reviewIds.safeParse(url.searchParams.getAll('runId'));
                    if (!input.success || [...url.searchParams.keys()].some(key => key !== 'runId')) return Response.json({ error: '请选择最多 50 个不同的运行记录' }, { status: 400 });
                    try {
                        const reviews = await new KnowledgeImpactService(ctx.delivery.getContext().store).reviews({ workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID }, input.data);
                        return Response.json({ reviews });
                    } catch { return Response.json({ error: '无法读取所选历史记录，请刷新列表并确认运行属于当前工作区' }, { status: 400 }); }
                } },
            });
            ctx.delivery.runActions.register({
                id: 'knowledge.review', label: '检查引用变化', description: '只检查此结果实际引用的资料，不修改原回答。',
                capability: KNOWLEDGE_IMPACT_CAPABILITY, appliesTo: ['knowledge.answer', 'release.prepare'],
                input: runId => ({ operation: 'check', runIds: [runId] }),
                readState: async run => knowledgeReviewPanel(await new KnowledgeImpactService(ctx.delivery.getContext().store).latest(run, run.id)),
            });
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalVersionScope(request.scope);
                const input = inputSchema.parse(request.input);
                signal.throwIfAborted();
                const service = new KnowledgeImpactService(ctx.delivery.getContext().store);
                const targets = await service.targets(request.scope, input.runIds);
                if (input.operation === 'status') return { status: 'succeeded', data: { operation: 'status', assessments: await Promise.all(input.runIds.map(id => service.latest(request.scope, id))) }, artifacts: [] };
                const revisions = await Promise.all(targets.map(target => service.begin(request.scope, target.run.id, request.runId)));
                const wanted = new Map<string, z.infer<typeof versionRequest>['documents'][number]>();
                for (const target of targets) for (const ref of target.references) {
                    if (ref.sourceKey && ref.sourceKind && accepts(ref.sourceKind)) {
                        const document = { path: ref.path, sourceKey: ref.sourceKey, documentVersion: ref.documentVersion };
                        const key = referenceKey(document), previous = wanted.get(key);
                        wanted.set(key, { ...document, quotes: [...new Set([...(previous?.quotes || []), ...(ref.quotes || [])])] });
                    }
                }
                const supportsQuotes = acceptsQuoteChecks(ctx.delivery.tools.list().find(tool => tool.id === source.versionsTool)?.inputSchema);
                let quoteCount = 0, quoteBytes = 0;
                for (const document of wanted.values()) {
                    const quotes = document.quotes || [], bytes = quotes.reduce((sum, quote) => sum + Buffer.byteLength(quote), 0);
                    if (!supportsQuotes || !quotes.length || quotes.length > quoteBudget.perDocument || quoteCount + quotes.length > quoteBudget.count || quoteBytes + bytes > quoteBudget.bytes) delete document.quotes;
                    else { quoteCount += quotes.length; quoteBytes += bytes; }
                }
                const budget = new RunToolCallBudget(maxToolCalls);
                let checked: z.infer<typeof versionResult> | undefined;
                let sourceFailed = false;
                if (wanted.size) {
                    try {
                        checked = versionResult.parse(await ctx.delivery.toolGateway.execute(source.versionsTool, { documents: [...wanted.values()] }, {
                            runId: request.runId, agentId: manifest.id, scope: request.scope, allowedTools: manifest.requirements.tools,
                            idempotencyKey: `${request.runId}:versions`, budget, signal,
                        }));
                        if (checked.documents.length !== wanted.size || new Set(checked.documents.map(referenceKey)).size !== wanted.size || checked.documents.some(document => !wanted.has(referenceKey(document)))) throw new Error('Version response does not match requested references');
                        for (const document of checked.documents) {
                            const quotes = wanted.get(referenceKey(document))!.quotes || [], checks = document.quoteChecks;
                            if (checks && (checks.length !== quotes.length || new Set(checks.map(check => check.quote)).size !== quotes.length || checks.some(check => !quotes.includes(check.quote)))) throw new Error('Quote response does not match requested probes');
                        }
                    } catch { signal.throwIfAborted(); sourceFailed = true; checked = undefined; }
                }
                signal.throwIfAborted();
                const byKey = new Map(checked?.documents.map(document => [referenceKey(document), document]) || []);
                const assessments: Array<ImpactReport & { recordedAsLatest: boolean }> = [];
                for (let index = 0; index < targets.length; index++) {
                    const target = targets[index]!;
                    const references = target.references.map(({ quotes, ...reference }) => {
                        if (!reference.sourceKey || !reference.sourceKind) return { ...reference, status: 'legacy_unverifiable' as const };
                        if (!accepts(reference.sourceKind)) return { ...reference, status: 'out_of_scope' as const };
                        const current = byKey.get(referenceKey({ ...reference, sourceKey: reference.sourceKey }));
                        return { ...reference, status: current?.status || 'unavailable' as const, ...(current?.currentVersion ? { currentVersion: current.currentVersion } : {}),
                            ...(current?.quoteChecks && quotes?.length && quotes.every(quote => current.quoteChecks!.some(check => check.quote === quote)) ? { quoteChecks: current.quoteChecks.filter(check => quotes.includes(check.quote)) } : {}) };
                    });
                    const quoteMismatch = references.some(reference => reference.status === 'current' && reference.quoteChecks?.some(check => check.status === 'not_found'));
                    const state = target.problem ? 'unverifiable' : !references.length ? 'not_applicable'
                        : quoteMismatch ? 'unverifiable'
                        : references.some(reference => reference.status === 'changed' || reference.status === 'missing') ? 'needs_review'
                        : references.some(reference => reference.status !== 'current') ? 'unverifiable' : 'current';
                    const report: ImpactReport = { runId: target.run.id, checkRunId: request.runId, artifactIds: target.artifactIds,
                        checkedAt: checked?.checkedAt || new Date().toISOString(), state, reason: target.problem || (quoteMismatch ? 'citation_quote_not_found' : sourceFailed ? 'source_check_failed' : !references.length ? 'no_cited_knowledge' : undefined), references, semanticImpact: 'not_assessed' };
                    signal.throwIfAborted();
                    assessments.push({ ...report, recordedAsLatest: await service.finish(request.scope, report, revisions[index]!) });
                }
                const data = { operation: 'check', assessments, checksOnlyDirectReferences: true };
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [{
                    type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: {
                        privateKnowledge: true, title: 'Knowledge change impact', semanticImpact: 'not_assessed',
                        statusPanels: assessments.map(report => ({ ...knowledgeReviewPanel(report), relatedRun: { id: report.runId, label: '返回原结果' },
                            ...(!report.recordedAsLatest ? { tone: 'warning', title: '该次检查不是最新评估', description: '检查完成前已有更新的评估，请回到原结果查看最新状态。' } : {}),
                        })),
                    },
                }] };
            });
        },
    };
}
export const knowledgeImpactPlugin = createKnowledgeImpactPlugin();
export default knowledgeImpactPlugin;
