import { describe, expect, test } from 'bun:test';
import type { AgentManifest } from '@/platform/agents/contracts';
import { AgentRegistry } from '@/platform/agents/registry';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { AgentRuntime } from '@/platform/agents/runtime';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { BotRegistry } from '@/platform/bots/registry';
import { InMemoryDeliveryOutbox } from '@/platform/delivery/outbox';
import { DeliveryWorker } from '@/platform/delivery/worker';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { TriggerRuntime } from '@/platform/runtime/triggerRuntime';
import { InMemoryTriggerClaimStore } from '@/platform/runtime/triggerStore';

const manifest: AgentManifest = {
    schemaVersion: '1.0', id: 'digest', name: 'Digest', version: '1.0.0', description: 'test',
    runtime: { type: 'native' }, capabilities: ['digest.generate'], triggers: ['schedule'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 1, maxSteps: 3, maxToolCalls: 3, maxAgentCalls: 1, maxOutputBytes: 4096 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
};

function fixture() {
    const registry = new AgentRegistry(); registry.register(manifest);
    registry.install({ id: 'install-digest', workspaceId: 'workspace-default', agentId: 'digest', version: '1.0.0', status: 'active', config: {}, secretRefs: {} });
    registry.bind({ id: 'binding-digest', botInstanceId: 'bot-default', agentInstallationId: 'install-digest', enabled: true, priority: 1, capabilities: ['digest.generate'], routingConfig: {}, configOverride: {} });
    const bots = new BotRegistry([{ id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'default', appId: 'app', secretRef: 'secret://bot', status: 'active', config: {} }]);
    const adapter = new NativeAgentAdapter(); const runs = new InMemoryAgentRunStore();
    const agents = new AgentRuntime(registry, bots, runs, [adapter]);
    const outbox = new InMemoryDeliveryOutbox(); const claims = new InMemoryTriggerClaimStore();
    const runtime = new TriggerRuntime(claims, agents, outbox);
    const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'schedule', triggerId: 'digest:2026-07-14', chatId: 'oc_digest' });
    const trigger = createTriggerEnvelope({ id: 'trigger-digest', occurredAt: '2026-07-14T00:00:00Z', scope, payload: {}, replyPolicy: { mode: 'configured_target', targetId: 'oc_digest' } });
    return { adapter, bots, runs, outbox, claims, runtime, trigger };
}

describe('Trigger Runtime', () => {
    test('claims a duplicate trigger atomically and executes the Agent once', async () => {
        const { adapter, runs, outbox, runtime, trigger } = fixture(); let executions = 0;
        adapter.register('digest', '1.0.0', async () => {
            executions++;
            await Promise.resolve();
            return { status: 'succeeded', data: {}, artifacts: [{ type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'daily digest' }] };
        });
        const [first, duplicate] = await Promise.all([
            runtime.dispatch(trigger, 'digest.generate', {}),
            runtime.dispatch(trigger, 'digest.generate', {}),
        ]);
        expect([first.status, duplicate.status].sort()).toEqual(['duplicate', 'processed']);
        const processed = first.status === 'processed' ? first : duplicate;
        expect(executions).toBe(1); expect(runs.get(processed.execution!.run.id)?.status).toBe('succeeded'); expect(outbox.list()).toHaveLength(1);
    });

    test('retries delivery without rerunning a successful Agent', async () => {
        const { adapter, bots, outbox, runtime, trigger } = fixture(); let executions = 0; let deliveries = 0;
        adapter.register('digest', '1.0.0', async () => {
            executions++;
            return { status: 'succeeded', data: {}, artifacts: [{ type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'daily digest' }] };
        });
        expect((await runtime.dispatch(trigger, 'digest.generate', {})).status).toBe('processed');
        const worker = new DeliveryWorker(outbox, bots, { deliver: async () => {
            deliveries++;
            if (deliveries === 1) throw Object.assign(new Error('temporary'), { retryable: true });
            return { messageId: 'om_digest' };
        } }, 10);
        const start = new Date('2026-07-14T00:00:00Z');
        expect((await worker.runOnce(start)).retried).toBe(1);
        expect((await worker.runOnce(new Date(start.getTime() + 10))).delivered).toBe(1);
        expect(executions).toBe(1); expect(deliveries).toBe(2);
    });

    test('does not let Agent output override the configured bot delivery target', async () => {
        const { adapter, outbox, runtime, trigger } = fixture();
        adapter.register('digest', '1.0.0', async () => ({ status: 'succeeded', data: {}, artifacts: [{
            type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'daily digest',
            metadata: { botInstanceId: 'attacker-bot', targetId: 'attacker-target' },
        }] }));
        await runtime.dispatch(trigger, 'digest.generate', {});
        expect(outbox.list()[0]?.target).toEqual({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_digest' });
    });

    test('preserves an explicitly configured private target', async () => {
        const { adapter, outbox, runtime, trigger } = fixture();
        adapter.register('digest', '1.0.0', async () => ({
            status: 'succeeded',
            data: {},
            artifacts: [{ type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'private digest' }],
        }));
        const privateTrigger = {
            ...trigger,
            replyPolicy: { mode: 'configured_target' as const, channel: 'private' as const, targetId: 'ou_user' },
        };

        await runtime.dispatch(privateTrigger, 'digest.generate', {});

        expect(outbox.list()[0]?.target).toEqual({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            channel: 'private',
            targetId: 'ou_user',
        });
    });

    test('rejects trigger types not declared by the Agent', async () => {
        const { adapter, outbox, runtime, trigger } = fixture(); let executions = 0;
        adapter.register('digest', '1.0.0', async () => { executions++; return { status: 'succeeded', data: {}, artifacts: [] }; });
        const messageTrigger = { ...trigger, type: 'message' as const };
        const result = await runtime.dispatch(messageTrigger, 'digest.generate', {});
        expect(result.status).toBe('failed'); expect(result.claim.error?.code).toBe('TRIGGER_NOT_ALLOWED');
        expect(executions).toBe(0); expect(outbox.list()).toHaveLength(0);
    });
});
