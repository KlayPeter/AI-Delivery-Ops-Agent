import { createHash } from 'node:crypto';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { DeliveryError, DeliveryOutbox, DeliveryRecord, DeliveryTarget } from './contracts';
import type { Artifact } from '@/platform/agents/contracts';

const PREFIX = 'agent:delivery:';

export class PersistentDeliveryOutbox implements DeliveryOutbox {
    constructor(private readonly store: PersistentKeyValueStore, private readonly leaseMs: number = 30_000) {}

    async enqueue(input: { deliveryKey: string; artifact: Artifact; target: DeliveryTarget; maxAttempts?: number }, now: Date = new Date()): Promise<DeliveryRecord> {
        const id = createHash('sha256').update(input.deliveryKey).digest('hex');
        const timestamp = now.toISOString();
        const record: DeliveryRecord = {
            id, deliveryKey: input.deliveryKey, artifact: { ...input.artifact }, target: { ...input.target },
            status: 'pending', attempts: 0, maxAttempts: Math.max(1, input.maxAttempts || 3), createdAt: timestamp, updatedAt: timestamp,
        };
        if (await this.store.claimIdempotencyKey(this.key(id), record)) return record;
        const existing = await this.get(id);
        if (!existing) throw new Error(`Delivery record disappeared: ${id}`);
        return existing;
    }

    async claimDue(now: Date = new Date(), limit: number = 20): Promise<DeliveryRecord[]> {
        const records = (await this.store.listIdempotencyEntries<DeliveryRecord>(PREFIX))
            .map(entry => entry.value)
            .filter(record => (((record.status === 'pending' || record.status === 'retry_wait') && (!record.nextAttemptAt || record.nextAttemptAt <= now.toISOString())) ||
                (record.status === 'sending' && !!record.leaseUntil && record.leaseUntil <= now.toISOString())))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .slice(0, Math.max(1, limit));
        const claimed: DeliveryRecord[] = [];
        for (const current of records) {
            const next: DeliveryRecord = { ...current, status: 'sending', attempts: current.attempts + 1, updatedAt: now.toISOString(), nextAttemptAt: undefined, leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString() };
            if (await this.store.compareAndSetIdempotencyKey(this.key(current.id), current, next)) claimed.push(next);
        }
        return claimed;
    }

    markDelivered(id: string, receipt: Readonly<Record<string, unknown>>, now: Date = new Date()): Promise<DeliveryRecord> {
        return this.transition(id, current => ({ ...current, status: 'delivered', receipt: { ...receipt }, error: undefined, updatedAt: now.toISOString(), leaseUntil: undefined }));
    }

    markFailed(id: string, error: DeliveryError, nextAttemptAt: Date, now: Date = new Date()): Promise<DeliveryRecord> {
        return this.transition(id, current => {
            const retry = error.retryable && current.attempts < current.maxAttempts;
            return { ...current, status: retry ? 'retry_wait' : 'dead_letter', error: { ...error }, updatedAt: now.toISOString(), nextAttemptAt: retry ? nextAttemptAt.toISOString() : undefined, leaseUntil: undefined };
        });
    }

    get(id: string): Promise<DeliveryRecord | null> {
        return this.store.getIdempotencyValue<DeliveryRecord>(this.key(id));
    }

    private async transition(id: string, update: (current: DeliveryRecord) => DeliveryRecord): Promise<DeliveryRecord> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.get(id);
            if (!current) throw new Error(`Delivery not found: ${id}`);
            if (current.status !== 'sending') throw new Error(`Delivery is not sending: ${id}`);
            const next = update(current);
            if (await this.store.compareAndSetIdempotencyKey(this.key(id), current, next)) return next;
        }
        throw new Error(`Delivery transition conflicted: ${id}`);
    }

    private key(id: string): string { return `${PREFIX}${id}`; }
}
