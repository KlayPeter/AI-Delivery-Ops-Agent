import { describe, expect, test } from 'bun:test';
import { AgentRegistry } from '@/platform/agents/registry';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import type { AgentRunStore } from '@/platform/agents/runStore';
import { NativeAgentAdapter, type NativeAgentHandler } from '@/platform/agents/nativeAdapter';
import { AgentRuntime } from '@/platform/agents/runtime';
import { BotRegistry } from '@/platform/bots/registry';
import { InMemoryDeliveryOutbox } from '@/platform/delivery/outbox';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentTriggerClaimStore } from '@/platform/runtime/persistentTriggerStore';
import { TriggerRuntime } from '@/platform/runtime/triggerRuntime';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import type { AgentManifest, AgentRun, AgentResult } from '@/platform/agents/contracts';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const ok: AgentResult = { status: 'succeeded', data: {}, artifacts: [] };
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
const manifest: AgentManifest = {
    schemaVersion: '1.0', id: 'controlled', name: 'Controlled', version: '1.0.0', description: 'test',
    runtime: { type: 'native' }, capabilities: ['controlled'], triggers: ['manual', 'agent'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 5, maxSteps: 10, maxToolCalls: 3, maxAgentCalls: 2, maxOutputBytes: 4096 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false }, delegates: ['controlled'],
};
function fixture(handler: NativeAgentHandler) {
    const registry = new AgentRegistry(); registry.register(manifest);
    registry.install({ id: 'install-controlled', workspaceId: scope.workspaceId, agentId: manifest.id, version: '1.0.0', status: 'active', config: {}, secretRefs: {} });
    registry.bind({ id: 'binding-controlled', botInstanceId: scope.botInstanceId, agentInstallationId: 'install-controlled', enabled: true, priority: 1, capabilities: ['controlled'], routingConfig: {}, configOverride: {} });
    const bots = new BotRegistry([{ id: scope.botInstanceId, workspaceId: scope.workspaceId, platform: 'feishu', name: 'default', appId: 'app', secretRef: 'secret://bot', status: 'active', config: {} }]);
    const runs = new InMemoryAgentRunStore(), adapter = new NativeAgentAdapter(); adapter.register(manifest.id, manifest.version, handler);
    const agents = new AgentRuntime(registry, bots, runs, [adapter]);
    const database = new InMemoryPersistentKeyValueStore(), claims = new PersistentTriggerClaimStore(database), outbox = new InMemoryDeliveryOutbox();
    const runtime = new TriggerRuntime(claims, agents, outbox);
    const trigger = (id: string) => createTriggerEnvelope({ occurredAt: new Date().toISOString(), scope: createTriggerScope({ ...scope, triggerType: 'manual', triggerId: id }), payload: {}, replyPolicy: { mode: 'configured_target', targetId: 'no-cancelled-delivery' } });
    return { agents, runs, claims, database, outbox, runtime, trigger };
}

describe('local run control', () => {
    test('acknowledges a durable run before completion and retries the same request without executing twice', async () => {
        const finish = deferred(), entered = deferred(); let calls = 0;
        const f = fixture(async request => {
            calls++; expect((await f.claims.get(t.idempotencyKey))?.runId).toBe(request.runId);
            entered.resolve(); await finish.promise; return ok;
        });
        const t = f.trigger('one');
        const [first, second] = await Promise.all([f.runtime.start(t, 'controlled', { text: 'same' }), f.runtime.start(t, 'controlled', { text: 'same' })]);
        await entered.promise;
        expect(first.runId).toBe(second.runId); expect(first.status).toBe('running'); expect(calls).toBe(1);
        expect((await f.runtime.start(t, 'controlled', { text: 'same' })).runId).toBe(first.runId);
        await expect(f.runtime.start(t, 'controlled', { text: 'different' })).rejects.toMatchObject({ code: 'TRIGGER_INPUT_CHANGED' });
        finish.resolve(); expect((await first.completion)?.execution?.run.status).toBe('succeeded');
        const restarted = new TriggerRuntime(new PersistentTriggerClaimStore(f.database), f.agents, f.outbox);
        expect(await restarted.start(t, 'controlled', { text: 'same' })).toEqual({ runId: first.runId, status: 'succeeded' });
        expect(calls).toBe(1);
    });

    test('does not invoke the adapter when durable run association fails', async () => {
        let calls = 0; const f = fixture(async () => { calls++; return ok; });
        f.claims.linkRun = async () => { throw new Error('association unavailable'); };
        const t = f.trigger('link-failure'), start = await f.runtime.start(t, 'controlled', {});
        expect(start.status).toBe('failed'); expect(calls).toBe(0);
        expect((await f.claims.get(t.idempotencyKey))?.runId).toBe(start.runId);
        expect((await f.runtime.start(t, 'controlled', {})).runId).toBe(start.runId);
    });

    test('preserves the run association and request hash when recovering an interrupted claim', async () => {
        const f = fixture(async () => ok), t = f.trigger('restart');
        await f.claims.claim(t, undefined, 'request-hash'); await f.claims.linkRun(t.idempotencyKey, 'durable-run');
        expect(await new PersistentTriggerClaimStore(f.database).recoverInterrupted()).toBe(1);
        expect(await f.claims.get(t.idempotencyKey)).toMatchObject({ status: 'failed', runId: 'durable-run', requestHash: 'request-hash', error: { code: 'PROCESS_RESTARTED' } });
    });

    test('limits new asynchronous starts to four active manual roots, accepts retries and frees finished slots', async () => {
        const finish = deferred(); const f = fixture(async () => { await finish.promise; return ok; });
        const starts = await Promise.all([0, 1, 2, 3].map(i => f.runtime.start(f.trigger(`capacity-${i}`), 'controlled', {})));
        await expect(f.runtime.start(f.trigger('overflow'), 'controlled', {})).rejects.toMatchObject({ code: 'RUN_CAPACITY' });
        expect((await f.runtime.start(f.trigger('capacity-0'), 'controlled', {})).runId).toBe(starts[0].runId);
        await f.agents.cancel(starts[0].runId, scope); await starts[0].completion;
        const next = await f.runtime.start(f.trigger('slot-freed'), 'controlled', {});
        finish.resolve(); await Promise.all([...starts, next].map(start => start.completion));
    });

    test('aborts the real signal and retains cancellation after an uncooperative adapter returns late', async () => {
        const entered = deferred<AbortSignal>(), finish = deferred();
        const f = fixture(async (_request, _resolved, signal) => { entered.resolve(signal); await finish.promise; return { ...ok, artifacts: [{ type: 'markdown', schemaVersion: '1.0', mediaType: 'text/markdown', content: 'late' }] }; });
        const start = await f.runtime.start(f.trigger('cancel-active'), 'controlled', {}), signal = await entered.promise;
        expect(f.agents.controls(f.runs.get(start.runId)!)).toMatchObject({ canCancel: true });
        expect((await f.agents.cancel(start.runId, scope))?.requested).toBe(true);
        expect(signal.aborted).toBe(true); expect(signal.reason.code).toBe('RUN_CANCELLED');
        expect((await start.completion)?.execution?.run.status).toBe('cancelled');
        finish.resolve(); await Bun.sleep(5);
        expect(f.runs.get(start.runId)?.status).toBe('cancelled'); expect(f.runs.listArtifacts(start.runId)).toEqual([]);
        expect(f.runs.listSteps(start.runId).filter(step => step.name === 'run.cancel')).toHaveLength(1);
        expect(f.runs.listSteps(start.runId).find(step => step.name === manifest.id)?.status).toBe('cancelled');
        expect((await f.agents.cancel(start.runId, scope))?.requested).toBe(false); expect(f.outbox.list()).toEqual([]);
    });

    test('cancels a paused root and paused descendants without changing old or foreign records', async () => {
        const f = fixture(async () => ({ ...ok, status: 'needs_human' }));
        const first = await f.agents.execute(f.trigger('paused'), 'controlled', {}), root = first.run;
        const child: AgentRun = { ...root, id: 'paused-child', parentRunId: root.id, triggerType: 'agent', depth: 1 };
        f.runs.create(child);
        f.runs.create({ ...child, id: 'foreign-child', workspaceId: 'foreign' });
        f.runs.create({ ...root, id: 'legacy', rootRunId: 'legacy', triggerType: undefined });
        expect(await f.agents.cancel(root.id, { ...scope, workspaceId: 'foreign' })).toBeNull();
        expect(await f.agents.cancel(child.id, scope)).toBeNull(); expect(await f.agents.cancel('legacy', scope)).toBeNull();
        await f.agents.cancel(root.id, scope);
        expect(f.runs.get(root.id)?.status).toBe('cancelled'); expect(f.runs.get(child.id)?.status).toBe('cancelled');
        expect(f.runs.get('foreign-child')?.status).toBe('waiting_human'); expect(f.runs.get('legacy')?.status).toBe('waiting_human');
        await expect(f.agents.resume(f.trigger('resume-cancelled'), root.id, {})).rejects.toMatchObject({ code: 'RUN_NOT_WAITING_HUMAN' });
    });

    test('serializes completion against cancellation while keeping already persisted artifacts', async () => {
        const saving = deferred(), release = deferred(); const f = fixture(async () => ({ ...ok, artifacts: [{ type: 'markdown', schemaVersion: '1.0', mediaType: 'text/markdown', content: 'partial' }] }));
        const save = f.runs.saveArtifacts.bind(f.runs);
        f.runs.saveArtifacts = async artifacts => { save(artifacts); saving.resolve(); await release.promise; };
        const start = await f.runtime.start(f.trigger('cancel-before-final'), 'controlled', {}); await saving.promise;
        expect((await f.agents.cancel(start.runId, scope))?.requested).toBe(true); release.resolve();
        expect((await start.completion)?.execution?.run.status).toBe('cancelled'); expect(f.runs.listArtifacts(start.runId)).toHaveLength(1);
        expect(f.outbox.list()).toEqual([]);
    });

    test('reports a completed run when the final state commit wins the cancellation race', async () => {
        const committing = deferred(), release = deferred(); const f = fixture(async () => ok), transition = f.runs.transition.bind(f.runs);
        (f.runs as AgentRunStore).transition = async (id, status, patch) => { if (status === 'succeeded') { committing.resolve(); await release.promise; } return transition(id, status, patch); };
        const start = await f.runtime.start(f.trigger('complete-first'), 'controlled', {}); await committing.promise;
        const cancel = f.agents.cancel(start.runId, scope); release.resolve();
        expect((await cancel)?.requested).toBe(false); expect((await start.completion)?.execution?.run.status).toBe('succeeded');
    });

    test('keeps cancellation when an adapter failure is waiting behind the stop commit', async () => {
        const finish = deferred(), cancelling = deferred(), release = deferred(), failureSaved = deferred();
        const f = fixture(async () => { await finish.promise; return { status: 'failed', artifacts: [], error: { code: 'ADAPTER_FAILED', message: 'fixture failure', retryable: false } }; });
        const save = f.runs.saveStep.bind(f.runs);
        f.runs.saveStep = async step => {
            if (step.name === 'run.cancel') { cancelling.resolve(); await release.promise; }
            save(step); if (step.name === manifest.id && step.status === 'failed') failureSaved.resolve();
        };
        const start = await f.runtime.start(f.trigger('failure-after-stop'), 'controlled', {});
        const cancel = f.agents.cancel(start.runId, scope); await cancelling.promise; finish.resolve(); await failureSaved.promise; await Bun.sleep(1);
        release.resolve(); expect((await cancel)?.requested).toBe(true);
        expect((await start.completion)?.execution?.run).toMatchObject({ status: 'cancelled', error: { code: 'RUN_CANCELLED' } });
    });

    test('propagates root cancellation to an active delegated run', async () => {
        const childEntered = deferred(), finish = deferred();
        const f = fixture(async (request, _resolved, signal) => {
            if ((request.input as any).child) { childEntered.resolve(); await finish.promise; return ok; }
            const child = await f.agents.delegate(request, manifest, 'controlled', { child: true }, signal);
            return child.result;
        });
        const start = await f.runtime.start(f.trigger('delegation'), 'controlled', {}); await childEntered.promise;
        await f.agents.cancel(start.runId, scope); await start.completion;
        for (let i = 0; i < 30 && f.runs.listChildren(start.runId)[0]?.status === 'running'; i++) await Bun.sleep(1);
        expect(f.runs.listChildren(start.runId)[0]).toMatchObject({ status: 'cancelled', error: { code: 'RUN_CANCELLED' } });
        expect(f.runs.listSteps(start.runId).find(step => step.name === 'delegate:controlled')?.status).toBe('cancelled');
        finish.resolve();
    });
});
