import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createWorkspaceApi } from '@/platform/workspace/api';
import type { LocalConnections } from '@/platform/workspace/connections';
import { buildConfig } from '@/core/config';
import type { AgentRun } from '@/platform/agents/contracts';
import { echoPlugin } from '../examples/plugins/echo';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
    const finish = gate(), entered = gate(), database = new InMemoryPersistentKeyValueStore();
    let disposed = false, aborted = false;
    const agent = echoPlugin.agents![0]!;
    const plugin: FeaturePlugin = { ...echoPlugin, apply(ctx) {
        ctx.effect(() => () => { disposed = true; });
        ctx.delivery.nativeAgents.register(agent.manifest.id, agent.manifest.version, async (request, _resolved, signal) => {
            signal.addEventListener('abort', () => { aborted = true; }, { once: true });
            entered.release(); await finish.promise;
            return { status: 'succeeded', data: request.input, artifacts: [] };
        });
    } };
    const config = buildConfig({}), host = new AgentHost(() => ({ store: database, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [plugin] });
    const app = createWorkspaceApi(host, {} as LocalConnections, () => config);
    const request = (path: string, body?: unknown, origin = 'http://localhost:15173') => app.handle(new Request(`http://localhost/api/workspace${path}`, { headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }));
    return { finish, entered, database, host, request, disposed: () => disposed, aborted: () => aborted };
}

test('local API returns 202 before completion, validates input, deduplicates starts and stops only owned manual roots', async () => {
    const f = fixture(), body = { capability: 'example.echo', input: { text: 'slow' }, triggerId: randomUUID() };
    try {
        expect((await f.request('/runs/start', body, 'https://foreign.test')).status).toBe(403);
        expect((await f.request('/runs/start', { ...body, triggerId: 'bad' })).status).toBe(400);
        expect((await f.request('/runs/start', { capability: body.capability, input: body.input })).status).toBe(400);
        const response = await f.request('/runs/start', body); expect(response.status).toBe(202);
        const receipt = await response.json() as any; await f.entered.promise;
        expect(receipt.status).toBe('running');
        expect((await (await f.request('/runs/start', body)).json() as any).runId).toBe(receipt.runId);
        expect((await f.request('/runs/start', { ...body, input: { text: 'changed' } })).status).toBe(409);
        const details = await (await f.request(`/runs/${receipt.runId}`)).json() as any;
        expect(details.controls.canCancel).toBe(true);
        const store = new PersistentAgentRunStore(f.database);
        const patches: Partial<AgentRun>[] = [{ workspaceId: 'foreign' }, { parentRunId: receipt.runId }, { triggerType: undefined }];
        for (const patch of patches) {
            const id = randomUUID(); await store.create({ ...details.run, ...patch, id });
            expect((await f.request(`/runs/${id}/cancel`, {})).status).toBe(404);
        }
        expect((await f.request(`/runs/${receipt.runId}/cancel`, { unknown: true })).status).toBe(400);
        expect((await f.request(`/runs/${receipt.runId}/cancel`, {}, 'https://foreign.test')).status).toBe(403);
        expect((await f.request('/runs/not-a-uuid/cancel', {})).status).toBe(400);
        expect((await f.request(`/runs/${receipt.runId}/cancel`, {})).status).toBe(200);
        expect(f.aborted()).toBe(true);
        for (let i = 0; i < 50 && (await store.get(receipt.runId))?.status === 'running'; i++) await Bun.sleep(1);
        expect((await store.get(receipt.runId))?.status).toBe('cancelled');
        expect((await (await f.request(`/runs/${receipt.runId}`)).json() as any).controls.canCancel).toBe(false);
        expect((await f.host.resumeLocal(receipt.runId, { text: 'again' }, randomUUID())).status).toBe('failed');
    } finally { f.finish.release(); await f.host.stop(); }
});

test('Host shutdown drains an accepted asynchronous task before disposing its plugin', async () => {
    const f = fixture();
    const receipt = await f.host.startLocal('example.echo', { text: 'slow' }, randomUUID()); await f.entered.promise;
    const stopping = f.host.stop(); await Bun.sleep(1); expect(f.disposed()).toBe(false);
    f.finish.release(); await stopping;
    expect(f.disposed()).toBe(true); expect((await new PersistentAgentRunStore(f.database).get(receipt.runId))?.status).toBe('succeeded');
});

test('Host shutdown also drains a start still persisting its receipt association', async () => {
    const f = fixture(), linking = gate(), allowLink = gate(); await f.host.initialize();
    const compare = f.database.compareAndSetIdempotencyKey.bind(f.database);
    f.database.compareAndSetIdempotencyKey = async (key, expected, next) => {
        if (key.startsWith('agent:trigger:') && (next as any).runId && (next as any).status === 'processing') { linking.release(); await allowLink.promise; }
        return compare(key, expected, next);
    };
    const start = f.host.startLocal('example.echo', { text: 'slow' }, randomUUID()); await linking.promise;
    const stopping = f.host.stop(); allowLink.release(); const receipt = await start; await f.entered.promise;
    expect(f.disposed()).toBe(false); f.finish.release(); await stopping;
    expect(f.disposed()).toBe(true); expect((await new PersistentAgentRunStore(f.database).get(receipt.runId))?.status).toBe('succeeded');
});
