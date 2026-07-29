import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { AgentError } from '@/platform/agents/contracts';
import { interruptedByRestart } from '@/platform/runtime/interruption';
import type { ToolCallClaim, ToolCallRecord, ToolCallStore } from './contracts';

const PREFIX = 'agent:tool-call:';

export class InMemoryToolCallStore implements ToolCallStore {
    private readonly records = new Map<string, ToolCallRecord>();

    async claim(key: string, toolId: string, now: Date = new Date()): Promise<ToolCallClaim> {
        const existing = this.records.get(key);
        if (existing) return { claimed: false, record: structuredClone(existing) };
        const record: ToolCallRecord = { key, toolId, status: 'running', createdAt: now.toISOString(), updatedAt: now.toISOString() };
        this.records.set(key, record);
        return { claimed: true, record: structuredClone(record) };
    }

    async succeed(key: string, output: unknown, now: Date = new Date()): Promise<ToolCallRecord> {
        return this.transition(key, current => ({ ...current, status: 'succeeded', output: structuredClone(output), updatedAt: now.toISOString() }));
    }

    async fail(key: string, error: AgentError, now: Date = new Date()): Promise<ToolCallRecord> {
        return this.transition(key, current => ({ ...current, status: 'failed', error: { ...error }, updatedAt: now.toISOString() }));
    }

    private async transition(key: string, update: (current: ToolCallRecord) => ToolCallRecord): Promise<ToolCallRecord> {
        const current = this.records.get(key);
        if (!current || current.status !== 'running') throw new Error(`Tool call is not running: ${key}`);
        const next = update(current);
        this.records.set(key, next);
        return structuredClone(next);
    }
}

export class PersistentToolCallStore implements ToolCallStore {
    constructor(private readonly store: PersistentKeyValueStore) {}

    async claim(key: string, toolId: string, now: Date = new Date()): Promise<ToolCallClaim> {
        const record: ToolCallRecord = { key, toolId, status: 'running', createdAt: now.toISOString(), updatedAt: now.toISOString() };
        const storageKey = this.key(key);
        if (await this.store.claimIdempotencyKey(storageKey, record)) return { claimed: true, record };
        const existing = await this.store.getIdempotencyValue<ToolCallRecord>(storageKey);
        if (!existing) throw new Error(`Tool call record disappeared: ${key}`);
        return { claimed: false, record: existing };
    }

    succeed(key: string, output: unknown, now: Date = new Date()): Promise<ToolCallRecord> {
        return this.transition(key, current => ({ ...current, status: 'succeeded', output, updatedAt: now.toISOString() }));
    }

    fail(key: string, error: AgentError, now: Date = new Date()): Promise<ToolCallRecord> {
        return this.transition(key, current => ({ ...current, status: 'failed', error, updatedAt: now.toISOString() }));
    }

    async recoverInterrupted(now: Date = new Date()): Promise<number> {
        let recovered = 0;
        for (const entry of await this.store.listIdempotencyEntries<ToolCallRecord>(PREFIX)) {
            const current = entry.value;
            if (current.status !== 'running') continue;
            const next: ToolCallRecord = {
                ...current,
                status: 'failed',
                error: interruptedByRestart(),
                updatedAt: now.toISOString(),
            };
            if (await this.store.compareAndSetIdempotencyKey(entry.key, current, next)) recovered++;
        }
        return recovered;
    }

    private async transition(key: string, update: (current: ToolCallRecord) => ToolCallRecord): Promise<ToolCallRecord> {
        const storageKey = this.key(key);
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.store.getIdempotencyValue<ToolCallRecord>(storageKey);
            if (!current || current.status !== 'running') throw new Error(`Tool call is not running: ${key}`);
            const next = update(current);
            if (await this.store.compareAndSetIdempotencyKey(storageKey, current, next)) return structuredClone(next);
        }
        throw new Error(`Tool call transition conflicted: ${key}`);
    }

    private key(key: string): string { return `${PREFIX}${encodeURIComponent(key)}`; }
}
