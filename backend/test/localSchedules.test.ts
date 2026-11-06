import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildConfig } from '@/core/config';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { createTriggerScope, createExecutionScope } from '@/platform/runtime/scope';
import { createWorkspaceApi } from '@/platform/workspace/api';
import type { LocalConnections } from '@/platform/workspace/connections';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { requirePersonalScope, requirePersonalVersionScope } from '@/knowledge/scope';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import { createKnowledgeWebPlugin, KNOWLEDGE_WEB_VERSIONS_TOOL } from '@/knowledge/web/plugin';
import { WebKnowledgeSource, webSourceConfig } from '@/knowledge/web/source';
import { knowledgeMixedPlugin, MIXED_VERSIONS_TOOL } from '@/knowledge/mixed/plugin';
import { knowledgeLibraryPlugin } from '@/knowledge/library/plugin';
import { KnowledgeLibrary } from '@/knowledge/library/service';
import { createKnowledgeImpactPlugin } from '@/knowledge/impact/plugin';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
const capability = 'knowledge.impact.check';
async function fixture(kind: 'markdown' | 'web' | 'mixed' | 'library' = 'markdown') {
    const directory = await mkdtemp(path.join(tmpdir(), 'local-schedules-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new InMemoryPersistentKeyValueStore(), runs = new PersistentAgentRunStore(store), config = { ...buildConfig({}), data_path: directory };
    const library = new KnowledgeLibrary(directory, store);
    if (kind === 'library') await library.initialize();
    const markdownConfig = kind === 'library' ? library.source(scope).config : { root: path.join(directory, 'vault'), sourceId: 'schedule-notes' };
    await mkdir(markdownConfig.root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(markdownConfig.root, 'Rules.md'), '# Rules\nAPI requires migration notes.', { mode: 0o600 });
    const url = 'https://example.com/policy', webConfig = webSourceConfig.parse({ urls: [url], sourceId: 'schedule-web' });
    const loadPage = async () => ({ url, body: Buffer.from('# API policy\nAPI clients require stable links.'), contentType: 'text/markdown' });
    const web = createKnowledgeWebPlugin(loadPage), impact = createKnowledgeImpactPlugin(kind === 'web'
        ? { pluginId: 'knowledge.web', versionsTool: KNOWLEDGE_WEB_VERSIONS_TOOL, kind: 'web' }
        : kind === 'mixed' ? { pluginId: 'knowledge.mixed', versionsTool: MIXED_VERSIONS_TOOL, kind: 'mixed' } : undefined);
    let port!: NonNullable<PluginHostServices['runScheduledLocal']>, gateway!: PluginHostServices['toolGateway'], earlyError: unknown;
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: [...(kind === 'web' ? [web] : kind === 'mixed' ? [knowledgeMarkdownPlugin, web, knowledgeMixedPlugin] : [knowledgeMarkdownPlugin]), ...(kind === 'library' ? [knowledgeLibraryPlugin] : []), impact,
            { manifest: { apiVersion: '1.0', id: 'example.schedule-port', name: 'Schedule test', version: '1.0.0', description: 'Capture trusted ports' }, async apply(ctx) {
                port = ctx.delivery.runScheduledLocal!; gateway = ctx.delivery.toolGateway;
                try { await port(capability, { runIds: [] }, crypto.randomUUID()); } catch (error) { earlyError = error; }
            } }],
        pluginConfig: { ...(kind === 'web' ? {} : { 'knowledge.markdown': markdownConfig }), ...(['web', 'mixed'].includes(kind) ? { 'knowledge.web': webConfig } : {}) },
    });
    cleanup.push(() => host.stop()); await host.initialize();
    const md = (await new MarkdownKnowledgeSource(markdownConfig).search('API', 5)).hits;
    const online = ['web', 'mixed'].includes(kind) ? (await new WebKnowledgeSource(webConfig, loadPage).search('API', 5)).hits : [];
    const evidence = kind === 'web' ? online : kind === 'mixed' ? [...md, ...online] : md;
    const id = crypto.randomUUID(), now = new Date().toISOString();
    await runs.create({ id, ...scope, rootRunId: id, agentInstallationId: 'fixture', capability: 'knowledge.answer', triggerId: id, correlationId: id, depth: 0, status: 'succeeded', createdAt: now });
    await runs.saveArtifacts([{ id: crypto.randomUUID(), runId: id, type: 'json', createdAt: now, mediaType: 'application/json', schemaVersion: '1.0', metadata: { privateKnowledge: true },
        content: { status: 'answered', evidence, claims: evidence.map(hit => ({ text: 'Fixture answer', citations: [{ citationId: hit.citationId, quote: hit.excerpt }] })) } }]);
    return { host, store, runs, config, port, gateway, earlyError, targetId: id, input: { runIds: [id], operation: 'check' } };
}

test('only the explicit version scope accepts private schedules; ordinary personal scopes and group/conversation scopes retain their boundary', () => {
    for (const triggerType of ['manual', 'agent', 'schedule', 'message', 'webhook'] as const) {
        const value = createTriggerScope({ ...scope, triggerType, triggerId: crypto.randomUUID() });
        if (['manual', 'agent'].includes(triggerType)) expect(() => requirePersonalScope(value)).not.toThrow();
        else expect(() => requirePersonalScope(value)).toThrow();
        if (['manual', 'agent', 'schedule'].includes(triggerType)) expect(() => requirePersonalVersionScope(value)).not.toThrow();
        else expect(() => requirePersonalVersionScope(value)).toThrow();
        for (const field of [{ chatId: 'group' }, { conversationId: 'conversation' }]) expect(() => requirePersonalVersionScope({ ...value, ...field })).toThrow();
    }
});

test('the trusted local schedule port enforces readiness, manifest admission, execution binding and distinct manual/schedule idempotency', async () => {
    const f = await fixture(); expect(String(f.earlyError)).toContain('尚未就绪');
    const key = crypto.randomUUID(), manual = await f.host.runLocal(capability, f.input, key), scheduled = await f.port(capability, f.input, key);
    expect(manual.execution!.run.triggerType).toBe('manual'); expect(scheduled.status).toBe('succeeded');
    expect(scheduled.runId).not.toBe(manual.execution!.run.id);
    const details = (await f.host.getLocalRunDetails(scheduled.runId!))!;
    expect(details.run).toMatchObject({ ...scope, triggerType: 'schedule', capability, status: 'succeeded' });
    expect(details.controls.canCancel).toBe(false);
    expect(details.steps.some(step => step.kind === 'model')).toBe(false);
    expect((await f.port(capability, f.input, key)).runId).toBe(scheduled.runId);
    const denied = await f.port('knowledge.markdown.retrieve', { operation: 'search', query: 'API' }, crypto.randomUUID());
    expect(denied.status).toBe('failed'); expect(denied.error?.code).toBe('TRIGGER_NOT_ALLOWED');
    const stale = await f.port(capability, f.input, crypto.randomUUID(), { installationId: 'not-current', manifestHash: 'a'.repeat(64) });
    expect(stale.status).toBe('failed'); expect(stale.error?.code).toBe('AGENT_CONTRACT_CHANGED');
    await f.host.stop(); await expect(f.port(capability, f.input, crypto.randomUUID())).rejects.toThrow('已停止');
});

for (const kind of ['web', 'mixed', 'library'] as const) test(`${kind} version checks accept real schedule scopes while search and collection tools remain blocked`, async () => {
    const f = await fixture(kind), before = await f.runs.listArtifacts(f.targetId), result = await f.port(capability, f.input, crypto.randomUUID());
    expect(result.status).toBe('succeeded');
    const details = (await f.host.getLocalRunDetails(result.runId!))!, report = details.artifacts[0]!.content as any;
    expect(details.run.triggerType).toBe('schedule');
    expect(report.assessments[0].state).toBe('current');
    expect(report.assessments[0].references).toHaveLength(kind === 'mixed' ? 2 : 1);
    expect(details.steps.filter(step => step.kind === 'tool')).toHaveLength(kind === 'mixed' ? 3 : 1);
    expect(await f.runs.listArtifacts(f.targetId)).toEqual(before);
    const executionScope = createExecutionScope(createTriggerScope({ ...scope, triggerType: 'schedule', triggerId: crypto.randomUUID() }), 'install-knowledge-impact');
    const tools = kind === 'web' ? ['knowledge.web.search'] : kind === 'mixed' ? ['knowledge.mixed.search', 'knowledge.web.search', 'knowledge.markdown.search'] : ['knowledge.library.search', 'knowledge.library.save'];
    for (const tool of tools) await expect(f.gateway.execute(tool, tool.endsWith('.save') ? { runId: f.targetId } : { query: 'API', limit: 5 }, {
        scope: executionScope, runId: crypto.randomUUID(), agentId: 'native.knowledge-impact', allowedTools: [tool], idempotencyKey: crypto.randomUUID(), budget: new RunToolCallBudget(3),
    })).rejects.toThrow('local manual scope');
});

test('workspace HTTP callers cannot select the trusted schedule channel', async () => {
    const f = await fixture(), app = createWorkspaceApi(f.host, {} as LocalConnections, () => f.config);
    const response = await app.handle(new Request('http://localhost/api/workspace/runs', { method: 'POST', headers: { origin: 'http://localhost:15173', 'content-type': 'application/json' },
        body: JSON.stringify({ capability, input: f.input, triggerId: crypto.randomUUID(), triggerType: 'schedule' }) }));
    expect(response.status).toBe(400);
});
