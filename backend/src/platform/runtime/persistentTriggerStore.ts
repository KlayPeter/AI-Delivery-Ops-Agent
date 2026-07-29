import type { AgentError } from '@/platform/agents/contracts';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { interruptedByRestart } from './interruption';
import type { TriggerEnvelope } from './scope';
import type { TriggerClaimStore, TriggerProcessingRecord } from './triggerStore';

const PREFIX = 'agent:trigger:';

export class PersistentTriggerClaimStore implements TriggerClaimStore {
    constructor(private readonly store: PersistentKeyValueStore) {}

    async claim(trigger: TriggerEnvelope, now: Date = new Date()): Promise<{ claimed: boolean; record: TriggerProcessingRecord }> {
        const timestamp = now.toISOString();
        const record: TriggerProcessingRecord = {
            idempotencyKey: trigger.idempotencyKey,
            envelopeId: trigger.id,
            status: 'processing',
            claimedAt: timestamp,
            updatedAt: timestamp,
        };
        const claimed = await this.store.claimIdempotencyKey(this.key(trigger.idempotencyKey), record);
        if (claimed) return { claimed: true, record };
        const existing = await this.get(trigger.idempotencyKey);
        if (!existing) throw new Error(`Trigger claim disappeared: ${trigger.idempotencyKey}`);
        return { claimed: false, record: existing };
    }

    complete(idempotencyKey: string, runId: string, now: Date = new Date()): Promise<TriggerProcessingRecord> {
        return this.transition(idempotencyKey, current => ({ ...current, status: 'completed', runId, error: undefined, updatedAt: now.toISOString() }));
    }

    fail(idempotencyKey: string, error: AgentError, runId?: string, now: Date = new Date()): Promise<TriggerProcessingRecord> {
        return this.transition(idempotencyKey, current => ({ ...current, status: 'failed', runId, error: { ...error }, updatedAt: now.toISOString() }));
    }

    get(idempotencyKey: string): Promise<TriggerProcessingRecord | null> {
        return this.store.getIdempotencyValue<TriggerProcessingRecord>(this.key(idempotencyKey));
    }

    async recoverInterrupted(now: Date = new Date()): Promise<number> {
        let recovered = 0;
        for (const entry of await this.store.listIdempotencyEntries<TriggerProcessingRecord>(PREFIX)) {
            const current = entry.value;
            if (current.status !== 'processing') continue;
            const next: TriggerProcessingRecord = {
                ...current,
                status: 'failed',
                error: interruptedByRestart(),
                updatedAt: now.toISOString(),
            };
            if (await this.store.compareAndSetIdempotencyKey(entry.key, current, next)) recovered++;
        }
        return recovered;
    }

    private async transition(idempotencyKey: string, update: (current: TriggerProcessingRecord) => TriggerProcessingRecord): Promise<TriggerProcessingRecord> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.get(idempotencyKey);
            if (!current) throw new Error(`Trigger claim not found: ${idempotencyKey}`);
            if (current.status !== 'processing') throw new Error(`Trigger claim is already terminal: ${idempotencyKey}`);
            const next = update(current);
            if (await this.store.compareAndSetIdempotencyKey(this.key(idempotencyKey), current, next)) return next;
        }
        throw new Error(`Trigger claim transition conflicted: ${idempotencyKey}`);
    }

    private key(idempotencyKey: string): string { return `${PREFIX}${encodeURIComponent(idempotencyKey)}`; }
}
