import { describe, expect, test } from 'bun:test';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentSessionStore } from '@/platform/session/persistentStore';

const scope = {
    workspaceId: 'workspace-default',
    botInstanceId: 'bot-default',
    channel: 'private' as const,
    conversationId: 'ou_user',
    userId: 'ou_user',
};

describe('Persistent Agent session', () => {
    test('keeps bounded messages, summarizes dropped context, and expires by TTL', async () => {
        const store = new PersistentAgentSessionStore(new InMemoryPersistentKeyValueStore());
        const start = new Date('2026-07-17T00:00:00Z');
        const session = await store.getOrCreate(scope, { maxMessages: 2, ttlHours: 1 }, start);
        await store.append(session.id, { role: 'user', content: 'first' }, { maxMessages: 2, ttlHours: 1 }, start);
        await store.append(session.id, { role: 'assistant', content: 'second' }, { maxMessages: 2, ttlHours: 1 }, start);
        const updated = await store.append(session.id, { role: 'user', content: 'third' }, { maxMessages: 2, ttlHours: 1 }, start);
        expect(updated.messages.map(message => message.content)).toEqual(['second', 'third']);
        expect(updated.summary).toContain('user: first');
        expect(await store.get(session.id, new Date('2026-07-17T00:59:59Z'))).not.toBeNull();
        expect(await store.get(session.id, new Date('2026-07-17T01:00:00Z'))).toBeNull();
    });

    test('persists and completes a human-input checkpoint', async () => {
        const store = new PersistentAgentSessionStore(new InMemoryPersistentKeyValueStore());
        const session = await store.getOrCreate(scope);
        await store.saveCheckpoint({ runId: 'run-1', sessionId: session.id, agentId: 'task-agent', question: 'Who owns it?', fields: ['owner'] });
        expect(await store.getCheckpoint('run-1')).toMatchObject({ status: 'waiting', question: 'Who owns it?' });
        expect(await store.completeCheckpoint('run-1')).toMatchObject({ status: 'completed' });
    });
});
