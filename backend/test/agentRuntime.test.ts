import { describe, expect, test } from 'bun:test';
import { AgentRegistry } from '@/platform/agents/registry';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { AgentRuntime } from '@/platform/agents/runtime';
import { BotRegistry } from '@/platform/bots/registry';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import type { AgentManifest } from '@/platform/agents/contracts';

const manifest: AgentManifest = {
    schemaVersion: '1.0', id: 'echo', name: 'Echo', version: '1.0.0', description: 'test',
    runtime: { type: 'native' }, capabilities: ['echo'], triggers: ['message'],
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 1, maxSteps: 3, maxToolCalls: 3, maxAgentCalls: 1, maxOutputBytes: 4096 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
};

function fixture(timeoutSeconds: number = 1) {
    const registry = new AgentRegistry(); registry.register({ ...manifest, limits: { ...manifest.limits, timeoutSeconds } });
    registry.install({ id: 'install-echo', workspaceId: 'workspace-default', agentId: 'echo', version: '1.0.0', status: 'active', config: {}, secretRefs: {} });
    registry.bind({ id: 'binding-echo', botInstanceId: 'bot-default', agentInstallationId: 'install-echo', enabled: true, priority: 1, capabilities: ['echo'], routingConfig: {}, configOverride: {} });
    const bots = new BotRegistry([{ id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'default', appId: 'app', secretRef: 'secret://bot', status: 'active', config: {} }]);
    const runs = new InMemoryAgentRunStore(); const adapter = new NativeAgentAdapter();
    const runtime = new AgentRuntime(registry, bots, runs, [adapter]);
    const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'message', triggerId: 'message-1' });
    const trigger = createTriggerEnvelope({ id: 'trigger-1', occurredAt: new Date().toISOString(), scope, payload: {} });
    return { runtime, adapter, runs, trigger };
}

describe('AgentRuntime', () => {
    test('runs a registered native agent and records run, step, and artifact', async () => {
        const { runtime, adapter, runs, trigger } = fixture();
        adapter.register('echo', '1.0.0', async request => {
            const input = request.input as { text: string };
            return { status: 'succeeded', data: { reply: input.text }, artifacts: [{ type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: input.text }] };
        });
        const outcome = await runtime.execute(trigger, 'echo', { text: 'hello' });
        expect(outcome.run.status).toBe('succeeded'); expect(outcome.artifacts[0]).toMatchObject({ runId: outcome.run.id, type: 'markdown' });
        expect(runs.listSteps(outcome.run.id)[0].status).toBe('succeeded');
    });

    test('rejects invalid input before invoking the agent', async () => {
        const { runtime, adapter, trigger } = fixture(); let invoked = false;
        adapter.register('echo', '1.0.0', async () => { invoked = true; return { status: 'succeeded', data: { reply: 'x' }, artifacts: [] }; });
        const outcome = await runtime.execute(trigger, 'echo', {});
        expect(outcome.run.status).toBe('failed'); expect(outcome.result.error?.code).toBe('INVALID_INPUT'); expect(invoked).toBe(false);
    });

    test('times out an agent that ignores cancellation', async () => {
        const { runtime, adapter, trigger } = fixture(1);
        adapter.register('echo', '1.0.0', async () => new Promise(() => {}));
        const outcome = await runtime.execute(trigger, 'echo', { text: 'slow' });
        expect(outcome.run.status).toBe('failed'); expect(outcome.result.error?.code).toBe('TIMEOUT');
    });

    test('preserves adapter error codes and retryability', async () => {
        const { runtime, adapter, trigger } = fixture();
        adapter.register('echo', '1.0.0', async () => { throw Object.assign(new Error('upstream unavailable'), { code: 'HTTP_503', retryable: true }); });
        const outcome = await runtime.execute(trigger, 'echo', { text: 'hello' });
        expect(outcome.result.error).toMatchObject({ code: 'HTTP_503', retryable: true, message: 'upstream unavailable' });
    });
});
