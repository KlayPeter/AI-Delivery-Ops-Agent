import type { AgentError } from '@/platform/agents/contracts';
import type { TriggerEnvelope } from './scope';

type MaybePromise<T> = T | Promise<T>;

export type TriggerProcessingStatus = 'processing' | 'completed' | 'failed';

export interface TriggerProcessingRecord {
    idempotencyKey: string;
    envelopeId: string;
    status: TriggerProcessingStatus;
    claimedAt: string;
    updatedAt: string;
    runId?: string;
    requestHash?: string;
    error?: AgentError;
}

export interface TriggerClaimStore {
    claim(trigger: TriggerEnvelope, now?: Date, requestHash?: string): MaybePromise<{ claimed: boolean; record: TriggerProcessingRecord }>;
    linkRun(idempotencyKey: string, runId: string, now?: Date): MaybePromise<TriggerProcessingRecord>;
    complete(idempotencyKey: string, runId: string, now?: Date): MaybePromise<TriggerProcessingRecord>;
    fail(idempotencyKey: string, error: AgentError, runId?: string, now?: Date): MaybePromise<TriggerProcessingRecord>;
    get(idempotencyKey: string): MaybePromise<TriggerProcessingRecord | null>;
}

export class InMemoryTriggerClaimStore implements TriggerClaimStore {
    private readonly records = new Map<string, TriggerProcessingRecord>();

    claim(trigger: TriggerEnvelope, now: Date = new Date(), requestHash?: string): { claimed: boolean; record: TriggerProcessingRecord } {
        const existing = this.records.get(trigger.idempotencyKey);
        if (existing) return { claimed: false, record: this.copy(existing) };
        const timestamp = now.toISOString();
        const record: TriggerProcessingRecord = {
            idempotencyKey: trigger.idempotencyKey,
            envelopeId: trigger.id,
            status: 'processing',
            ...(requestHash ? { requestHash } : {}),
            claimedAt: timestamp,
            updatedAt: timestamp,
        };
        this.records.set(record.idempotencyKey, record);
        return { claimed: true, record: this.copy(record) };
    }

    linkRun(idempotencyKey: string, runId: string, now: Date = new Date()): TriggerProcessingRecord {
        const current = this.get(idempotencyKey);
        if (current?.runId && current.runId !== runId) throw new Error('Trigger claim already points to another run');
        return this.transition(idempotencyKey, { runId, updatedAt: now.toISOString() });
    }

    complete(idempotencyKey: string, runId: string, now: Date = new Date()): TriggerProcessingRecord {
        return this.transition(idempotencyKey, { status: 'completed', runId, error: undefined, updatedAt: now.toISOString() });
    }

    fail(idempotencyKey: string, error: AgentError, runId?: string, now: Date = new Date()): TriggerProcessingRecord {
        return this.transition(idempotencyKey, { status: 'failed', ...(runId === undefined ? {} : { runId }), error: { ...error }, updatedAt: now.toISOString() });
    }

    get(idempotencyKey: string): TriggerProcessingRecord | null {
        const record = this.records.get(idempotencyKey);
        return record ? this.copy(record) : null;
    }

    private transition(idempotencyKey: string, patch: Partial<TriggerProcessingRecord>): TriggerProcessingRecord {
        const current = this.records.get(idempotencyKey);
        if (!current) throw new Error(`Trigger claim not found: ${idempotencyKey}`);
        if (current.status !== 'processing') throw new Error(`Trigger claim is already terminal: ${idempotencyKey}`);
        const next = { ...current, ...patch };
        this.records.set(idempotencyKey, next);
        return this.copy(next);
    }

    private copy(record: TriggerProcessingRecord): TriggerProcessingRecord {
        return { ...record, error: record.error ? { ...record.error } : undefined };
    }
}
