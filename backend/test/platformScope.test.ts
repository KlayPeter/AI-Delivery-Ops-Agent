import { describe, expect, test } from 'bun:test';
import { BotRegistry } from '@/platform/bots/registry';
import type { BotInstance } from '@/platform/bots/contracts';
import {
    createExecutionScope,
    createTriggerEnvelope,
    createTriggerScope,
    triggerIdempotencyKey,
} from '@/platform/runtime/scope';

function bot(id: string, status: BotInstance['status'] = 'active'): BotInstance {
    return {
        id,
        workspaceId: 'workspace-default',
        platform: 'feishu',
        name: id,
        appId: `app-${id}`,
        secretRef: `secret://${id}`,
        status,
        config: {},
    };
}

describe('platform execution scope', () => {
    test('isolates identical platform event ids by bot instance', () => {
        const eventA = createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-a',
            triggerType: 'message',
            triggerId: 'message-1',
        });
        const eventB = createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-b',
            triggerType: 'message',
            triggerId: 'message-1',
        });

        expect(triggerIdempotencyKey(eventA)).not.toBe(triggerIdempotencyKey(eventB));
        expect(eventA.locale).toBe('zh-CN');
        expect(eventA.timezone).toBe('Asia/Shanghai');
    });

    test('creates an immutable envelope and agent execution scope', () => {
        const triggerScope = createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-a',
            triggerType: 'schedule',
            triggerId: 'daily-ai-hot:2026-07-14T09:00:00+08:00',
            chatId: 'oc_ai_hot',
        });
        const envelope = createTriggerEnvelope({
            id: 'trigger-1',
            occurredAt: '2026-07-14T09:00:00+08:00',
            receivedAt: '2026-07-14T09:00:01+08:00',
            scope: triggerScope,
            payload: { date: '2026-07-14' },
        });
        const execution = createExecutionScope(triggerScope, 'installation-ai-hot', { correlationId: 'trace-1' });

        expect(Object.isFrozen(envelope)).toBe(true);
        expect(Object.isFrozen(envelope.scope)).toBe(true);
        expect(execution).toMatchObject({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-a',
            agentInstallationId: 'installation-ai-hot',
            correlationId: 'trace-1',
        });
    });

    test('rejects missing isolation identifiers', () => {
        expect(() => createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: '',
            triggerType: 'message',
            triggerId: 'message-1',
        })).toThrow('botInstanceId is required');
    });
});

describe('BotRegistry', () => {
    test('returns only active bots for execution and protects stored config', () => {
        const registry = new BotRegistry([bot('bot-a'), bot('bot-b', 'disabled')]);

        const active = registry.requireActive('bot-a');
        (active.config as Record<string, unknown>).changed = true;

        expect(registry.get('bot-a')?.config).toEqual({});
        expect(() => registry.requireActive('bot-b')).toThrow('not active');
        expect(registry.list('workspace-default').map(item => item.id)).toEqual(['bot-a', 'bot-b']);
    });

    test('rejects duplicate bot identities', () => {
        const registry = new BotRegistry([bot('bot-a')]);
        expect(() => registry.register(bot('bot-a'))).toThrow('already registered');
    });
});
