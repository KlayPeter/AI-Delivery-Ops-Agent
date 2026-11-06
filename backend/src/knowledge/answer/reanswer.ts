import { z } from 'zod';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { checkHash } from '@/platform/plugins/checks';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const reanswerInput = z.object({ runId: z.string().uuid(), artifactHash: hash, contextHash: hash, confirmed: z.literal(true) }).strict();
export const questionSchema = z.string().trim().min(1).max(500);

export async function readReanswerSource(store: PersistentKeyValueStore, scope: { workspaceId: string; botInstanceId: string }, runId: string) {
    z.string().uuid().parse(runId);
    const runs = new PersistentAgentRunStore(store), run = await runs.get(runId);
    if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.capability !== 'knowledge.answer'
        || run.status !== 'succeeded' || run.parentRunId || run.rootRunId !== run.id) throw new Error('只能从当前工作区成功的根知识回答重新提问');
    const artifacts = (await runs.listArtifacts(run.id)).filter(artifact => artifact.type === 'json' && artifact.mediaType === 'application/json' && artifact.schemaVersion === '1.0' && artifact.metadata.privateKnowledge === true);
    if (artifacts.length !== 1 || Buffer.byteLength(JSON.stringify(artifacts[0]!.content) || '') > 512 * 1024) throw new Error('原回答缺少唯一且受支持的知识结果');
    const artifact = artifacts[0]!, content = z.object({ question: questionSchema, status: z.enum(['answered', 'insufficient_evidence']) }).parse(artifact.content);
    return { runId: run.id, artifactId: artifact.id, artifactHash: checkHash(artifact.content), question: content.question };
}
