import { z } from 'zod';
import { stringify } from 'yaml';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { validateBundle } from './source';

export const INSPECT_CAPABILITY = 'skills.github.inspect', RUN_CAPABILITY = 'skills.prompt.run', INSPECTION_ROLE = 'skill.github.inspection';
export const exportInput = z.object({ inspectionRunId: z.string().uuid(), reviewedSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmedPromptOnly: z.literal(true), confirmedLicense: z.literal(true) }).strict();
export async function readInspection(store: PersistentKeyValueStore, scope: { workspaceId: string; botInstanceId: string }, id: string) {
    const runs = new PersistentAgentRunStore(store), run = await runs.get(z.string().uuid().parse(id));
    if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.parentRunId || run.status !== 'succeeded' || run.capability !== INSPECT_CAPABILITY) throw new Error('请选择当前范围内成功的 Skill 发现根记录');
    const artifacts = (await runs.listArtifacts(id)).filter(artifact => artifact.type === 'json' && artifact.metadata?.artifactRole === INSPECTION_ROLE);
    if (artifacts.length !== 1 || Buffer.byteLength(JSON.stringify(artifacts[0]!.content)) > 512 * 1024) throw new Error('发现记录缺少有效的 Skill 来源');
    return validateBundle(artifacts[0]!.content);
}
export async function exportSkillProfile(store: PersistentKeyValueStore, scope: { workspaceId: string; botInstanceId: string }, value: unknown) {
    const input = exportInput.parse(value), { bundle } = await readInspection(store, scope, input.inspectionRunId);
    if (input.reviewedSha256 !== bundle.sha256) throw new Error('审查指纹与发现记录不一致');
    return { filename: 'plugins.skill-reviewed.local.yaml', yaml: stringify({ apiVersion: '1.0', plugins: [
        ...['openai', 'google', 'ollama'].map(id => ({ module: `./src/platform/models/providers/${id}Plugin.ts` })),
        { module: './src/connectors/skill-workbench/setupPlugin.ts' },
        { module: './src/connectors/skill-workbench/promptPlugin.ts', config: { bundle, reviewedSha256: input.reviewedSha256, confirmedPromptOnly: true, confirmedLicense: true } },
    ] }) };
}
