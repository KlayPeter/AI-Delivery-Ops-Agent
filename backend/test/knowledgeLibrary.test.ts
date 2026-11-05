import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, chmod, stat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createWorkspaceApi, createPluginApi } from '@/platform/workspace/api';
import { LocalConnections } from '@/platform/workspace/connections';
import { workspaceKnowledge } from '@/platform/workspace/knowledge';
import { buildConfig } from '@/core/config';
import { createWebCapturePlugin } from '@/knowledge/capture/plugin';
import { markItDownPlugin } from '@/connectors/markitdown/plugin';
import { knowledgeLibraryPlugin, LIBRARY_CAPABILITY } from '@/knowledge/library/plugin';
import { KnowledgeLibrary, libraryRoot } from '@/knowledge/library/service';
import { createTriggerScope, createTriggerEnvelope } from '@/platform/runtime/scope';
import type { AgentRun } from '@/platform/agents/contracts';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-library-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new InMemoryPersistentKeyValueStore(), config = { ...buildConfig({}), data_path: directory };
    const library = new KnowledgeLibrary(directory, store), runs = new PersistentAgentRunStore(store);
    const capture = createWebCapturePlugin(async url => ({ url, contentType: 'text/markdown', body: Buffer.from('# Release checklist\nAPI migration notes must include a rollback plan.\n') }));
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [capture, markItDownPlugin, knowledgeLibraryPlugin] });
    cleanup.push(() => host.stop()); await host.initialize();
    const settings = new LocalConnections(path.join(directory, 'connections.json'));
    const workspace = createWorkspaceApi(host, settings, () => config), app = createPluginApi(host);
    const request = (url: string, body?: unknown, origin = 'http://localhost:15173') => workspace.handle(new Request(`http://localhost/api/workspace${url}`, body === undefined ? undefined : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { directory, store, config, library, runs, host, settings, app, request };
}
async function original(f: Awaited<ReturnType<typeof fixture>>, capability = 'knowledge.page.capture', markdown = '# Rule\nAPI migration requires a rollback plan.\n') {
    const run: AgentRun = { id: crypto.randomUUID(), ...scope, agentInstallationId: 'fixture', capability, triggerId: crypto.randomUUID(), correlationId: crypto.randomUUID(), rootRunId: '', depth: 0, status: 'succeeded', createdAt: new Date().toISOString() };
    run.rootRunId = run.id; await f.runs.create(run);
    await f.runs.saveArtifacts([{ id: crypto.randomUUID(), runId: run.id, type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: markdown, metadata: { privateKnowledge: true, title: 'Release rule' }, createdAt: run.createdAt }]);
    return run;
}

test('capture -> explicit action -> durable library -> real keyword retrieval preserves original evidence and deduplicates new triggers', async () => {
    const f = await fixture();
    const captured = await f.host.runLocal('knowledge.page.capture', { url: 'https://example.com/checklist' }, crypto.randomUUID());
    const id = captured.execution!.run.id, before = await f.runs.listArtifacts(id);
    expect((await f.library.list()).length).toBe(0);
    const actions = async () => (await (await f.request(`/runs/${id}/actions`)).json() as any).actions;
    expect((await actions())[0]).toMatchObject({ id: 'knowledge.collect', panel: { tone: 'neutral' } });
    const saved = await (await f.request(`/runs/${id}/actions/knowledge.collect`, {})).json() as any;
    expect(saved.status).toBe('succeeded');
    expect((await actions())[0].panel).toMatchObject({ tone: 'success', title: '资料已收录' });
    expect((await f.request(`/runs/${id}/actions/knowledge.collect`, { input: { runId: crypto.randomUUID() } })).status).toBe(400);
    expect((await f.request(`/runs/${id}/actions/knowledge.collect`, {}, 'https://foreign.example')).status).toBe(403);
    expect((await (await f.request(`/runs/${id}/actions/knowledge.collect`, {})).json() as any).status).toBe('succeeded');
    const entries = await new KnowledgeLibrary(f.directory, new InMemoryPersistentKeyValueStore()).list();
    expect(entries).toHaveLength(1); expect(entries[0]!.modified).toBe(false);
    const file = path.join(libraryRoot(f.directory), `${entries[0]!.item.id}.md`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('# Release checklist');
    const searched = await f.host.runLocal(LIBRARY_CAPABILITY, { operation: 'search', query: 'rollback plan' }, crypto.randomUUID());
    const data = searched.execution!.result.data as any;
    expect(data.hits[0]).toMatchObject({ title: 'Release checklist', sourceKind: 'markdown', sourceId: 'workspace-library' });
    expect(data.hits[0].excerpt).toContain('API migration notes must include a rollback plan.');
    expect(searched.execution!.result.metrics).toMatchObject({ modelCalls: 0, toolCalls: 1 });
    expect(await f.runs.listArtifacts(id)).toEqual(before);
    expect((await f.app.handle(new Request('http://localhost/api/library'))).status).toBe(200);
    await f.host.stop(); expect(f.host.web.pages()).toEqual([]); expect(f.host.runActions.forRun(captured.execution!.run)).toEqual([]);
});

test('actual MarkItDown upload and conversion can be collected and searched', async () => {
    const f = await fixture();
    const uploaded = await f.app.handle(new Request('http://localhost/api/documents/uploads', { method: 'POST', headers: { 'x-document-name': 'Notes.txt', 'content-type': 'application/octet-stream' }, body: 'Document import sentinel: APIs require migration notes.' }));
    expect(uploaded.status).toBe(201); const document = await uploaded.json() as any;
    const converted = await f.host.runLocal('knowledge.document.convert', { documentId: document.documentId }, crypto.randomUUID());
    expect(converted.execution!.run.status).toBe('succeeded');
    const saved = await f.host.runLocal(LIBRARY_CAPABILITY, { operation: 'save', runId: converted.execution!.run.id }, crypto.randomUUID());
    expect(saved.execution!.run.status).toBe('succeeded');
    expect((await f.library.source().search('Document import sentinel')).hits[0]!.excerpt).toContain('APIs require migration notes.');
}, 30_000);

test('collection validates source capability/status/ownership/artifact, rejects conversation scope and never overwrites changed local material', async () => {
    const f = await fixture(), run = await original(f);
    for (const patch of [{ workspaceId: 'foreign' }, { botInstanceId: 'foreign' }, { capability: 'example.echo' }, { status: 'failed' as const }]) {
        const rejected = { ...run, ...patch, id: crypto.randomUUID() }; await f.runs.create(rejected);
        await expect(f.library.save(scope, rejected.id)).rejects.toThrow('当前范围');
    }
    await expect(f.library.save(scope, '../private')).rejects.toThrow();
    const saved = await f.library.save(scope, run.id);
    const target = path.join(libraryRoot(f.directory), `${saved.id}.md`), contents = await readFile(target, 'utf8');
    await writeFile(target, contents + '\nUser revision.');
    await expect(f.library.save(scope, run.id)).rejects.toThrow('未覆盖');
    expect(await readFile(target, 'utf8')).toBe(contents + '\nUser revision.');
    expect((await f.library.list())[0]!.modified).toBe(true);
    const triggerScope = createTriggerScope({ ...scope, triggerType: 'manual', triggerId: crypto.randomUUID(), chatId: 'private-chat' });
    const input = { operation: 'save', runId: run.id };
    expect((await f.host.dispatch(createTriggerEnvelope({ scope: triggerScope, occurredAt: new Date().toISOString(), payload: input }), LIBRARY_CAPABILITY, input)).status).toBe('failed');
    const empty = await original(f, 'knowledge.page.capture', '\0binary');
    await expect(f.library.save(scope, empty.id)).rejects.toThrow('Binary');
    const controller = new AbortController(); controller.abort(new Error('stop fixture'));
    await expect(f.library.save(scope, run.id, controller.signal)).rejects.toThrow('stop fixture');
    expect(await readdir(libraryRoot(f.directory))).toEqual([`${saved.id}.md`]);
});

test('private library rejects symlink/hardlink/shared-permission files and a substituted parent directory', async () => {
    const f = await fixture(), run = await original(f), saved = await f.library.save(scope, run.id);
    const file = path.join(libraryRoot(f.directory), `${saved.id}.md`), raw = await readFile(file), outside = path.join(f.directory, 'outside');
    await writeFile(outside, raw, { mode: 0o600 }); await rm(file); await symlink(outside, file);
    await expect(f.library.list()).rejects.toThrow(); expect(await readFile(outside)).toEqual(raw);
    await rm(file); await link(outside, file); await expect(f.library.list()).rejects.toThrow(); await rm(file);
    await writeFile(file, raw, { mode: 0o600 }); await chmod(file, 0o644); await expect(f.library.list()).rejects.toThrow();
    await rm(path.join(f.directory, 'knowledge-library'), { recursive: true }); await symlink(f.directory, path.join(f.directory, 'knowledge-library'));
    await expect(new KnowledgeLibrary(f.directory, f.store).initialize()).rejects.toThrow('私有目录');
});

test('restart removes its interrupted temporary link without losing the committed document', async () => {
    const f = await fixture(), run = await original(f), saved = await f.library.save(scope, run.id);
    const root = libraryRoot(f.directory), target = path.join(root, `${saved.id}.md`), contents = await readFile(target);
    await link(target, path.join(root, `.${crypto.randomUUID()}.tmp`));
    await writeFile(path.join(root, `.${crypto.randomUUID()}.tmp`), 'interrupted before commit', { mode: 0o600 });
    await expect(f.library.list()).rejects.toThrow();
    const restarted = new KnowledgeLibrary(f.directory, f.store); await restarted.initialize();
    expect(await readdir(root)).toEqual([`${saved.id}.md`]);
    expect(await readFile(target)).toEqual(contents); expect((await restarted.list())[0]!.modified).toBe(false);
});

test('serialized collection enforces its capacity while allowing duplicate imports at the limit', async () => {
    const f = await fixture(), items = await Promise.all(Array.from({ length: 101 }, () => original(f)));
    const results = await Promise.allSettled(items.map(item => f.library.save(scope, item.id)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(100);
    expect(results[100]!.status).toBe('rejected'); expect(await readdir(libraryRoot(f.directory))).toHaveLength(100);
    expect((await f.library.save(scope, items[0]!.id)).duplicate).toBe(true);
}, 30_000);

test('saved library is selectable through local settings and reuses the actual RAG and reference-check pipeline after restart', async () => {
    const f = await fixture(), run = await original(f); await f.library.save(scope, run.id); await f.host.stop();
    const oldKind = process.env.KNOWLEDGE_KIND; cleanup.push(() => { if (oldKind === undefined) delete process.env.KNOWLEDGE_KIND; else process.env.KNOWLEDGE_KIND = oldKind; });
    const settings = new LocalConnections(path.join(f.directory, 'connections.json')); await settings.initialize();
    await settings.save({ KNOWLEDGE_KIND: 'library' }); expect(settings.snapshot().restartRequired).toBe(true);
    await new LocalConnections(path.join(f.directory, 'connections.json')).initialize();
    let modelCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        modelCalls++; const body = await request.json() as any;
        const message = body.messages.find((item: any) => item.role === 'user').content;
        const supplied = JSON.parse(typeof message === 'string' ? message : message.map((part: any) => part.text || '').join(''));
        const hit = supplied.evidence[0];
        return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ status: 'answered', claims: [{ text: 'A rollback plan is required.', citations: [{ citationId: hit.citationId, quote: 'requires a rollback plan' }] }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    } }); cleanup.push(() => server.stop(true));
    const selected = workspaceKnowledge(f.directory), config = { ...f.config, ai: { provider: 'openai-compatible', model: 'fixture', api_key: 'fixture-local-only', api_base: `${server.url}v1` } };
    const restarted = new AgentHost(() => ({ store: f.store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
    cleanup.push(() => restarted.stop());
    const answer = await restarted.runLocal('knowledge.answer', { question: 'API migration rollback' }, crypto.randomUUID());
    expect(answer.execution!.result.data).toMatchObject({ status: 'answered', evidence: [{ sourceId: 'workspace-library' }] }); expect(modelCalls).toBe(1);
    const id = answer.execution!.run.id, originalEvidence = await f.runs.listArtifacts(id);
    const current = await restarted.runLocal('knowledge.impact.check', { runIds: [id] }, crypto.randomUUID());
    expect((current.execution!.result.data as any).assessments[0].state).toBe('current');
    const item = (await f.library.list())[0]!.item, file = path.join(libraryRoot(f.directory), `${item.id}.md`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('requires a rollback plan', 'requires a new rollback checklist'));
    const changed = await restarted.runLocal('knowledge.impact.check', { runIds: [id] }, crypto.randomUUID());
    expect((changed.execution!.result.data as any).assessments[0].state).toBe('needs_review');
    expect(await f.runs.listArtifacts(id)).toEqual(originalEvidence); expect(modelCalls).toBe(1);
    const descriptor = await (await createPluginApi(restarted).handle(new Request('http://localhost/api/knowledge-workspace'))).json();
    expect(descriptor).toMatchObject({ kind: 'library', pluginId: 'knowledge.markdown' });
}, 30_000);
