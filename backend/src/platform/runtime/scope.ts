import { randomUUID } from 'node:crypto';

export const DEFAULT_WORKSPACE_ID = 'workspace-default';
export const DEFAULT_BOT_INSTANCE_ID = 'bot-default';

export type TriggerType = 'message' | 'schedule' | 'webhook' | 'domain_event' | 'manual' | 'agent';

export interface TriggerScope {
    workspaceId: string;
    botInstanceId: string;
    triggerType: TriggerType;
    triggerId: string;
    conversationId?: string;
    chatId?: string;
    actorId?: string;
    locale: string;
    timezone: string;
}

export interface ExecutionScope extends TriggerScope {
    agentInstallationId: string;
    correlationId: string;
    causationId?: string;
}

export interface ReplyPolicy {
    mode: 'same_conversation' | 'configured_target' | 'none';
    targetId?: string;
    channel?: 'private' | 'group';
}

export interface TriggerEnvelope<TPayload = unknown> {
    id: string;
    type: TriggerType;
    occurredAt: string;
    receivedAt: string;
    scope: Readonly<TriggerScope>;
    idempotencyKey: string;
    payload: TPayload;
    trustedContext?: Readonly<Record<string, unknown>>;
    replyPolicy?: Readonly<ReplyPolicy>;
}

function required(value: string, field: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`${field} is required`);
    return normalized;
}

function keyPart(value: string): string {
    return encodeURIComponent(required(value, 'idempotency key part'));
}

export function triggerIdempotencyKey(scope: Pick<TriggerScope, 'workspaceId' | 'botInstanceId' | 'triggerType' | 'triggerId'>): string {
    return [scope.workspaceId, scope.botInstanceId, scope.triggerType, scope.triggerId].map(keyPart).join(':');
}

export function createTriggerScope(input: Omit<TriggerScope, 'locale' | 'timezone'> & Partial<Pick<TriggerScope, 'locale' | 'timezone'>>): Readonly<TriggerScope> {
    return Object.freeze({
        ...input,
        workspaceId: required(input.workspaceId, 'workspaceId'),
        botInstanceId: required(input.botInstanceId, 'botInstanceId'),
        triggerId: required(input.triggerId, 'triggerId'),
        locale: input.locale || 'zh-CN',
        timezone: input.timezone || 'Asia/Shanghai',
    });
}

export function createExecutionScope(
    triggerScope: TriggerScope,
    agentInstallationId: string,
    options: { correlationId?: string; causationId?: string } = {},
): Readonly<ExecutionScope> {
    return Object.freeze({
        ...triggerScope,
        agentInstallationId: required(agentInstallationId, 'agentInstallationId'),
        correlationId: required(options.correlationId || randomUUID(), 'correlationId'),
        causationId: options.causationId,
    });
}

export function createTriggerEnvelope<TPayload>(input: {
    id?: string;
    occurredAt: string;
    receivedAt?: string;
    scope: TriggerScope;
    payload: TPayload;
    trustedContext?: Record<string, unknown>;
    replyPolicy?: ReplyPolicy;
}): Readonly<TriggerEnvelope<TPayload>> {
    const id = required(input.id || randomUUID(), 'trigger envelope id');
    const envelope: TriggerEnvelope<TPayload> = {
        id,
        type: input.scope.triggerType,
        occurredAt: input.occurredAt,
        receivedAt: input.receivedAt || new Date().toISOString(),
        scope: Object.freeze({ ...input.scope }),
        idempotencyKey: triggerIdempotencyKey(input.scope),
        payload: input.payload,
        trustedContext: input.trustedContext ? Object.freeze(structuredClone(input.trustedContext)) : undefined,
        replyPolicy: input.replyPolicy ? Object.freeze({ ...input.replyPolicy }) : undefined,
    };
    return Object.freeze(envelope);
}
