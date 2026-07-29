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

export class TriggerRuntime {
    constructor(
        private readonly claims: TriggerClaimStore,
        private readonly agents: AgentRuntime,
        private readonly outbox: DeliveryOutbox,
    ) {}

    async dispatch<T>(trigger: TriggerEnvelope, capability: string, input: T): Promise<TriggerDispatchOutcome> {
        const claim = await this.claims.claim(trigger);
        if (!claim.claimed) return { status: 'duplicate', claim: claim.record, deliveries: [] };

        try {
            const execution = await this.agents.execute(trigger, capability, input);
            if (execution.run.status === 'failed') {
                const failed = await this.claims.fail(
                    trigger.idempotencyKey,
                    execution.run.error || { code: 'AGENT_FAILED', message: 'Agent failed', retryable: false },
                    execution.run.id,
                );
                return { status: 'failed', claim: failed, execution, deliveries: [] };
            }

            const target = this.resolveTarget(trigger);
            const deliveries = target ? await Promise.all(execution.artifacts.map(artifact => this.outbox.enqueue({
                deliveryKey: this.deliveryKey(execution.run.id, artifact.id, target), artifact, target,
            }))) : [];
            const completed = await this.claims.complete(trigger.idempotencyKey, execution.run.id);
            return { status: 'processed', claim: completed, execution, deliveries };
        } catch (cause: any) {
            const error = {
                code: cause?.code || 'TRIGGER_DISPATCH_ERROR',
                message: cause?.message || String(cause),
                retryable: cause?.retryable === true,
            };
            const failed = await this.claims.fail(trigger.idempotencyKey, error);
            return { status: 'failed', claim: failed, deliveries: [] };
        }
    }

    async resume<T>(trigger: TriggerEnvelope, runId: string, input: T): Promise<TriggerDispatchOutcome> {
        const claim = await this.claims.claim(trigger);
        if (!claim.claimed) return { status: 'duplicate', claim: claim.record, deliveries: [] };
        try {
            const execution = await this.agents.resume(trigger, runId, input);
            if (execution.run.status === 'failed') {
                const failed = await this.claims.fail(
                    trigger.idempotencyKey,
                    execution.run.error || { code: 'AGENT_FAILED', message: 'Agent failed', retryable: false },
                    execution.run.id,
                );
                return { status: 'failed', claim: failed, execution, deliveries: [] };
            }
            const target = this.resolveTarget(trigger);
            const deliveries = target ? await Promise.all(execution.artifacts.map(artifact => this.outbox.enqueue({
                deliveryKey: this.deliveryKey(execution.run.id, artifact.id, target), artifact, target,
            }))) : [];
            const completed = await this.claims.complete(trigger.idempotencyKey, execution.run.id);
            return { status: 'processed', claim: completed, execution, deliveries };
        } catch (cause: any) {
            const error = { code: cause?.code || 'TRIGGER_RESUME_ERROR', message: cause?.message || String(cause), retryable: cause?.retryable === true };
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
