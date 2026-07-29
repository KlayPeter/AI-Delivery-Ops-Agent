import { createHash, randomUUID } from 'node:crypto';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { AgentCheckpoint, AgentConversationMessage, AgentSession, AgentSessionScope, AgentSessionStore } from './contracts';

const SESSION_PREFIX = 'agent:session:';
const CHECKPOINT_PREFIX = 'agent:checkpoint:';

export class PersistentAgentSessionStore implements AgentSessionStore {
    constructor(private readonly store: PersistentKeyValueStore) {}

    async getOrCreate(scope: AgentSessionScope, options: { maxMessages?: number; ttlHours?: number } = {}, now: Date = new Date()): Promise<AgentSession> {
        const id = this.sessionId(scope);
        const existing = await this.get(id, now);
        if (existing) return existing;
        const timestamp = now.toISOString();
        const session: AgentSession = {
            id,
            scope: structuredClone(scope),
            messages: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: new Date(now.getTime() + this.ttlMs(options.ttlHours)).toISOString(),
        };
        await this.store.setIdempotencyKey(this.sessionKey(id), session);
        return structuredClone(session);
    }

    async get(sessionId: string, now: Date = new Date()): Promise<AgentSession | null> {
        const session = await this.store.getIdempotencyValue<AgentSession>(this.sessionKey(sessionId));
        if (!session || session.expiresAt <= now.toISOString()) return null;
        return structuredClone(session);
    }

    async append(
        sessionId: string,
        message: Omit<AgentConversationMessage, 'id' | 'createdAt'>,
        options: { maxMessages?: number; ttlHours?: number } = {},
        now: Date = new Date(),
    ): Promise<AgentSession> {
        const storageKey = this.sessionKey(sessionId);
        for (let attempt = 0; attempt < 5; attempt++) {
            const current = await this.store.getIdempotencyValue<AgentSession>(storageKey);
            if (!current || current.expiresAt <= now.toISOString()) throw new Error(`Agent session not found or expired: ${sessionId}`);
            const nextMessage: AgentConversationMessage = { ...message, id: randomUUID(), createdAt: now.toISOString() };
            const maxMessages = Math.max(2, options.maxMessages || 20);
            const combined = [...current.messages, nextMessage];
            const dropped = combined.slice(0, Math.max(0, combined.length - maxMessages));
            const kept = combined.slice(-maxMessages);
            const droppedText = dropped.map(item => `${item.role}: ${item.content}`).join('\n');
            const summary = [current.summary, droppedText].filter(Boolean).join('\n').slice(-4000) || undefined;
            const next: AgentSession = {
                ...current,
                messages: kept,
                summary,
                updatedAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + this.ttlMs(options.ttlHours)).toISOString(),
            };
            if (await this.store.compareAndSetIdempotencyKey(storageKey, current, next)) return structuredClone(next);
        }
        throw new Error(`Agent session update conflicted: ${sessionId}`);
    }

    async saveCheckpoint(checkpoint: Omit<AgentCheckpoint, 'status' | 'createdAt' | 'updatedAt'>, now: Date = new Date()): Promise<AgentCheckpoint> {
        const timestamp = now.toISOString();
        const existing = await this.getCheckpoint(checkpoint.runId);
        const record: AgentCheckpoint = {
            ...structuredClone(checkpoint),
            status: 'waiting',
            createdAt: existing?.createdAt || timestamp,
            updatedAt: timestamp,
        };
        await this.store.setIdempotencyKey(this.checkpointKey(checkpoint.runId), record);
        return structuredClone(record);
    }

    getCheckpoint(runId: string): Promise<AgentCheckpoint | null> {
        return this.store.getIdempotencyValue<AgentCheckpoint>(this.checkpointKey(runId));
    }

    async completeCheckpoint(runId: string, now: Date = new Date()): Promise<AgentCheckpoint> {
        const storageKey = this.checkpointKey(runId);
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.store.getIdempotencyValue<AgentCheckpoint>(storageKey);
            if (!current) throw new Error(`Agent checkpoint not found: ${runId}`);
            const next: AgentCheckpoint = { ...current, status: 'completed', updatedAt: now.toISOString() };
            if (await this.store.compareAndSetIdempotencyKey(storageKey, current, next)) return structuredClone(next);
        }
        throw new Error(`Agent checkpoint update conflicted: ${runId}`);
    }

    private sessionId(scope: AgentSessionScope): string {
        return createHash('sha256').update([
            scope.workspaceId,
            scope.botInstanceId,
            scope.channel,
            scope.conversationId,
            scope.userId,
        ].join('\n')).digest('hex');
    }

    private ttlMs(ttlHours: number = 24 * 7): number { return Math.max(1, ttlHours) * 60 * 60 * 1000; }
    private sessionKey(id: string): string { return `${SESSION_PREFIX}${id}`; }
    private checkpointKey(runId: string): string { return `${CHECKPOINT_PREFIX}${encodeURIComponent(runId)}`; }
}
