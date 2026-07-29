import { describe, expect, test } from 'bun:test';
import type { AgentManifest } from '@/platform/agents/contracts';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { AgentRegistry } from '@/platform/agents/registry';
import { AgentRuntime } from '@/platform/agents/runtime';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { BotRegistry } from '@/platform/bots/registry';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';

const manifest = (id: string, capability: string, delegates: string[] = []): AgentManifest => ({
    schemaVersion: '1.1',
    id,
    name: id,
    version: '1.0.0',
    description: `${id} description`,
    runtime: { type: 'native' },
    capabilities: [capability],
    triggers: ['manual', 'agent'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 5, maxSteps: 5, maxToolCalls: 0, maxAgentCalls: 2, maxDepth: 2, maxOutputBytes: 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
    delegates,
});

function trigger(trustedContext?: Record<string, unknown>) {
    return createTriggerEnvelope({
        occurredAt: new Date().toISOString(),
        scope: createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            triggerType: 'manual',
            triggerId: 'manual-delegation-test',
            chatId: 'oc_group',
            actorId: 'ou_user',
        }),
        payload: {},
        trustedContext,
        replyPolicy: { mode: 'none' },
    });
}

describe('Agent-to-Agent delegation', () => {
    test('creates a bounded child Run with parent, root and correlation traceability', async () => {
        const parentManifest = manifest('main-agent', 'main.run', ['child.run']);
        const childManifest = manifest('child-agent', 'child.run');
        const registry = new AgentRegistry();
        for (const [definition, installationId] of [[parentManifest, 'install-main'], [childManifest, 'install-child']] as const) {
            registry.register(definition);
            registry.install({ id: installationId, workspaceId: 'workspace-default', agentId: definition.id, version: definition.version, status: 'active', config: {}, secretRefs: {} });
            registry.bind({ id: `bind-${installationId}`, botInstanceId: 'bot-default', agentInstallationId: installationId, enabled: true, priority: 1, capabilities: definition.capabilities, routingConfig: {}, configOverride: {} });
        }
        const runs = new InMemoryAgentRunStore();
        const adapter = new NativeAgentAdapter();
        const runtime = new AgentRuntime(registry, new BotRegistry([{
            id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'bot', appId: 'app', secretRef: 'config://secret', status: 'active', config: {},
        }]), runs, [adapter]);

        let trustedActor = '';
        adapter.register(childManifest.id, childManifest.version, async request => {
            trustedActor = String(request.trustedContext?.actor || '');
            return {
            status: 'succeeded',
            data: { childRunId: request.runId, value: (request.input as any).value, trustedActor: request.trustedContext?.actor },
            artifacts: [],
            };
        });
        adapter.register(parentManifest.id, parentManifest.version, async (request, resolved, signal) => {
            const child = await runtime.delegate(request, resolved.manifest, 'child.run', { value: 42 }, signal);
            return { status: 'succeeded', data: { childRunId: child.run.id }, artifacts: [] };
        });

        const outcome = await runtime.execute(trigger({ actor: 'ou_real' }), 'main.run', {});
        expect(outcome.run.status).toBe('succeeded');
        const childRunId = (outcome.result.data as any).childRunId;
        const child = await runs.get(childRunId);
        expect(child).toMatchObject({
            parentRunId: outcome.run.id,
            rootRunId: outcome.run.id,
            correlationId: outcome.run.correlationId,
            depth: 1,
            capability: 'child.run',
            status: 'succeeded',
        });
        expect((await runs.listSteps(outcome.run.id)).some(step => step.name === 'delegate:child.run' && step.metadata?.childRunId === childRunId)).toBe(true);
        expect(trustedActor).toBe('ou_real');
    });

    test('rejects capabilities outside the parent manifest allowlist', async () => {
        const parentManifest = manifest('main-agent', 'main.run');
        const registry = new AgentRegistry();
        registry.register(parentManifest);
        registry.install({ id: 'install-main', workspaceId: 'workspace-default', agentId: parentManifest.id, version: parentManifest.version, status: 'active', config: {}, secretRefs: {} });
        registry.bind({ id: 'bind-main', botInstanceId: 'bot-default', agentInstallationId: 'install-main', enabled: true, priority: 1, capabilities: parentManifest.capabilities, routingConfig: {}, configOverride: {} });
        const runs = new InMemoryAgentRunStore();
        const adapter = new NativeAgentAdapter();
        const runtime = new AgentRuntime(registry, new BotRegistry([{
            id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'bot', appId: 'app', secretRef: 'config://secret', status: 'active', config: {},
        }]), runs, [adapter]);
        adapter.register(parentManifest.id, parentManifest.version, (request, resolved, signal) =>
            runtime.delegate(request, resolved.manifest, 'undeclared.run', {}, signal) as any
        );

        const outcome = await runtime.execute(trigger(), 'main.run', {});
        expect(outcome.run.status).toBe('failed');
        expect(outcome.run.error?.code).toBe('AGENT_DELEGATION_NOT_ALLOWED');
    });

    test('resumes the same waiting child Run instead of creating a duplicate child', async () => {
        const parentManifest = manifest('main-agent', 'main.run', ['child.run']);
        const childManifest = manifest('child-agent', 'child.run');
        const registry = new AgentRegistry();
        for (const [definition, installationId] of [[parentManifest, 'install-main'], [childManifest, 'install-child']] as const) {
            registry.register(definition);
            registry.install({ id: installationId, workspaceId: 'workspace-default', agentId: definition.id, version: definition.version, status: 'active', config: {}, secretRefs: {} });
            registry.bind({ id: `bind-${installationId}`, botInstanceId: 'bot-default', agentInstallationId: installationId, enabled: true, priority: 1, capabilities: definition.capabilities, routingConfig: {}, configOverride: {} });
        }
        const runs = new InMemoryAgentRunStore();
        const adapter = new NativeAgentAdapter();
        const runtime = new AgentRuntime(registry, new BotRegistry([{
            id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'bot', appId: 'app', secretRef: 'config://secret', status: 'active', config: {},
        }]), runs, [adapter]);
        adapter.register(childManifest.id, childManifest.version, async request => {
            const prompt = String((request.input as any).prompt || '');
            return prompt === 'answer'
                ? { status: 'succeeded', data: { text: 'done' }, artifacts: [] }
                : { status: 'needs_human', data: { text: 'need answer' }, artifacts: [] };
        });
        adapter.register(parentManifest.id, parentManifest.version, async (request, resolved, signal) => {
            const waiting = await runtime.delegate(request, resolved.manifest, 'child.run', { prompt: 'start' }, signal);
            const resumed = await runtime.delegate(request, resolved.manifest, 'child.run', { resumeRunId: waiting.run.id, prompt: 'answer' }, signal);
            return { status: 'succeeded', data: { first: waiting.run.id, second: resumed.run.id, childStatus: resumed.run.status }, artifacts: [] };
        });

        const outcome = await runtime.execute(trigger(), 'main.run', {});
        const data = outcome.result.data as any;
        expect(typeof data.first).toBe('string');
        expect(data.childStatus).toBe('succeeded');
        expect(data.second).toBe(data.first);
        expect((await runs.get(data.first))?.status).toBe('succeeded');
    });
});
