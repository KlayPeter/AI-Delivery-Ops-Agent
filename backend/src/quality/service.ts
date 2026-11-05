import { z } from 'zod';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { validateSchema } from '@/platform/agents/schema';
import { checkHash, type RunCheckRegistry } from '@/platform/plugins/checks';

export const checkInput = z.object({ contractId: z.string().min(1).max(160), runId: z.string().uuid(), baselineRunId: z.string().uuid().optional() }).strict()
    .refine(value => value.runId !== value.baselineRunId, '请选择不同的基准运行');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const executionSchema = z.object({ schemaVersion: z.literal('1.0'), agentId: z.string().min(1).max(200), agentVersion: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), manifestHash: hash, inputHash: hash.optional() }).strict();
type Verdict = 'passed' | 'failed' | 'unverifiable';
interface Assertion { id: string; label: string; verdict: Verdict; message?: string }
type Scope = { workspaceId: string; botInstanceId: string };

export class RunCheckService {
    constructor(private readonly store: PersistentKeyValueStore, private readonly registry: RunCheckRegistry) {}
    async check(scope: Scope, value: unknown, signal?: AbortSignal) {
        const input = checkInput.parse(value), contract = this.registry.require(input.contractId);
        signal?.throwIfAborted();
        const runs = new PersistentAgentRunStore(this.store), ids = [input.runId, ...(input.baselineRunId ? [input.baselineRunId] : [])];
        const targets = await Promise.all(ids.map(id => runs.get(id)));
        for (const run of targets) {
            if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId) throw new Error('目标运行不存在或不属于当前范围');
            if (run.capability !== contract.capability) throw new Error('目标运行与所选验收规则的能力不匹配');
            if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) throw new Error('目标运行尚未结束，请完成后再验收');
        }
        const reports = [];
        for (const run of targets) {
            signal?.throwIfAborted();
            const [steps, artifacts] = await Promise.all([runs.listSteps(run!.id), runs.listArtifacts(run!.id)]);
            if (steps.length > 256 || artifacts.length > 20 || Buffer.byteLength(JSON.stringify({ run, steps, artifacts })) > 4 * 1024 * 1024) throw new Error('目标运行记录超过验收预算');
            const assertions: Assertion[] = [{ id: 'run.status', label: '运行状态', verdict: run!.status === contract.expectedStatus ? 'passed' : 'failed', message: `预期 ${contract.expectedStatus}，实际 ${run!.status}` }];
            const agentSteps = steps.filter(step => step.kind === 'agent' && !step.name.startsWith('delegate:'));
            const parsed = agentSteps.map(step => executionSchema.safeParse(step.metadata?.execution));
            const executions = parsed.flatMap((item, index) => item.success ? [{ stepId: agentSteps[index]!.id, ...item.data }] : []);
            assertions.push({ id: 'run.execution', label: '执行身份与版本凭证', verdict: agentSteps.some(step => step.name !== contract.agentId) || executions.some(item => item.agentId !== contract.agentId) ? 'failed'
                : agentSteps.length && executions.length === agentSteps.length ? 'passed' : 'unverifiable', message: executions.length === agentSteps.length && agentSteps.length ? undefined : '旧记录或不完整记录缺少执行快照；未根据当前安装版本补造凭证' });
            for (const expected of contract.artifacts) {
                signal?.throwIfAborted();
                const matches = artifacts.filter(artifact => artifact.type === expected.type);
                const errors = matches.length === 1 ? validateSchema(matches[0], expected.schema) : [`预期一个 ${expected.type} 产物，实际 ${matches.length} 个`];
                assertions.push({ id: `artifact:${expected.id}`, label: `${expected.type} 产物 · ${expected.id}`, verdict: errors.length ? 'failed' : 'passed', message: errors.length ? errors.join('; ').slice(0, 500) : undefined });
            }
            for (const expected of contract.steps) assertions.push({ id: `step:${expected.id}`, label: `步骤 · ${expected.name}`, verdict: steps.some(step => step.kind === expected.kind && step.name === expected.name && step.status === expected.status) ? 'passed' : 'failed', message: `需要已记录的 ${expected.status} 步骤` });
            reports.push({ runId: run!.id, capability: run!.capability, runStatus: run!.status, verdict: assertions.some(item => item.verdict === 'failed') ? 'failed' as const : assertions.some(item => item.verdict === 'unverifiable') ? 'unverifiable' as const : 'passed' as const,
                assertions, executions, evidenceHash: checkHash({ run, steps, artifacts }), artifactIds: artifacts.map(item => item.id), stepCount: steps.length });
        }
        const current = reports[0]!, baseline = reports[1];
        const previous = new Map(baseline?.assertions.map(item => [item.id, item.verdict]));
        const inputHash = (report: typeof current) => report.executions.length === 1 ? report.executions[0]!.inputHash : undefined;
        const currentInput = inputHash(current), baselineInput = baseline && inputHash(baseline);
        return { schemaVersion: '1.0', checkedAt: new Date().toISOString(), contract, current, ...(baseline ? { baseline, comparison: {
            regressed: current.assertions.filter(item => previous.get(item.id) === 'passed' && item.verdict === 'failed').map(item => item.id),
            improved: current.assertions.filter(item => previous.get(item.id) === 'failed' && item.verdict === 'passed').map(item => item.id),
            recordedRequestInputsMatch: currentInput && baselineInput ? currentInput === baselineInput : null,
        } } : {}), reexecuted: false, assessmentScope: 'recorded_outputs_and_steps', semanticQuality: 'not_assessed' };
    }
}
export type RunCheckReport = Awaited<ReturnType<RunCheckService['check']>>;
