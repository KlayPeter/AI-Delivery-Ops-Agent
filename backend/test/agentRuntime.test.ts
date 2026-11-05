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

    test('honors the recorded absolute deadline when saving the running step takes time', async () => {
        const { runtime, adapter, trigger, runs } = fixture(1);
        const saveStep = runs.saveStep.bind(runs);
        runs.saveStep = async step => {
            if (step.status === 'running') await Bun.sleep(100);
            saveStep(step);
        };
        adapter.register('echo', '1.0.0', async request => {
            await Bun.sleep(Math.max(0, new Date(request.deadlineAt).getTime() - Date.now() + 10));
            return { status: 'succeeded', data: { reply: 'late' }, artifacts: [{ type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'late output' }] };
        });
        const outcome = await runtime.execute(trigger, 'echo', { text: 'slow recording' });
        expect(outcome.run.status).toBe('failed');
        expect(outcome.run.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
        expect(runs.listArtifacts(outcome.run.id)).toEqual([]);
        expect(runs.listSteps(outcome.run.id)[0]?.status).toBe('failed');
    });

    test('preserves adapter error codes and retryability', async () => {
        const { runtime, adapter, trigger, runs } = fixture();
        adapter.register('echo', '1.0.0', async () => { throw Object.assign(new Error('upstream unavailable'), { code: 'HTTP_503', retryable: true }); });
        const outcome = await runtime.execute(trigger, 'echo', { text: 'hello' });
        expect(outcome.result.error).toMatchObject({ code: 'HTTP_503', retryable: true, message: 'upstream unavailable' });
        expect(runs.listSteps(outcome.run.id)[0].metadata?.execution).toMatchObject({ agentId: 'echo', agentVersion: '1.0.0' });
    });

    test('retains execution snapshots for each human continuation without storing raw inputs or losing metrics', async () => {
        const { runtime, adapter, runs, trigger } = fixture();
        let calls = 0;
        adapter.register('echo', '1.0.0', async request => {
            const running = runs.listSteps(request.runId).find(step => step.status === 'running');
            expect(running?.metadata?.execution).toMatchObject({ agentId: 'echo', agentVersion: '1.0.0' });
            return { status: ++calls === 1 ? 'needs_human' : 'succeeded', data: { reply: 'ok' }, artifacts: [], metrics: { modelCalls: 0, toolCalls: 0 } };
        });
        const first = await runtime.execute(trigger, 'echo', { text: 'private-original' });
        expect(first.run.status).toBe('waiting_human');
        const original = runs.listSteps(first.run.id)[0];
        expect((await runtime.resume(trigger, first.run.id, { text: 'private-continuation' })).run.status).toBe('succeeded');
        const steps = runs.listSteps(first.run.id);
        expect(steps).toHaveLength(2); expect(steps[0]).toEqual(original);
        const executions = steps.map(step => step.metadata!.execution as any);
        expect(executions[0].inputHash).not.toBe(executions[1].inputHash);
        expect(executions[0].manifestHash).toBe(executions[1].manifestHash);
        expect(JSON.stringify(steps)).not.toContain('private-original'); expect(JSON.stringify(steps)).not.toContain('private-continuation');
        expect(steps[1].metadata).toMatchObject({ modelCalls: 0, toolCalls: 0 });
    });

    test('execution provenance cannot break an otherwise valid SDK call with an unserializable input', async () => {
        const { runtime, adapter, runs, trigger } = fixture();
        adapter.register('echo', '1.0.0', async () => ({ status: 'succeeded', data: { reply: 'ok' }, artifacts: [] }));
        const input: any = { text: 'safe' }; input.self = input;
        const result = await runtime.execute(trigger, 'echo', input);
        expect(result.run.status).toBe('succeeded');
        expect((runs.listSteps(result.run.id)[0].metadata!.execution as any).inputHash).toBeUndefined();
    });
});
