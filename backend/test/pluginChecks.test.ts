import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { RunCheckRegistry, type RunCheckDefinition } from '@/platform/plugins/checks';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import { createPluginApi } from '@/platform/workspace/api';
import { buildConfig } from '@/core/config';
import { createWebCapturePlugin } from '@/knowledge/capture/plugin';
import { markItDownPlugin } from '@/connectors/markitdown/plugin';
import { pluginChecksPlugin, CHECK_CAPABILITY } from '@/quality/plugin';
import { RunCheckService } from '@/quality/service';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'plugin-checks-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new InMemoryPersistentKeyValueStore(), config = { ...buildConfig({}), data_path: directory };
    const host = async (plugins: FeaturePlugin[]) => {
        const result = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins });
        cleanup.push(() => result.stop()); await result.initialize(); return result;
    };
    return { directory, store, config, host, runs: new PersistentAgentRunStore(store) };
}
const definition: RunCheckDefinition = { id: 'test.output.result', title: 'Fixture output', version: '1.0.0', agentId: 'test.result', capability: 'test.result',
    artifacts: [{ id: 'answer', type: 'json', schema: { type: 'object', required: ['mediaType', 'metadata', 'content'], properties: {
        mediaType: { const: 'application/json' }, metadata: { type: 'object', required: ['privateKnowledge'], properties: { privateKnowledge: { const: true } } },
        content: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', minLength: 1 } } },
    } } }], steps: [{ id: 'read', kind: 'tool', name: 'test.read' }] };
function provider(version = '1.0.0', broken = false): FeaturePlugin {
    const manifest: AgentManifest = { schemaVersion: '1.1', id: 'test.result', name: 'Fixture provider', version, description: 'Local check fixture', runtime: { type: 'native' }, capabilities: ['test.result'], triggers: ['manual', 'agent'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        requirements: { tools: ['test.read'], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 5, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 65536 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false } };
    return { manifest: { apiVersion: '1.0', id: 'test.output', name: 'Fixture', version, description: 'In-process fixture only' }, agents: [{ manifest, installationId: 'test-result-install' }], checks: [definition], apply(ctx) {
        ctx.delivery.tools.register({ id: 'test.read', version, description: 'Read fixture value', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 2 }, async () => broken ? { renamed: 'regression' } : { answer: 'fixture evidence' });
        ctx.delivery.nativeAgents.register(manifest.id, version, async (request, _resolved, signal) => {
            const data = await ctx.delivery.toolGateway.execute('test.read', {}, { runId: request.runId, agentId: manifest.id, scope: request.scope, allowedTools: ['test.read'], signal, budget: new RunToolCallBudget(1), idempotencyKey: request.runId });
            return { status: 'succeeded', data, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { privateKnowledge: true } }] };
        });
    } };
}

test('declarative contracts validate ownership, schemas and limits, preserve immutable snapshots, and dispose registrations', () => {
    const registry = new RunCheckRegistry(), plugin = provider(), copy = structuredClone(definition);
    const dispose = registry.register(plugin, copy), original = registry.require(definition.id);
    copy.title = 'mutated'; const exposed = registry.require(definition.id); exposed.artifacts[0]!.schema.required = [];
    expect(registry.require(definition.id)).toEqual(original);
    expect(registry.list()[0]).toMatchObject({ provider: { pluginId: 'test.output', pluginVersion: '1.0.0' }, artifactChecks: 1, stepChecks: 1 });
    expect(() => registry.register(plugin, definition)).toThrow('Duplicate');
    dispose(); expect(registry.list()).toEqual([]);
    for (const changed of [{ id: 'foreign.result' }, { agentId: 'foreign.agent' }, { capability: 'foreign.capability' }, { artifacts: [...definition.artifacts, ...definition.artifacts] },
        { artifacts: [{ id: 'bad', type: 'json', schema: { $ref: 'https://invalid.example/remote-schema' } }] }, { artifacts: [{ id: 'bad', type: 'json', schema: { type: 'invented-type' } }] },
        { artifacts: [{ id: 'bad', type: 'json', schema: { callback: () => {} } }] }, { title: 'x'.repeat(70_000) },
    ]) expect(() => registry.register(plugin, { ...definition, ...changed } as any)).toThrow();
});

test('static result checks roll back with a failed plugin and disappear after stop', async () => {
    const f = await fixture(), broken = { ...provider(), apply() { throw new Error('fixture mount failure'); } };
    const failed = new AgentHost(() => ({ store: f.store, config: f.config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [broken] });
    await expect(failed.initialize()).rejects.toThrow('fixture mount failure'); expect(failed.checks.list()).toEqual([]); await failed.stop();
    const host = await f.host([provider()]); expect(host.checks.list()).toHaveLength(1); await host.stop(); expect(host.checks.list()).toEqual([]);
});

test('the documented minimal YAML loads capture and checks without team integrations or a model', async () => {
    const f = await fixture(), selected = await loadPluginConfiguration(path.resolve(import.meta.dir, '../examples/plugins.checks.yaml'));
    const host = await f.host(selected.plugins);
    expect(host.checks.list().map(item => item.id)).toEqual(['knowledge.capture.result']);
    expect(host.web.pages().map(page => page.path)).toContain('/checks');
    expect(host.canDispatch(CHECK_CAPABILITY)).toBe(true);
});

test('an actual capture is checked without fetching again, records a private report and preserves the source', async () => {
    const f = await fixture(); let reads = 0;
    const capture = createWebCapturePlugin(async url => { reads++; return { url, contentType: 'text/markdown', body: Buffer.from('# Fixture\nAn article with retained source evidence.\n') }; });
    const host = await f.host([pluginChecksPlugin, capture]);
    const original = await host.runLocal('knowledge.page.capture', { url: 'https://example.com/article' }, crypto.randomUUID()), id = original.execution!.run.id;
    const before = await host.getLocalRunDetails(id);
    const checked = await host.runLocal(CHECK_CAPABILITY, { contractId: 'knowledge.capture.result', runId: id }, crypto.randomUUID());
    expect(checked.execution!.run.status).toBe('succeeded');
    expect(checked.execution!.result.data).toMatchObject({ current: { verdict: 'passed', executions: [{ agentId: 'native.web-capture', agentVersion: '1.0.0' }] }, reexecuted: false, semanticQuality: 'not_assessed' });
    expect(checked.execution!.result.metrics).toMatchObject({ modelCalls: 0, toolCalls: 0 }); expect(reads).toBe(1);
    expect(await host.getLocalRunDetails(id)).toEqual(before);
    const app = createPluginApi(host);
    const list = await (await app.handle(new Request('http://localhost/api/checks/contracts'))).json() as any;
    expect(list.contracts).toHaveLength(1); expect(list.contracts[0].artifacts).toBeUndefined();
    expect((await app.handle(new Request('http://localhost/api/checks/contracts', { headers: { origin: 'https://foreign.example' } }))).status).toBe(403);
    const report = checked.execution!.artifacts[0]!;
    expect(report.metadata).toMatchObject({ privateKnowledge: true, statusPanels: [{ tone: 'success' }] });
});

test('actual upstream conversion fulfills the declared document contract', async () => {
    const f = await fixture(), host = await f.host([markItDownPlugin, pluginChecksPlugin]), app = createPluginApi(host);
    const upload = await (await app.handle(new Request('http://localhost/api/documents/uploads', { method: 'POST', headers: { 'x-document-name': 'Fixture.txt' }, body: 'Document contract fixture.' }))).json() as any;
    const converted = await host.runLocal('knowledge.document.convert', { documentId: upload.documentId }, crypto.randomUUID());
    expect(converted.execution!.run.status).toBe('succeeded');
    const result = await host.runLocal(CHECK_CAPABILITY, { contractId: 'community.markitdown.result', runId: converted.execution!.run.id }, crypto.randomUUID());
    expect((result.execution!.result.data as any).current.verdict).toBe('passed');
}, 30_000);

test('compares two versions against one policy and detects a successful run whose artifact lost a required field', async () => {
    const f = await fixture(), first = await f.host([provider(), pluginChecksPlugin]), input = { query: 'same fixture input' };
    const baseline = await first.runLocal('test.result', input, crypto.randomUUID()), baselineId = baseline.execution!.run.id;
    const oldSteps = await f.runs.listSteps(baselineId), oldArtifacts = await f.runs.listArtifacts(baselineId); await first.stop();
    const second = await f.host([provider('2.0.0', true), pluginChecksPlugin]), current = await second.runLocal('test.result', input, crypto.randomUUID());
    expect(current.execution!.run.status).toBe('succeeded');
    const evaluated = await second.runLocal(CHECK_CAPABILITY, { contractId: definition.id, runId: current.execution!.run.id, baselineRunId: baselineId }, crypto.randomUUID());
    const report = evaluated.execution!.result.data as any;
    expect(report).toMatchObject({ contract: { provider: { pluginVersion: '2.0.0' } }, current: { verdict: 'failed', executions: [{ agentVersion: '2.0.0' }] }, baseline: { verdict: 'passed', executions: [{ agentVersion: '1.0.0' }] }, comparison: { regressed: ['artifact:answer'], recordedRequestInputsMatch: true } });
    expect(report.current.evidenceHash).not.toBe(report.baseline.evidenceHash);
    expect(await f.runs.listSteps(baselineId)).toEqual(oldSteps); expect(await f.runs.listArtifacts(baselineId)).toEqual(oldArtifacts);
});

test('legacy records cannot become a green version-verified result using the currently installed provider', async () => {
    const f = await fixture(), host = await f.host([provider(), pluginChecksPlugin]), source = await host.runLocal('test.result', {}, crypto.randomUUID()), id = source.execution!.run.id;
    for (const step of await f.runs.listSteps(id)) if (step.kind === 'agent') await f.runs.saveStep({ ...step, metadata: {} });
    const report = await new RunCheckService(f.store, host.checks).check(scope, { contractId: definition.id, runId: id });
    expect(report.current.verdict).toBe('unverifiable'); expect(report.current.executions).toEqual([]);
    expect(report.current.assertions.filter(item => item.id.startsWith('artifact:'))[0]!.verdict).toBe('passed');
});

test('artifact-envelope checks catch lost privacy metadata and wrong media types even when the content still matches', async () => {
    const f = await fixture(), host = await f.host([provider(), pluginChecksPlugin]), source = await host.runLocal('test.result', {}, crypto.randomUUID()), id = source.execution!.run.id;
    const artifact = (await f.runs.listArtifacts(id))[0]!;
    for (const changed of [{ ...artifact, metadata: {} }, { ...artifact, mediaType: 'text/html' }]) {
        await f.runs.saveArtifacts([changed]);
        const report = await new RunCheckService(f.store, host.checks).check(scope, { contractId: definition.id, runId: id });
        expect(report.current.verdict).toBe('failed');
        expect(report.current.assertions.find(item => item.id === 'artifact:answer')!.verdict).toBe('failed');
    }
});

test('checks all target ownership and terminal state before reading any artifacts or steps, and honors cancellation', async () => {
    const f = await fixture(), host = await f.host([provider(), pluginChecksPlugin]), original = await host.runLocal('test.result', {}, crypto.randomUUID()), source = original.execution!.run;
    const foreign = { ...source, id: crypto.randomUUID(), workspaceId: 'foreign' }; await f.runs.create(foreign);
    const active = { ...source, id: crypto.randomUUID(), status: 'running' as const }; await f.runs.create(active);
    const reads: string[] = [], list = f.store.listIdempotencyEntries.bind(f.store);
    (f.store as any).listIdempotencyEntries = async (prefix: string) => { reads.push(prefix); return list(prefix); };
    const service = new RunCheckService(f.store, host.checks);
    await expect(service.check(scope, { contractId: definition.id, runId: source.id, baselineRunId: foreign.id })).rejects.toThrow('当前范围');
    await expect(service.check(scope, { contractId: definition.id, runId: active.id })).rejects.toThrow('尚未结束');
    const controller = new AbortController(); controller.abort(new Error('fixture stop'));
    await expect(service.check(scope, { contractId: definition.id, runId: source.id }, controller.signal)).rejects.toThrow('fixture stop');
    expect(reads).toEqual([]);
    await expect(service.check(scope, { contractId: definition.id, runId: source.id, baselineRunId: source.id })).rejects.toThrow('不同');
});
