import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { Artifact } from '@/platform/agents/contracts';
import { retrievalEvidence, selectEvidence } from '@/knowledge/answer/evidence';
import { sha256 } from './source';

export const knowledgeCapabilities = ['knowledge.markdown.retrieve', 'knowledge.web.retrieve', 'knowledge.mixed.retrieve'];
export const knowledgeSelection = z.object({ runId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict();
export const knowledgeSelectionSchema = { type: 'object', required: ['runId', 'sha256', 'confirmed'], additionalProperties: false, properties: {
    runId: { type: 'string', format: 'uuid' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, confirmed: { const: true },
} };
export const modelKnowledgeSchema = { type: 'object', required: ['historicalSnapshot', 'partial', 'evidence'], additionalProperties: false, properties: {
    historicalSnapshot: { const: true }, partial: { type: 'boolean' }, evidence: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', required: ['citationId', 'title', 'heading', 'excerpt'], additionalProperties: false, properties: {
        citationId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, title: { type: 'string', maxLength: 256 }, heading: { type: 'string', maxLength: 256 }, excerpt: { type: 'string', minLength: 1, maxLength: 2000 },
    } } },
} };

export async function readKnowledgeContext(store: PersistentKeyValueStore, scope: { workspaceId: string; botInstanceId: string }, runId: string) {
    const runs = new PersistentAgentRunStore(store), run = await runs.get(z.string().uuid().parse(runId));
    if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.parentRunId || run.rootRunId !== run.id || run.status !== 'succeeded' || !knowledgeCapabilities.includes(run.capability)) throw new Error('请选择当前范围内成功的知识检索根运行');
    const artifacts = (await runs.listArtifacts(run.id)).filter(artifact => artifact.type === 'json' && artifact.mediaType === 'application/json' && artifact.metadata?.privateKnowledge === true);
    if (artifacts.length !== 1 || Buffer.byteLength(JSON.stringify(artifacts[0]!.content)) > 128 * 1024) throw new Error('检索记录缺少唯一且有界的私有资料');
    const retrieved = retrievalEvidence.parse(artifacts[0]!.content), evidence = selectEvidence(retrieved.hits);
    if (!evidence.length) throw new Error('检索结果没有可用片段，请先完成一次命中资料的检索');
    const snapshot = { schemaVersion: '1.0', runId: run.id, artifactId: artifacts[0]!.id, capability: run.capability, createdAt: run.completedAt || run.createdAt,
        retrieval: { ...retrieved.source, method: retrieved.retrieval, candidateCount: retrieved.hits.length, suppliedCount: evidence.length, contextTruncated: evidence.length < retrieved.hits.length }, evidence };
    return { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
}

export function modelKnowledge(context: Awaited<ReturnType<typeof readKnowledgeContext>>) {
    return { historicalSnapshot: true, partial: context.snapshot.retrieval.partial, evidence: context.snapshot.evidence.map(({ citationId, title, heading, excerpt }) => ({ citationId, title, heading, excerpt })) };
}

export async function saveKnowledgeSelection(store: PersistentKeyValueStore, runId: string, context: Awaited<ReturnType<typeof readKnowledgeContext>>) {
    const runs = new PersistentAgentRunStore(store), now = new Date().toISOString();
    const receipt = { sourceRunId: context.snapshot.runId, sourceArtifactId: context.snapshot.artifactId, sha256: context.sha256 };
    const artifact: Artifact = { id: randomUUID(), runId, type: 'json', mediaType: 'application/json', schemaVersion: '1.0', createdAt: now,
        content: { ...context, selectedAt: now, verification: { modelReceived: 'not_verified', sourceUsage: 'not_verified', answerCitations: 'not_verified', sourceCurrentness: 'not_checked' } },
        metadata: { privateKnowledge: true, artifactRole: 'skill.knowledge.context', title: '本次选择的知识快照', statusPanels: [{ schemaVersion: '1.0', tone: 'neutral', title: '本次选择的知识快照',
            description: '以下为历史检索片段。记录证明本次选入，不证明模型已接收、实际采用或引用正确；未重新读取当前来源。',
            relatedRun: { id: context.snapshot.runId, label: '查看原检索与完整来源' },
            items: context.snapshot.evidence.map(hit => ({ label: hit.title || hit.path, value: `行 ${hit.lineStart}–${hit.lineEnd}`, detail: hit.excerpt })),
        }] } };
    if (Buffer.byteLength(JSON.stringify(artifact)) > 256 * 1024) throw new Error('所选知识快照超过保存预算');
    await runs.saveArtifacts([artifact]);
    await runs.saveStep({ id: randomUUID(), runId, kind: 'guardrail', name: 'skills.knowledge.context', status: 'succeeded', startedAt: now, completedAt: now, metadata: { ...receipt, selectionArtifactId: artifact.id, action: 'knowledge_snapshot_selected' } });
    return { ...receipt, selectionArtifactId: artifact.id };
}
