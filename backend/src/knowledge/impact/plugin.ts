import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { KNOWLEDGE_MARKDOWN_VERSIONS_TOOL } from '../markdown/plugin';
import { requirePersonalScope } from '../scope';
import { versionResult } from '../versions';
import { KnowledgeImpactService, type ImpactReport } from './service';

export const KNOWLEDGE_IMPACT_CAPABILITY = 'knowledge.impact.check';
const inputSchema = z.object({ runIds: z.array(z.string().min(1).max(256)).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Duplicate target run ID'), operation: z.enum(['check', 'status']).default('check') }).strict();
const referenceKey = (item: { path: string; sourceKey: string; documentVersion: string }) => JSON.stringify([item.sourceKey, item.path, item.documentVersion]);

export function createKnowledgeImpactPlugin(source = { pluginId: 'knowledge.markdown', versionsTool: KNOWLEDGE_MARKDOWN_VERSIONS_TOOL, kind: 'markdown' as 'markdown' | 'web' }): FeaturePlugin {
    const manifest: AgentManifest = {
        schemaVersion: '1.1', id: 'native.knowledge-impact', name: 'Knowledge change impact', version: '1.0.0',
        description: 'Check actual cited knowledge versions in selected past runs, preserve immutable artifacts, and record a review assessment without a model.',
        runtime: { type: 'native' }, capabilities: [KNOWLEDGE_IMPACT_CAPABILITY], triggers: ['manual', 'agent'],
        inputSchema: { type: 'object', required: ['runIds'], properties: { runIds: { type: 'array', items: { type: 'string' } }, operation: { type: 'string', enum: ['check', 'status'] } } },
        outputSchema: { type: 'object' }, requirements: { tools: [source.versionsTool], secrets: [], networkHosts: [] },
        limits: { timeoutSeconds: 90, maxSteps: 1, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 },
        delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
    };
    return {
        manifest: { apiVersion: '1.0', id: 'knowledge.impact', name: manifest.name, version: '1.0.0', description: manifest.description, requires: [source.pluginId] },
        agents: [{ manifest, installationId: 'install-knowledge-impact' }],
        apply(ctx) {
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope);
                const input = inputSchema.parse(request.input);
                signal.throwIfAborted();
                const service = new KnowledgeImpactService(ctx.delivery.getContext().store);
                const targets = await service.targets(request.scope, input.runIds);
                if (input.operation === 'status') return { status: 'succeeded', data: { operation: 'status', assessments: await Promise.all(input.runIds.map(id => service.latest(request.scope, id))) }, artifacts: [] };
                const revisions = await Promise.all(targets.map(target => service.begin(request.scope, target.run.id, request.runId)));
                const wanted = new Map<string, { path: string; sourceKey: string; documentVersion: string }>();
                for (const target of targets) for (const ref of target.references) {
                    if (ref.sourceKey && ref.sourceKind === source.kind) {
                        const document = { path: ref.path, sourceKey: ref.sourceKey, documentVersion: ref.documentVersion };
                        wanted.set(referenceKey(document), document);
                    }
                }
                let checked: z.infer<typeof versionResult> | undefined;
                let sourceFailed = false;
                if (wanted.size) {
                    try {
                        checked = versionResult.parse(await ctx.delivery.toolGateway.execute(source.versionsTool, { documents: [...wanted.values()] }, {
                            runId: request.runId, agentId: manifest.id, scope: request.scope, allowedTools: manifest.requirements.tools,
                            idempotencyKey: `${request.runId}:versions`, budget: new RunToolCallBudget(1), signal,
                        }));
                        if (checked.documents.length !== wanted.size || new Set(checked.documents.map(referenceKey)).size !== wanted.size || checked.documents.some(document => !wanted.has(referenceKey(document)))) throw new Error('Version response does not match requested references');
                    } catch { signal.throwIfAborted(); sourceFailed = true; checked = undefined; }
                }
                signal.throwIfAborted();
                const byKey = new Map(checked?.documents.map(document => [referenceKey(document), document]) || []);
                const assessments: Array<ImpactReport & { recordedAsLatest: boolean }> = [];
                for (let index = 0; index < targets.length; index++) {
                    const target = targets[index]!;
                    const references = target.references.map(reference => {
                        if (!reference.sourceKey || !reference.sourceKind) return { ...reference, status: 'legacy_unverifiable' as const };
                        if (reference.sourceKind !== source.kind) return { ...reference, status: 'out_of_scope' as const };
                        const current = byKey.get(referenceKey({ ...reference, sourceKey: reference.sourceKey }));
                        return { ...reference, status: current?.status || 'unavailable' as const, ...(current?.currentVersion ? { currentVersion: current.currentVersion } : {}) };
                    });
                    const state = target.problem ? 'unverifiable' : !references.length ? 'not_applicable'
                        : references.some(reference => reference.status === 'changed' || reference.status === 'missing') ? 'needs_review'
                        : references.some(reference => reference.status !== 'current') ? 'unverifiable' : 'current';
                    const report: ImpactReport = { runId: target.run.id, checkRunId: request.runId, artifactIds: target.artifactIds,
                        checkedAt: checked?.checkedAt || new Date().toISOString(), state, reason: target.problem || (sourceFailed ? 'source_check_failed' : !references.length ? 'no_cited_knowledge' : undefined), references, semanticImpact: 'not_assessed' };
                    signal.throwIfAborted();
                    assessments.push({ ...report, recordedAsLatest: await service.finish(request.scope, report, revisions[index]!) });
                }
                const data = { operation: 'check', assessments, checksOnlyDirectReferences: true };
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: wanted.size ? 1 : 0 }, artifacts: [{
                    type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { privateKnowledge: true, title: 'Knowledge change impact', semanticImpact: 'not_assessed' },
                }] };
            });
        },
    };
}
export const knowledgeImpactPlugin = createKnowledgeImpactPlugin();
export default knowledgeImpactPlugin;
