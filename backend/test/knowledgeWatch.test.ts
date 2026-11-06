import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { createPluginApi } from '@/platform/workspace/api';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import { knowledgeImpactPlugin } from '@/knowledge/impact/plugin';
import { KnowledgeWatchService } from '@/knowledge/watch/service';
import { knowledgeWatchPlugin } from '@/knowledge/watch/plugin';
import type { AgentRun } from '@/platform/agents/contracts';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { checkHash } from '@/platform/plugins/checks';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { setSystemTime(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
const start = new Date('2026-11-06T00:00:00Z'), due = new Date(start.getTime() + 60_000);
async function fixture(plugin = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'knowledge-watch-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'Rules.md'), '# Rules\nAPI requires migration notes.');
    const hit = (await new MarkdownKnowledgeSource({ root }).search('API', 5)).hits[0]!;
    const store = new InMemoryPersistentKeyValueStore(), runs = new PersistentAgentRunStore(store);
    const context = () => ({ store, config: { feishu: { bot_name: 'Watch fixture' }, groups: [] } } as any);
    const host = new AgentHost(context, 100, undefined, [], { plugins: [knowledgeMarkdownPlugin, knowledgeImpactPlugin, ...(plugin ? [knowledgeWatchPlugin] : [])], pluginConfig: { 'knowledge.markdown': { root } } });
    cleanup.push(() => host.stop()); await host.initialize();
    const calls: string[] = [];
    const runScheduledLocal: NonNullable<PluginHostServices['runScheduledLocal']> = async (...args) => {
        calls.push(args[2]); const result = await host.runScheduledLocal(...args);
        return { runId: result.execution?.run.id || result.claim.runId, status: result.execution?.run.status || result.status };
    };
    const service = new KnowledgeWatchService(store, host.registry, runScheduledLocal); cleanup.push(() => service.stop());
    const app = createPluginApi(host);
    const request = (method = 'GET', body?: unknown, suffix = '', origin = 'http://localhost:15173') => app.handle(new Request('http://localhost/api/knowledge-watch' + suffix, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    async function seed(patch: Partial<AgentRun> = {}, content?: unknown) {
        const id = crypto.randomUUID(), now = new Date().toISOString();
        await runs.create({ id, ...scope, rootRunId: id, agentInstallationId: 'fixture', capability: 'knowledge.answer', triggerId: id, correlationId: id, depth: 0, status: 'succeeded', createdAt: now, ...patch });
        await runs.saveArtifacts([{ id: crypto.randomUUID(), runId: id, type: 'json', createdAt: now, mediaType: 'application/json', schemaVersion: '1.0', metadata: { privateKnowledge: true },
            content: content || { status: 'answered', evidence: [hit], claims: [{ text: 'Fixture answer', citations: [{ citationId: hit.citationId, quote: hit.excerpt }] }] } }]);
        return id;
    }
    return { root, hit, store, runs, host, service, calls, runScheduledLocal, request, seed };
}

test('watch creation validates all targets before persisting, rejects invalid scope and only schedules supported cited results', async () => {
    const f = await fixture(), id = await f.seed();
    for (const value of [{ runIds: [], intervalMinutes: 60 }, { runIds: [id, id], intervalMinutes: 60 }, { runIds: [id], intervalMinutes: 0 }, { runIds: [id], intervalMinutes: 2 }, { runIds: [id], intervalMinutes: 60, url: 'https://untrusted.example' }, { runIds: Array.from({ length: 21 }, () => crypto.randomUUID()), intervalMinutes: 60 }]) await expect(f.service.configure(value)).rejects.toThrow();
    const reads = spyOn(f.store, 'listIdempotencyEntries');
    for (const patch of [{ workspaceId: 'foreign' }, { botInstanceId: 'foreign' }]) {
        const foreign = await f.seed(patch); reads.mockClear();
        await expect(f.service.configure({ runIds: [id, foreign], intervalMinutes: 60 })).rejects.toThrow('不属于');
        expect(reads.mock.calls.some(([prefix]) => prefix.startsWith('agent:artifact:'))).toBe(false);
    }
    reads.mockRestore();
    for (const invalid of [await f.seed({ status: 'failed' }), await f.seed({ capability: 'example.echo' }), await f.seed({}, { status: 'insufficient_evidence', evidence: [], claims: [] })]) await expect(f.service.configure({ runIds: [invalid], intervalMinutes: 60 })).rejects.toThrow('完整来源');
    expect((await f.service.status()).plan).toBeNull(); expect(f.calls).toEqual([]);
});

test('due checks use the real governed Agent and only the cited document; cached reads and early ticks do not refresh sources', async () => {
    const f = await fixture(), id = await f.seed(), original = await f.runs.listArtifacts(id);
    const plan = await f.service.configure({ runIds: [id], intervalMinutes: 1 }, start);
    expect(plan.nextCheckAt).toBe(due.toISOString()); expect(f.calls).toEqual([]);
    const before = await f.store.listIdempotencyEntries('');
    await f.service.status(); await f.service.tick(start);
    expect(await f.store.listIdempotencyEntries('')).toEqual(before);
    await writeFile(path.join(f.root, 'Rules.md'), '# Updated\nAPI requires explicit human review.');
    await f.service.tick(due);
    const state = await f.service.status();
    expect(state.plan).toMatchObject({ enabled: true, lastRunStatus: 'succeeded', nextCheckAt: new Date(due.getTime() + 60_000).toISOString() });
    expect(state.reviews[0]!.assessment.state).toBe('needs_review');
    const details = await f.host.getLocalRunDetails(state.plan!.lastCheckRunId!);
    expect(details!.run).toMatchObject({ capability: 'knowledge.impact.check', triggerType: 'schedule' });
    expect(f.calls[0]!).toStartWith('knowledge-watch:');
    expect(await f.service.receipt(details!.run.id)).toMatchObject({ runId: details!.run.id, runIds: [id], triggerKey: f.calls[0] });
    expect(details!.artifacts[0]!.metadata.semanticImpact).toBe('not_assessed');
    expect(await f.runs.listArtifacts(id)).toEqual(original);
    const snapshot = await f.service.status(); await rm(f.root, { recursive: true, force: true });
    expect(await f.service.status()).toEqual(snapshot);
    await f.service.tick(new Date(due.getTime() + 60_000));
    expect((await f.service.status()).reviews[0]!.assessment.state).toBe('unverifiable');
});

test('two workers racing for the same due plan dispatch once, persist the next time before dispatch and skip missed intervals after restart', async () => {
    const f = await fixture(), id = await f.seed();
    await f.service.configure({ runIds: [id], intervalMinutes: 1 }, start);
    const other = new KnowledgeWatchService(f.store, f.host.registry, f.runScheduledLocal); cleanup.push(() => other.stop());
    await Promise.all([f.service.tick(due), other.tick(due), f.service.tick(due)]);
    expect(f.calls).toHaveLength(1);
    const later = new Date(due.getTime() + 24 * 60 * 60_000);
    await other.tick(later); expect(f.calls).toHaveLength(2);
    await f.service.tick(later); expect(f.calls).toHaveLength(2);
    expect((await other.status()).plan!.nextCheckAt).toBe(new Date(later.getTime() + 60_000).toISOString());
});

test('pause and replacement during a check do not get overwritten; stop drains an active check and prevents later dispatch', async () => {
    const f = await fixture(), id = await f.seed(), replacement = await f.seed();
    let release!: () => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const service = new KnowledgeWatchService(f.store, f.host.registry, async (...args) => { started(); await blocked; return f.runScheduledLocal(...args); });
    await service.configure({ runIds: [id], intervalMinutes: 1 }, start);
    const pending = service.tick(due); await began;
    const reserved = (await service.status()).plan!; expect(reserved.lastRunStatus).toBe('running');
    expect(Date.parse(reserved.nextCheckAt)).toBeGreaterThan(due.getTime());
    await service.pause(); await service.configure({ runIds: [replacement], intervalMinutes: 60 }, due); await service.pause();
    let stopped = false; const stopping = service.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await pending; await stopping;
    expect((await service.status()).plan).toMatchObject({ enabled: false, runIds: [replacement], intervalMinutes: 60 });
    expect((await service.status()).plan!.lastCheckRunId).toBeUndefined();
    await service.tick(new Date(due.getTime() + 3600_000)); expect(f.calls).toHaveLength(1);
});

test('binding changes and dispatch failures are explicit and bounded by the interval without exposing exception details', async () => {
    const f = await fixture(), id = await f.seed();
    await f.service.configure({ runIds: [id], intervalMinutes: 1 }, start);
    const resolve = f.host.registry.resolve.bind(f.host.registry), changed = spyOn(f.host.registry, 'resolve').mockImplementation((...args) => {
        const agent = resolve(...args); return { ...agent, installation: { ...agent.installation, id: 'different-installation' } };
    });
    await f.service.tick(due); expect(f.calls).toEqual([]); expect((await f.service.status()).plan!.lastError).toContain('绑定已变化'); changed.mockRestore();
    expect((await f.service.status()).plan!.enabled).toBe(false);
    const failure = new KnowledgeWatchService(f.store, f.host.registry, async () => { throw new Error('PRIVATE_PATH_OR_SECRET'); });
    await failure.configure({ runIds: [id], intervalMinutes: 1 }, start); await failure.tick(due);
    const state = await failure.status(); expect(state.plan!.lastRunStatus).toBe('failed'); expect(JSON.stringify(state)).not.toContain('PRIVATE_PATH_OR_SECRET');
    await failure.tick(due); expect(await failure.status()).toEqual(state);
});

test('legacy manual-channel plans pause on their old manifest binding and require explicit reconfiguration before scheduled execution', async () => {
    const f = await fixture(), id = await f.seed(), original = await f.runs.listArtifacts(id);
    await f.service.configure({ runIds: [id], intervalMinutes: 1 }, start);
    const manifest = f.host.registry.resolve(scope.workspaceId, scope.botInstanceId, 'knowledge.impact.check').manifest;
    const entry = (await f.store.listIdempotencyEntries<any>('knowledge:watch:'))[0]!;
    await f.store.setIdempotencyKey(entry.key, { ...entry.value, manifestHash: checkHash({ ...manifest, version: '1.0.0', triggers: ['manual', 'agent'] }) });
    await f.service.tick(due);
    const paused = (await f.service.status()).plan!;
    expect(paused).toMatchObject({ enabled: false, runIds: [id], lastRunStatus: 'failed' });
    expect(paused.lastError).toContain('重新保存计划'); expect(f.calls).toHaveLength(0);
    await f.service.tick(new Date(due.getTime() + 24 * 3600_000)); expect(f.calls).toHaveLength(0);
    await f.service.configure({ runIds: paused.runIds, intervalMinutes: 1 }, due); await f.service.tick(new Date(due.getTime() + 60_000));
    const resumed = (await f.service.status()).plan!;
    expect((await f.host.getLocalRunDetails(resumed.lastCheckRunId!))!.run.triggerType).toBe('schedule');
    expect(await f.runs.listArtifacts(id)).toEqual(original);
});

test('API owns its lifecycle, uses local request guards and has no plan or background checks until explicitly configured', async () => {
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
        expect(delay).toBe(30_000); tick = callback; return originalInterval(() => {}, delay);
    }) as typeof setInterval);
    cleanup.push(() => interval.mockRestore());
    const f = await fixture(true), id = await f.seed();
    expect((await (await f.request()).json() as any).plan).toBeNull();
    expect((await f.request('POST', { runIds: [id], intervalMinutes: 1 }, '', 'https://foreign.example')).status).toBe(403);
    const invalid = await f.request('POST', { runIds: [id], intervalMinutes: 1, token: 'DO_NOT_ECHO' });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('DO_NOT_ECHO');
    expect((await f.request('POST', { large: 'x'.repeat(17000) })).status).toBe(400);
    expect((await f.request('POST', { runIds: [id], intervalMinutes: 1 })).status).toBe(200);
    setSystemTime(new Date(Date.now() + 120_000)); tick!();
    let state: any;
    for (let i = 0; i < 100; i++) { state = await (await f.request()).json(); if (state.plan?.lastCheckRunId) break; await Bun.sleep(5); }
    expect(state.plan.lastRunStatus).toBe('succeeded'); expect(state.reviews[0].assessment.state).toBe('current');
    expect((await f.request('POST', {}, '/pause')).status).toBe(200);
    expect((await (await f.request()).json() as any).plan.enabled).toBe(false);
    expect((await (await f.request('GET', undefined, '/runs/' + id)).json() as any).receipt).toBeNull();
    const foreign = await f.seed({ botInstanceId: 'foreign-bot' });
    expect((await f.request('GET', undefined, '/runs/' + foreign)).status).toBe(404);
    const receipt = await (await f.request('GET', undefined, '/runs/' + state.plan.lastCheckRunId)).json() as any;
    expect(receipt.receipt.runIds).toEqual([id]);
    await f.host.stop(); tick!();
    expect((await f.host.web.handle(new Request('http://localhost/api/knowledge-watch'))).status).toBe(404);
    expect((await f.request()).status).toBe(503);
});

test('a completed native check with a failed provenance write retains the real run and does not claim a complete plan execution', async () => {
    const f = await fixture(), id = await f.seed();
    await f.service.configure({ runIds: [id], intervalMinutes: 1 }, start);
    const write = f.store.setIdempotencyKey.bind(f.store), failure = spyOn(f.store, 'setIdempotencyKey').mockImplementation(async (key, value) => {
        if (key.startsWith('knowledge:watch:') && key.includes(':plan:run:')) throw new Error('PRIVATE_STORE_DETAIL');
        return write(key, value);
    });
    try {
        await f.service.tick(due); const state = await f.service.status();
        expect(state.plan).toMatchObject({ lastRunStatus: 'failed', lastError: '检查记录已创建，但计划来源凭证未保存；请查看运行历史' });
        expect(JSON.stringify(state)).not.toContain('PRIVATE_STORE_DETAIL');
        expect((await f.host.getLocalRunDetails(state.plan!.lastCheckRunId!))!.run.status).toBe('succeeded');
        expect(await f.service.receipt(state.plan!.lastCheckRunId!)).toBeNull();
    } finally { failure.mockRestore(); }
});

test('the optional example loads over personal without changing the default or adding an empty Agent', async () => {
    const previous = process.env.KNOWLEDGE_KIND; delete process.env.KNOWLEDGE_KIND;
    const github = process.env.RELEASE_GITHUB_REPOSITORY; delete process.env.RELEASE_GITHUB_REPOSITORY;
    try {
        const file = path.resolve(import.meta.dir, '../examples/plugins.knowledge-watch-personal.yaml');
        const selected = await loadWorkspacePlugins('/tmp/watch-composition-test', file);
        expect(selected.plugins).toHaveLength(16);
        expect(selected.plugins.reduce((count, plugin) => count + (plugin.agents?.length || 0), 0)).toBe(9);
        expect(selected.plugins.some(plugin => plugin.manifest.id === 'knowledge.watch')).toBe(true);
        expect((await loadWorkspacePlugins('/tmp/watch-composition-test', '')).plugins).toHaveLength(15);
    } finally {
        if (previous === undefined) delete process.env.KNOWLEDGE_KIND; else process.env.KNOWLEDGE_KIND = previous;
        if (github === undefined) delete process.env.RELEASE_GITHUB_REPOSITORY; else process.env.RELEASE_GITHUB_REPOSITORY = github;
    }
});
