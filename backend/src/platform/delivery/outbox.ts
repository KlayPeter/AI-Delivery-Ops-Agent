import { randomUUID } from 'node:crypto';
import type { Artifact } from '@/platform/agents/contracts';
import type { DeliveryError, DeliveryOutbox, DeliveryRecord, DeliveryTarget } from './contracts';

export class InMemoryDeliveryOutbox implements DeliveryOutbox {
    private readonly records = new Map<string, DeliveryRecord>();
    private readonly idsByKey = new Map<string, string>();
    constructor(private readonly leaseMs: number = 30_000) {}

    enqueue(input: { deliveryKey: string; artifact: Artifact; target: DeliveryTarget; maxAttempts?: number }, now: Date = new Date()): DeliveryRecord {
        const existingId = this.idsByKey.get(input.deliveryKey);
        if (existingId) return this.get(existingId)!;
        const timestamp = now.toISOString();
        const record: DeliveryRecord = {
            id: randomUUID(), deliveryKey: input.deliveryKey, artifact: input.artifact, target: { ...input.target },
            status: 'pending', attempts: 0, maxAttempts: Math.max(1, input.maxAttempts || 3), createdAt: timestamp, updatedAt: timestamp,
        };
        this.records.set(record.id, record); this.idsByKey.set(record.deliveryKey, record.id); return this.get(record.id)!;
    }

    claimDue(now: Date = new Date(), limit: number = 20): DeliveryRecord[] {
        const due = Array.from(this.records.values()).filter(record =>
            (((record.status === 'pending' || record.status === 'retry_wait') && (!record.nextAttemptAt || record.nextAttemptAt <= now.toISOString())) ||
            (record.status === 'sending' && !!record.leaseUntil && record.leaseUntil <= now.toISOString()))
        ).slice(0, Math.max(1, limit));
        return due.map(record => {
            const next: DeliveryRecord = { ...record, status: 'sending', attempts: record.attempts + 1, updatedAt: now.toISOString(), nextAttemptAt: undefined, leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString() };
            this.records.set(record.id, next); return this.get(record.id)!;
        });
    }

    markDelivered(id: string, receipt: Readonly<Record<string, unknown>>, now: Date = new Date()): DeliveryRecord {
        const current = this.requireSending(id);
        const next: DeliveryRecord = { ...current, status: 'delivered', receipt: { ...receipt }, error: undefined, updatedAt: now.toISOString(), leaseUntil: undefined };
        this.records.set(id, next); return this.get(id)!;
    }

    markFailed(id: string, error: DeliveryError, nextAttemptAt: Date, now: Date = new Date()): DeliveryRecord {
        const current = this.requireSending(id);
        const retry = error.retryable && current.attempts < current.maxAttempts;
        const next: DeliveryRecord = { ...current, status: retry ? 'retry_wait' : 'dead_letter', error, updatedAt: now.toISOString(), nextAttemptAt: retry ? nextAttemptAt.toISOString() : undefined, leaseUntil: undefined };
        this.records.set(id, next); return this.get(id)!;
    }

    get(id: string): DeliveryRecord | null { const record = this.records.get(id); return record ? { ...record, artifact: { ...record.artifact }, target: { ...record.target } } : null; }
    list(): DeliveryRecord[] { return Array.from(this.records.keys()).map(id => this.get(id)!); }
    private requireSending(id: string): DeliveryRecord { const record = this.records.get(id); if (!record) throw new Error(`Delivery not found: ${id}`); if (record.status !== 'sending') throw new Error(`Delivery is not sending: ${id}`); return record; }
}
