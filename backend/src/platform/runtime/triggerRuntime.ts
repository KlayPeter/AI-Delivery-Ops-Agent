import { createHash } from 'node:crypto';
import type { AgentRunStatus } from '@/platform/agents/contracts';
import type { AgentExecutionOutcome } from '@/platform/agents/runtime';
import type { AgentRuntime } from '@/platform/agents/runtime';
import type { DeliveryOutbox, DeliveryRecord, DeliveryTarget } from '@/platform/delivery/contracts';
import type { TriggerEnvelope } from './scope';
import type { TriggerClaimStore, TriggerProcessingRecord } from './triggerStore';

export interface TriggerDispatchOutcome {
    status: 'processed' | 'failed' | 'duplicate';
    claim: TriggerProcessingRecord;
    execution?: AgentExecutionOutcome;
    deliveries: DeliveryRecord[];
}

export interface TriggerStartOutcome { runId: string; status: AgentRunStatus; completion?: Promise<TriggerDispatchOutcome> }

export class TriggerRuntime {
    private readonly starting = new Map<string, { hash: string; promise: Promise<TriggerStartOutcome> }>();
    constructor(
        private readonly claims: TriggerClaimStore,
        private readonly agents: AgentRuntime,
        private readonly outbox: DeliveryOutbox,
    ) {}

    async dispatch<T>(trigger: TriggerEnvelope, capability: string, input: T): Promise<TriggerDispatchOutcome> {
        const claim = await this.claims.claim(trigger);
        if (!claim.claimed) return { status: 'duplicate', claim: claim.record, deliveries: [] };
        return this.settle(trigger, this.agents.execute(trigger, capability, input));
    }

    async resume<T>(trigger: TriggerEnvelope, runId: string, input: T): Promise<TriggerDispatchOutcome> {
        const claim = await this.claims.claim(trigger);
        if (!claim.claimed) return { status: 'duplicate', claim: claim.record, deliveries: [] };
        return this.settle(trigger, this.agents.resume(trigger, runId, input), runId, 'TRIGGER_RESUME_ERROR');
    }

    start<T>(trigger: TriggerEnvelope, capability: string, input: T): Promise<TriggerStartOutcome> {
        const hash = createHash('sha256').update(JSON.stringify([capability, input])).digest('hex');
        const existing = this.starting.get(trigger.idempotencyKey);
        if (existing) {
            if (existing.hash !== hash) return Promise.reject(Object.assign(new Error('同一 triggerId 的任务参数不同，未重新执行'), { code: 'TRIGGER_INPUT_CHANGED' }));
            return existing.promise;
        }
        const promise = this.beginStart(trigger, capability, input, hash).finally(() => { if (this.starting.get(trigger.idempotencyKey)?.promise === promise) this.starting.delete(trigger.idempotencyKey); });
        this.starting.set(trigger.idempotencyKey, { hash, promise });
        return promise;
    }

    private async beginStart<T>(trigger: TriggerEnvelope, capability: string, input: T, hash: string): Promise<TriggerStartOutcome> {
        const claimed = await this.claims.claim(trigger, undefined, hash);
        if (!claimed.claimed) {
            if (claimed.record.requestHash !== hash) throw Object.assign(new Error('该 triggerId 已用于不同或无法核验的旧任务，请先检查运行记录'), { code: 'TRIGGER_INPUT_CHANGED' });
            if (!claimed.record.runId) throw Object.assign(new Error(claimed.record.error?.message || '启动回执尚未就绪，请用相同 triggerId 重试'), { code: claimed.record.error?.code || 'RUN_START_PENDING' });
            const run = await this.agents.getRun(claimed.record.runId);
            if (!run || run.workspaceId !== trigger.scope.workspaceId || run.botInstanceId !== trigger.scope.botInstanceId) throw new Error('启动回执缺少同范围的运行记录');
            return { runId: run.id, status: run.status };
        }
        let runId: string | undefined;
        try {
            const started = await this.agents.start(trigger, capability, input, async run => { runId = run.id; await this.claims.linkRun(trigger.idempotencyKey, run.id); });
            const completion = this.settle(trigger, started.completion, started.run.id);
            void completion.catch(() => {});
            return { runId: started.run.id, status: started.run.status, completion };
        } catch (cause: any) {
            await this.claims.fail(trigger.idempotencyKey, { code: cause?.code || 'RUN_START_ERROR', message: cause?.message || String(cause), retryable: cause?.retryable === true }, runId);
            if (runId) return { runId, status: (await this.agents.getRun(runId))!.status };
            throw cause;
        }
    }

    private async settle(trigger: TriggerEnvelope, pending: Promise<AgentExecutionOutcome>, fallbackRunId?: string, errorCode = 'TRIGGER_DISPATCH_ERROR'): Promise<TriggerDispatchOutcome> {
        let runId = fallbackRunId;
        try {
            const execution = await pending; runId = execution.run.id;
            if (['failed', 'cancelled'].includes(execution.run.status)) {
                const failed = await this.claims.fail(trigger.idempotencyKey, execution.run.error || { code: 'AGENT_FAILED', message: 'Agent failed', retryable: false }, execution.run.id);
                return { status: 'failed', claim: failed, execution, deliveries: [] };
            }
            const target = this.resolveTarget(trigger);
            const deliveries = target ? await Promise.all(execution.artifacts.map(artifact => this.outbox.enqueue({ deliveryKey: this.deliveryKey(execution.run.id, artifact.id, target), artifact, target }))) : [];
            const completed = await this.claims.complete(trigger.idempotencyKey, execution.run.id);
            return { status: 'processed', claim: completed, execution, deliveries };
        } catch (cause: any) {
            const error = { code: cause?.code || errorCode, message: cause?.message || String(cause), retryable: cause?.retryable === true };
            const failed = await this.claims.fail(trigger.idempotencyKey, error, runId);
            return { status: 'failed', claim: failed, deliveries: [] };
        }
    }

    private resolveTarget(trigger: TriggerEnvelope): DeliveryTarget | null {
        const policy = trigger.replyPolicy;
        if (!policy || policy.mode === 'none') return null;
        if (policy.mode === 'configured_target') {
            if (!policy.targetId) throw new Error('Configured delivery target is required');
            return {
                workspaceId: trigger.scope.workspaceId,
                botInstanceId: trigger.scope.botInstanceId,
                channel: policy.channel || 'group',
                targetId: policy.targetId,
            };
        }
        const targetId = trigger.scope.chatId || trigger.scope.conversationId;
        if (!targetId) throw new Error('Conversation delivery target is required');
        return {
            workspaceId: trigger.scope.workspaceId,
            botInstanceId: trigger.scope.botInstanceId,
            channel: trigger.scope.chatId ? 'group' : 'private',
            targetId,
        };
    }

    private deliveryKey(runId: string, artifactId: string, target: DeliveryTarget): string {
        return [runId, artifactId, target.botInstanceId, target.channel, target.targetId].map(encodeURIComponent).join(':');
    }
}
