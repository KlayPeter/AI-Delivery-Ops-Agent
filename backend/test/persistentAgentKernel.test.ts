import { describe, expect, test } from 'bun:test';
import type { AgentManifest } from '@/platform/agents/contracts';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { AgentRegistry } from '@/platform/agents/registry';
import { AgentRuntime } from '@/platform/agents/runtime';
import { BotRegistry } from '@/platform/bots/registry';
import { PersistentDeliveryOutbox } from '@/platform/delivery/persistentOutbox';
import { DeliveryWorker } from '@/platform/delivery/worker';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentTriggerClaimStore } from '@/platform/runtime/persistentTriggerStore';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { TriggerRuntime } from '@/platform/runtime/triggerRuntime';
import { PersistentToolCallStore } from '@/platform/tools/callStore';

const manifest: AgentManifest = {
    schemaVersion: '1.0', id: 'restart-safe', name: 'Restart Safe', version: '1.0.0', description: 'test',
    runtime: { type: 'native' }, capabilities: ['digest.generate'], triggers: ['schedule'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 1, maxSteps: 3, maxToolCalls: 3, maxAgentCalls: 1, maxOutputBytes: 4096 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
};

function platform() {
    const registry = new AgentRegistry(); registry.register(manifest);
    registry.install({ id: 'install-restart-safe', workspaceId: 'workspace-default', agentId: manifest.id, version: manifest.version, status: 'active', config: {}, secretRefs: {} });
    registry.bind({ id: 'binding-restart-safe', botInstanceId: 'bot-default', agentInstallationId: 'install-restart-safe', enabled: true, priority: 1, capabilities: ['digest.generate'], routingConfig: {}, configOverride: {} });
    const bots = new BotRegistry([{ id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'default', appId: 'app', secretRef: 'secret://bot', status: 'active', config: {} }]);
    const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'schedule', triggerId: 'digest:restart', chatId: 'oc_digest' });
    const trigger = createTriggerEnvelope({ occurredAt: '2026-07-14T00:00:00Z', scope, payload: {}, replyPolicy: { mode: 'configured_target', targetId: 'oc_digest' } });
    return { registry, bots, trigger };
}

describe('Persistent Agent kernel', () => {
    test('survives store recreation without rerunning the Agent', async () => {
        const database = new InMemoryPersistentKeyValueStore(); const { registry, bots, trigger } = platform();
        const adapter = new NativeAgentAdapter(); let executions = 0;
        adapter.register(manifest.id, manifest.version, async () => {
            executions++;
            return { status: 'succeeded', data: {}, artifacts: [{ type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'durable digest' }] };
        });
        const runsBeforeRestart = new PersistentAgentRunStore(database);
        const runtime = new TriggerRuntime(
            new PersistentTriggerClaimStore(database),
            new AgentRuntime(registry, bots, runsBeforeRestart, [adapter]),
            new PersistentDeliveryOutbox(database),
        );
        const first = await runtime.dispatch(trigger, 'digest.generate', {});
        expect(first.status).toBe('processed'); expect(executions).toBe(1);

        const claimsAfterRestart = new PersistentTriggerClaimStore(database);
        const outboxAfterRestart = new PersistentDeliveryOutbox(database);
        const runsAfterRestart = new PersistentAgentRunStore(database);
        expect((await claimsAfterRestart.claim(trigger)).claimed).toBe(false);
        expect((await runsAfterRestart.get(first.execution!.run.id))?.status).toBe('succeeded');
        expect(await runsAfterRestart.listArtifacts(first.execution!.run.id)).toHaveLength(1);

        let deliveries = 0;
        const worker = new DeliveryWorker(outboxAfterRestart, bots, { deliver: async () => { deliveries++; return { messageId: 'om_restart' }; } });
        expect(await worker.runOnce(new Date('2026-07-14T00:00:01Z'))).toEqual({ delivered: 1, retried: 0, deadLettered: 0 });
        expect(deliveries).toBe(1); expect(executions).toBe(1);
    });

    test('marks interrupted runtime records failed without replaying or closing human checkpoints', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const runs = new PersistentAgentRunStore(database);
        const baseRun = {
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            agentInstallationId: 'install-restart-safe',
            capability: 'digest.generate',
            triggerId: 'restart-recovery',
            correlationId: 'recovery-root',
            rootRunId: 'recovery-root',
            depth: 0,
            createdAt: '2026-07-14T00:00:00Z',
        };
        await runs.create({ ...baseRun, id: 'run-queued', status: 'queued' });
        await runs.create({ ...baseRun, id: 'run-running', status: 'queued' });
        await runs.transition('run-running', 'running', { startedAt: '2026-07-14T00:00:01Z' });
        await runs.create({ ...baseRun, id: 'run-waiting', status: 'queued' });
        await runs.transition('run-waiting', 'running');
        await runs.transition('run-waiting', 'waiting_human');
        await runs.create({ ...baseRun, id: 'run-succeeded', status: 'queued' });
        await runs.transition('run-succeeded', 'running');
        await runs.transition('run-succeeded', 'succeeded', { completedAt: '2026-07-14T00:00:02Z' });
        await runs.saveStep({
            id: 'step-running',
            runId: 'run-running',
            kind: 'agent',
            name: manifest.id,
            status: 'running',
            startedAt: '2026-07-14T00:00:01Z',
        });
        await runs.saveStep({
            id: 'step-succeeded',
            runId: 'run-succeeded',
            kind: 'agent',
            name: manifest.id,
            status: 'succeeded',
            startedAt: '2026-07-14T00:00:01Z',
            completedAt: '2026-07-14T00:00:02Z',
        });

        const toolCalls = new PersistentToolCallStore(database);
        await toolCalls.claim('tool-interrupted', 'task.read', new Date('2026-07-14T00:00:01Z'));
        await toolCalls.claim('tool-succeeded', 'task.read', new Date('2026-07-14T00:00:01Z'));
        await toolCalls.succeed('tool-succeeded', { ok: true }, new Date('2026-07-14T00:00:02Z'));
        const { trigger } = platform();
        const triggers = new PersistentTriggerClaimStore(database);
        await triggers.claim(trigger, new Date('2026-07-14T00:00:01Z'));

        const recoveredAt = new Date('2026-07-14T00:05:00Z');
        expect(await runs.recoverInterrupted(recoveredAt)).toEqual({ runs: 2, steps: 1 });
        expect(await toolCalls.recoverInterrupted(recoveredAt)).toBe(1);
        expect(await triggers.recoverInterrupted(recoveredAt)).toBe(1);

        expect(await runs.get('run-queued')).toMatchObject({ status: 'failed', error: { code: 'PROCESS_RESTARTED', retryable: false } });
        expect(await runs.get('run-running')).toMatchObject({ status: 'failed', completedAt: recoveredAt.toISOString() });
        expect(await runs.get('run-waiting')).toMatchObject({ status: 'waiting_human' });
        expect(await runs.get('run-succeeded')).toMatchObject({ status: 'succeeded' });
        expect((await runs.listSteps('run-running'))[0]).toMatchObject({ status: 'failed', error: { code: 'PROCESS_RESTARTED' } });
        expect((await toolCalls.claim('tool-interrupted', 'task.read')).record).toMatchObject({ status: 'failed', error: { code: 'PROCESS_RESTARTED' } });
        expect((await toolCalls.claim('tool-succeeded', 'task.read')).record).toMatchObject({ status: 'succeeded', output: { ok: true } });
        expect(await triggers.get(trigger.idempotencyKey)).toMatchObject({ status: 'failed', error: { code: 'PROCESS_RESTARTED' } });

        expect(await runs.recoverInterrupted(recoveredAt)).toEqual({ runs: 0, steps: 0 });
        expect(await toolCalls.recoverInterrupted(recoveredAt)).toBe(0);
        expect(await triggers.recoverInterrupted(recoveredAt)).toBe(0);
    });

    test('allows only one worker to claim a durable delivery', async () => {
        const database = new InMemoryPersistentKeyValueStore(); const { bots } = platform();
        const firstOutbox = new PersistentDeliveryOutbox(database); const secondOutbox = new PersistentDeliveryOutbox(database);
        await firstOutbox.enqueue({
            deliveryKey: 'one-delivery',
            artifact: { id: 'artifact-1', runId: 'run-1', type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'once', metadata: {}, createdAt: '2026-07-14T00:00:00Z' },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_digest' },
        });
        let deliveries = 0; const adapter = { deliver: async () => { deliveries++; return {}; } };
        const now = new Date('2026-07-14T00:00:01Z');
        const results = await Promise.all([
            new DeliveryWorker(firstOutbox, bots, adapter).runOnce(now),
            new DeliveryWorker(secondOutbox, bots, adapter).runOnce(now),
        ]);
        expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
        expect(deliveries).toBe(1);
    });

    test('reclaims a delivery after a crashed worker lease expires', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const first = new PersistentDeliveryOutbox(database, 1000); const afterRestart = new PersistentDeliveryOutbox(database, 1000);
        await first.enqueue({
            deliveryKey: 'leased-delivery',
            artifact: { id: 'artifact-lease', runId: 'run-lease', type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'lease', metadata: {}, createdAt: '2026-07-14T00:00:00Z' },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_digest' },
        });
        const start = new Date('2026-07-14T00:00:00Z');
        expect(await first.claimDue(start)).toHaveLength(1);
        expect(await afterRestart.claimDue(new Date(start.getTime() + 999))).toHaveLength(0);
        const reclaimed = await afterRestart.claimDue(new Date(start.getTime() + 1000));
        expect(reclaimed).toHaveLength(1); expect(reclaimed[0].attempts).toBe(2);
    });
});
