import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { buildConfig } from '@/core/config';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { runRecipesPlugin } from '@/recipes/plugin';
import { checkHash } from '@/platform/plugins/checks';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';

const disposers: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
const capability = 'knowledge.markdown.retrieve', input = { operation: 'search', query: 'API migration', limit: 5 };
async function fixture(store = new InMemoryPersistentKeyValueStore()) {
    const root = await mkdtemp(path.join(tmpdir(), 'run-recipes-')); disposers.push(() => rm(root, { recursive: true, force: true }));
    const vault = path.join(root, 'vault'); await mkdir(vault); await writeFile(path.join(vault, 'Release.md'), '# API migration\nInclude migration notes before release.');
    const config = { ...buildConfig({}), data_path: path.join(root, 'data') };
    const createHost = (recipes = true) => {
        const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [knowledgeMarkdownPlugin, ...(recipes ? [runRecipesPlugin] : [])], pluginConfig: { 'knowledge.markdown': { root: vault, sourceId: 'recipe-fixture' } } });
        disposers.push(() => host.stop()); return host;
    };
    const host = createHost(), source = await host.runLocal(capability, input, randomUUID()), sourceRunId = source.execution!.run.id;
    const call = (method: string, suffix = '', body?: unknown, current = host, headers = {}) => current.handlePluginRequest(new Request('http://localhost/api/recipes' + suffix, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const draft = { id: randomUUID(), name: 'API 发布检查', sourceRunId, input };
    const save = async () => { const response = await call('POST', '', draft); expect(response.status).toBe(200); return (await response.json()).recipe; };
    return { host, store, sourceRunId, createHost, call, draft, save, config };
}

test('verified recipe reuses reviewed parameters with new Runtime runs, durable provenance and bound idempotency', async () => {
    const f = await fixture(), before = await f.host.getLocalRunDetails(f.sourceRunId);
    const responses = await Promise.all([f.call('POST', '', f.draft), f.call('POST', '', f.draft)]); expect(responses.map(r => r.status)).toEqual([200, 200]);
    const recipe = (await responses[0]!.json()).recipe, list = (await (await f.call('GET')).json()).recipes;
    expect(list).toHaveLength(1); expect(list[0].input).toBeUndefined(); expect(await f.host.getLocalRunDetails(f.sourceRunId)).toEqual(before); expect(await f.host.listLocalRuns()).toHaveLength(1);
    const launch = { triggerId: randomUUID(), input }, result = await (await f.call('POST', `/${recipe.id}/run`, launch)).json();
    expect(result.status).toBe('succeeded'); expect(result.runId).not.toBe(f.sourceRunId); expect(result.receiptSaved).toBe(true);
    expect((await (await f.call('POST', `/${recipe.id}/run`, launch)).json()).runId).toBe(result.runId); expect(await f.host.listLocalRuns()).toHaveLength(2);
    expect((await (await f.call('GET', `/launches/${result.runId}`)).json()).receipt).toMatchObject({ recipeId: recipe.id, sourceRunId: f.sourceRunId, parametersChanged: false });
    const changed = { ...input, query: 'release' }; expect((await f.call('POST', `/${recipe.id}/run`, { ...launch, input: changed })).status).toBe(409);
    const next = await (await f.call('POST', `/${recipe.id}/run`, { triggerId: randomUUID(), input: changed })).json();
    expect((await (await f.call('GET', `/launches/${next.runId}`)).json()).receipt.parametersChanged).toBe(true); expect((await (await f.call('GET', `/${recipe.id}`)).json()).recipe.input).toEqual(input);
});

test('recipes survive Host replacement while removal closes their page and APIs without deleting records', async () => {
    const f = await fixture(), recipe = await f.save(); await f.host.stop();
    const without = f.createHost(false); await without.initialize(); expect((await f.call('GET', '', undefined, without)).status).toBe(404); await without.stop();
    const restored = f.createHost(); await restored.initialize();
    expect((await (await f.call('GET', '', undefined, restored)).json()).recipes[0]).toMatchObject({ id: recipe.id, available: true });
    expect((await (await f.call('POST', `/${recipe.id}/run`, { triggerId: randomUUID(), input }, restored)).json()).status).toBe('succeeded');
    await restored.stop(); expect((await f.call('GET', '', undefined, restored)).status).toBe(503);
});

test('creation refuses changed inputs, conflicting IDs, unreviewed capabilities and legacy or resumed source records', async () => {
    const f = await fixture(); expect((await f.call('POST', '', { ...f.draft, input: { ...input, query: 'different' } })).status).toBe(400);
    await f.save(); expect((await f.call('POST', '', { ...f.draft, name: 'different' })).status).toBe(409);
    const runs = new PersistentAgentRunStore(f.store), source = (await runs.get(f.sourceRunId))!, steps = await runs.listSteps(f.sourceRunId), step = steps.find(s => s.kind === 'agent')!;
    for (const patch of [{ status: 'failed' }, { parentRunId: randomUUID() }, { capability: 'task.manage' }]) {
        const id = randomUUID(); await runs.create({ ...source, ...patch, id, rootRunId: id } as typeof source); expect((await f.call('POST', '', { ...f.draft, id: randomUUID(), sourceRunId: id })).status).toBe(400);
    }
    await runs.saveStep({ ...step, metadata: {} }); expect((await f.call('POST', '', { ...f.draft, id: randomUUID() })).status).toBe(400);
    await runs.saveStep(step); await runs.saveStep({ ...step, id: randomUUID() }); expect((await f.call('POST', '', { ...f.draft, id: randomUUID() })).status).toBe(400);
});

test('cross-workspace source rejection precedes any evidence read', async () => {
    const f = await fixture(), runs = new PersistentAgentRunStore(f.store), source = (await runs.get(f.sourceRunId))!, id = randomUUID(); await runs.create({ ...source, id, rootRunId: id, workspaceId: 'another-workspace' });
    let reads = 0; const list = f.store.listIdempotencyEntries.bind(f.store);
    f.store.listIdempotencyEntries = async (prefix: string) => { if (prefix.startsWith('agent:step:') || prefix.startsWith('agent:artifact:')) reads++; return list(prefix); };
    expect((await f.call('POST', '', { ...f.draft, sourceRunId: id })).status).toBe(404); expect(reads).toBe(0);
});

test('version drift blocks launch and Runtime verifies the execution actually selected after preflight', async () => {
    const f = await fixture(), recipe = await f.save(), manifest = knowledgeMarkdownPlugin.agents![0]!.manifest, original = f.host.registry.resolve('workspace-default', 'bot-default', capability);
    const guarded = await f.host.runLocal(capability, input, randomUUID(), { installationId: original.installation.id, manifestHash: '0'.repeat(64) });
    expect(guarded.status).toBe('failed'); expect(guarded.claim.error?.code).toBe('AGENT_CONTRACT_CHANGED'); expect(await f.host.listLocalRuns()).toHaveLength(1);
    expect((await f.host.runLocal(capability, input, randomUUID(), { installationId: original.installation.id, manifestHash: checkHash(manifest) })).execution?.run.status).toBe('succeeded');
    f.host.registry.register({ ...manifest, version: '1.0.1' });
    const runLocal = f.host.runLocal.bind(f.host);
    f.host.runLocal = async (selected, parameters, triggerId, expected) => {
        if (expected) f.host.registry.upsertInstallation({ ...original.installation, version: '1.0.1' });
        return runLocal(selected, parameters, triggerId, expected);
    };
    const drift = await f.call('POST', `/${recipe.id}/run`, { triggerId: randomUUID(), input });
    expect(drift.status).toBe(409); expect((await drift.json()).error).toContain('未执行配方任务'); expect((await (await f.call('GET')).json()).recipes[0].available).toBe(false); expect(await f.host.listLocalRuns()).toHaveLength(2);
});

test('invalid parameters, foreign Origin and oversized streams cannot create or launch tasks', async () => {
    const f = await fixture(), recipe = await f.save();
    expect((await f.call('POST', '', { ...f.draft, scope: 'other' })).status).toBe(400); expect((await f.call('GET', '', undefined, f.host, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await f.call('POST', `/${recipe.id}/run`, { triggerId: randomUUID(), input: { query: '' } })).status).toBe(400);
    let cancelled = false; const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(40001))); }, cancel() { cancelled = true; } });
    const response = await f.host.handlePluginRequest(new Request('http://localhost/api/recipes', { method: 'POST', body })); expect(response.status).toBe(413); expect(cancelled).toBe(true); expect(await f.host.listLocalRuns()).toHaveLength(1);
});

test('receipt persistence failure returns the created run and an explicit warning', async () => {
    class FailingReceiptStore extends InMemoryPersistentKeyValueStore { override async setIdempotencyKey(key: string, value: unknown) { if (key.startsWith('personal:recipes:') && key.includes(':run:')) throw new Error('fixture receipt failure'); return super.setIdempotencyKey(key, value); } }
    const f = await fixture(new FailingReceiptStore()), recipe = await f.save(), result = await (await f.call('POST', `/${recipe.id}/run`, { triggerId: randomUUID(), input })).json();
    expect(result.status).toBe('succeeded'); expect(result.runId).toBeDefined(); expect(result.receiptSaved).toBe(false); expect(result.warning).toContain('运行已创建'); expect((await f.host.getLocalRunDetails(result.runId))?.run.status).toBe('succeeded'); expect((await (await f.call('GET', `/launches/${result.runId}`)).json()).receipt).toBeNull();
});

test('early local execution rejects instead of deadlocking plugin initialization', async () => {
    const f = await fixture(), host = new AgentHost(() => ({ store: new InMemoryPersistentKeyValueStore(), config: f.config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [{ manifest: { apiVersion: '1.0', id: 'example.early', name: 'Early', version: '1.0.0', description: 'Readiness fixture' }, async apply(ctx) { await ctx.delivery.runLocal!('example.missing', {}, randomUUID()); } }] });
    disposers.push(() => host.stop()); await expect(host.initialize()).rejects.toThrow('Host 尚未就绪或已停止');
});

test('documented minimal profile loads the real local modules and reuses a no-model knowledge task', async () => {
    const f = await fixture(), selected = await loadPluginConfiguration(path.resolve(import.meta.dir, '../examples/plugins.recipes.yaml'));
    expect(selected.plugins.map(plugin => plugin.manifest.id)).toEqual(['knowledge.markdown', 'personal.recipes']);
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ config: f.config, store, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selected.plugins, pluginConfig: { ...selected.config, 'knowledge.markdown': { ...selected.config['knowledge.markdown'], root: path.resolve(import.meta.dir, '../examples/knowledge-vault') } } });
    disposers.push(() => host.stop());
    const source = await host.runLocal(capability, input, randomUUID()); expect(source.execution?.run.status).toBe('succeeded');
    const response = await f.call('POST', '', { ...f.draft, id: randomUUID(), sourceRunId: source.execution!.run.id }, host);
    expect(response.status).toBe(200); expect(host.web.pages().map(page => page.path)).toEqual(['/recipes']);
});
