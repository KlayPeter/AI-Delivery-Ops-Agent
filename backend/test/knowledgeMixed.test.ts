import { mixedReleasePlugin } from '@/knowledge/mixed/releasePlugin';
import { createGitHubPlugin } from '@/connectors/github/plugin';
import { githubFixture, repository, window } from './helpers/github';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfig } from '@/core/config';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { standardModelPlugins } from '@/platform/models/providers';
import { RunToolCallBudget } from '@/platform/tools/budget';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { createKnowledgeWebPlugin } from '@/knowledge/web/plugin';
import { knowledgeMixedPlugin, mixedSourcePort, MIXED_CAPABILITY } from '@/knowledge/mixed/plugin';
import { knowledgeMixedAnswerPlugin } from '@/knowledge/mixed/answerPlugin';
import { knowledgeMixedImpactPlugin } from '@/knowledge/mixed/impactPlugin';
import { createKnowledgeWorkspacePlugin } from '@/knowledge/workspace/plugin';
import { createPersonalResearchPlugin } from '@/agents/personal-research/plugin';
import { webCapturePlugin } from '@/knowledge/capture/plugin';
import { createWorkspaceApi } from '@/platform/workspace/api';
import { LocalConnections } from '@/platform/workspace/connections';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const url = 'https://example.com/api-policy';
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-mixed-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const vault = path.join(directory, 'vault'); await Bun.write(path.join(vault, 'Policy.md'), '# Team API\nAPI releases require a human reviewer.');
    await writeFile(path.join(vault, 'Other.md'), '# Other\nUNSELECTED_MIXED_SENTINEL');
    let webText = '# Online API\nPublic API clients require a migration guide.', webFails = false, webCalls = 0, parentCalls = 0;
    const requests: any[] = [];
    const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
        const body = await request.json() as any; requests.push(body);
        const parent = body.tools?.some((tool: any) => tool.function?.name === 'agent_knowledge_mixed_retrieve');
        let content: string | null, tool_calls: unknown[] | undefined;
        if (parent) {
            parentCalls++;
            if (parentCalls === 1) { content = null; tool_calls = [{ id: 'mixed-lookup', type: 'function', function: { name: 'agent_knowledge_mixed_retrieve', arguments: JSON.stringify({ operation: 'search', query: 'API', limit: 5 }) } }]; }
            else content = '模型整理：本机协议模拟结果，请分别复核笔记规则与网页资料。';
        } else {
            const supplied = JSON.parse(body.messages.find((message: any) => message.role === 'user').content);
            content = JSON.stringify({ status: 'answered', claims: supplied.evidence.map((hit: any) => ({ text: hit.excerpt, citations: [{ citationId: hit.citationId, quote: hit.excerpt }] })) });
        }
        return Response.json({ id: 'mixed-fixture', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    } });
    cleanup.push(() => model.stop(true));
    const github = githubFixture();
    let gateway!: PluginHostServices['toolGateway'];
    const store = new InMemoryPersistentKeyValueStore();
    const config = { ...buildConfig({}), data_path: path.join(directory, 'data'), ai: { ...buildConfig({}).ai, provider: 'ollama', model: 'fixture', api_key: '', api_base: `${model.url}v1` } };
    const actual = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: [mixedReleasePlugin, createGitHubPlugin(github), ...standardModelPlugins, knowledgeMarkdownPlugin, createKnowledgeWebPlugin(async () => {
            webCalls++; if (webFails) throw new Error('Private fixture failure path must not reach generation');
            return { url, body: Buffer.from(webText), contentType: 'text/markdown' };
        }), knowledgeMixedPlugin, knowledgeMixedAnswerPlugin, knowledgeMixedImpactPlugin, createKnowledgeWorkspacePlugin('mixed'), webCapturePlugin, createPersonalResearchPlugin('mixed'),
        { manifest: { apiVersion: '1.0', id: 'example.capture-gateway', name: 'Test gateway', version: '1.0.0', description: 'Capture the trusted SDK port' }, apply(ctx) { gateway = ctx.delivery.toolGateway; } }],
        pluginConfig: { 'connector.github': { repository }, 'knowledge.markdown': { root: vault, sourceId: 'test-notes', vaultName: 'Fixture Vault' }, 'knowledge.web': { urls: [url], sourceId: 'test-web' } },
    });
    cleanup.push(() => actual.stop()); await actual.initialize();
    return { host: actual, store, gateway, directory, vault, requests, webCalls: () => webCalls, setWeb: (text: string) => { webText = text; }, failWeb: () => { webFails = true; },
        search: (limit = 5) => actual.runLocal(MIXED_CAPABILITY, { operation: 'search', query: 'API', limit }, crypto.randomUUID()),
        answer: () => actual.runLocal('knowledge.answer', { question: 'API', limit: 5 }, crypto.randomUUID()),
        review: (runId: string) => actual.runLocal('knowledge.impact.check', { runIds: [runId], operation: 'check' }, crypto.randomUUID()),
    };
}

test('mixed retrieval interleaves both real source plugins, preserves identity and records three governed calls', async () => {
    const f = await fixture(), result = await f.search();
    expect(result.execution?.run.status).toBe('succeeded');
    const data = result.execution!.result.data as any;
    expect(data.hits.map((hit: any) => hit.sourceKind)).toEqual(['markdown', 'web']);
    expect(data.hits[0].openUri).toStartWith('obsidian://open'); expect(data.hits[1].openUri).toBe(url);
    expect(data.hits[0].citationId).not.toBe(data.hits[1].citationId);
    expect(data.source).toMatchObject({ partial: false, indexed: 3, sources: [{ kind: 'markdown', status: 'available' }, { kind: 'web', status: 'available' }] });
    expect(result.execution!.result.metrics).toMatchObject({ toolCalls: 3, modelCalls: 0 });
    const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
    expect(details.steps.filter(step => step.kind === 'tool').map(step => step.name).sort()).toEqual(['knowledge.markdown.search', 'knowledge.mixed.search', 'knowledge.web.search']);
    expect((await f.search(1)).execution!.result.data).toMatchObject({ hits: [data.hits[0]] });
    for (const kind of ['markdown', 'web']) {
        const original = (await f.host.runLocal(`knowledge.${kind}.retrieve`, { operation: 'search', query: 'API', limit: 5 }, crypto.randomUUID())).execution!.result.data as any;
        const hit = data.hits.find((item: any) => item.sourceKind === kind);
        for (const key of ['citationId', 'sourceKey', 'documentVersion', 'path']) expect(hit[key]).toBe(original.hits[0][key]);
    }
    expect(f.requests).toHaveLength(0);
});

test('mixed RAG uses the real SDK, checks both origins and does not disclose unrelated notes or configuration', async () => {
    const f = await fixture(), answer = await f.answer();
    expect(answer.execution?.run.status).toBe('succeeded');
    const data = answer.execution!.result.data as any;
    expect(data.claims).toHaveLength(2); expect(data.evidence.map((hit: any) => hit.sourceKind)).toEqual(['markdown', 'web']);
    expect(data.verification.citationIdentityAndQuotePresence).toBe('checked'); expect(data.verification.semanticSupport).toBe('not_verified');
    expect(data.retrieval.sources).toHaveLength(2); expect(answer.execution!.result.metrics?.toolCalls).toBe(3);
    const sent = JSON.stringify(f.requests);
    for (const omitted of ['UNSELECTED_MIXED_SENTINEL', 'obsidian://', 'Policy.md', url, f.vault]) expect(sent).not.toContain(omitted);
    expect((await f.review(answer.execution!.run.id)).execution!.result.data).toMatchObject({ assessments: [{ state: 'current', references: [{ sourceKind: 'markdown', status: 'current' }, { sourceKind: 'web', status: 'current' }] }] });
});

test('historical checks independently detect changed notes and webpages without modifying the original answer', async () => {
    const f = await fixture(), answer = await f.answer(), id = answer.execution!.run.id;
    const before = JSON.stringify((await f.host.getLocalRunDetails(id))!.artifacts);
    await writeFile(path.join(f.vault, 'Policy.md'), '# Team API\nAPI policy now requires two human reviewers.');
    f.setWeb('# Online API\nPublic API policy now requires a rollback guide.');
    const result = await f.review(id), report = (result.execution!.result.data as any).assessments[0];
    expect(report.state).toBe('needs_review'); expect(report.references.map((ref: any) => ref.status)).toEqual(['changed', 'changed']);
    expect(report.references.map((ref: any) => ref.quoteChecks[0].status)).toEqual(['not_found', 'not_found']);
    expect(result.execution!.result.metrics?.toolCalls).toBe(3);
    expect(JSON.stringify((await f.host.getLocalRunDetails(id))!.artifacts)).toBe(before);
});

test('one failed source is partial in retrieval and RAG, and an unavailable webpage is never reported current', async () => {
    const f = await fixture(), answer = await f.answer(); f.failWeb();
    const search = await f.search(), data = search.execution!.result.data as any;
    expect(search.execution?.run.status).toBe('succeeded'); expect(data.source.partial).toBe(true);
    expect(data.source.sources[1]).toMatchObject({ kind: 'web', status: 'unavailable' }); expect(data.hits).toHaveLength(1);
    const partial = await f.answer(); expect((partial.execution!.result.data as any).retrieval.partial).toBe(true);
    expect(JSON.stringify(f.requests.at(-1))).toContain('partialIndex'); expect(JSON.stringify(f.requests.at(-1))).not.toContain('Private fixture failure');
    const check = (await f.review(answer.execution!.run.id)).execution!.result.data as any;
    expect(check.assessments[0]).toMatchObject({ state: 'unverifiable', references: [{ status: 'current' }, { status: 'unavailable' }] });
});

test('both sources failing is an error, and missing sources fail during dependency assembly', async () => {
    const f = await fixture(); f.failWeb(); await rm(f.vault, { recursive: true });
    const result = await f.search(); expect(result.execution?.run.status).toBe('failed'); expect(result.execution?.artifacts).toEqual([]); expect(f.requests).toHaveLength(0);
    const missing = new AgentHost(() => ({ store: f.store, config: buildConfig({}), feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [knowledgeMixedPlugin] });
    try { await expect(missing.initialize()).rejects.toThrow('knowledge.markdown'); } finally { await missing.stop(); }
});

test('scope and input validation precede upstream reads, and insufficient shared budgets are not replenished', async () => {
    const f = await fixture(), before = f.webCalls();
    const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: crypto.randomUUID(), conversationId: 'chat' });
    const input = { operation: 'search', query: 'API', limit: 5 };
    const result = await f.host.dispatch(createTriggerEnvelope({ scope, payload: input, occurredAt: new Date().toISOString(), replyPolicy: { mode: 'none' } }), MIXED_CAPABILITY, input);
    expect(result.execution?.run.status).toBe('failed');
    expect((await f.host.runLocal(MIXED_CAPABILITY, { ...input, limit: 11 }, crypto.randomUUID())).status).toBe('failed');
    expect((await f.host.runLocal(MIXED_CAPABILITY, { ...input, root: '/unapproved/path' }, crypto.randomUUID())).status).toBe('failed');
    expect(f.webCalls()).toBe(before);
    const personal = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: crypto.randomUUID() });
    const budget = new RunToolCallBudget(2);
    await expect(f.gateway.execute(mixedSourcePort.searchTool, { query: 'API', limit: 5 }, { scope: { ...personal, agentInstallationId: 'install-knowledge-mixed', correlationId: crypto.randomUUID() }, runId: crypto.randomUUID(), agentId: 'native.knowledge-mixed', signal: new AbortController().signal,
        allowedTools: [mixedSourcePort.searchTool], budget })).rejects.toMatchObject({ code: 'TOOL_CALL_LIMIT_EXCEEDED' });
    expect(budget.used).toBe(2); expect(f.webCalls()).toBe(before);
});

test('research delegates to the mixed source and saves a genuine child index; workspace metadata selects the same source', async () => {
    const f = await fixture();
    const result = await f.host.runLocal('personal.research', { prompt: 'Research API rules', source: 'private' }, crypto.randomUUID());
    expect(result.execution?.run.status).toBe('succeeded');
    const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
    expect(details.children).toHaveLength(1); expect(details.children[0]?.capability).toBe(MIXED_CAPABILITY);
    expect(details.artifacts.some(artifact => artifact.metadata.artifactRole === 'personal.research.evidence')).toBe(true);
    const settings = new LocalConnections(path.join(f.directory, 'connections.json'));
    const config = buildConfig({}), app = createWorkspaceApi(f.host, settings, () => config);
    expect(await (await app.handle(new Request('http://localhost/api/workspace/state'))).json()).toMatchObject({ knowledgeKind: 'mixed' });
    expect(await (await f.host.handlePluginRequest(new Request('http://localhost/api/knowledge-workspace'))).json()).toEqual({ kind: 'mixed', pluginId: 'knowledge.mixed', capability: MIXED_CAPABILITY });
    await f.host.stop(); expect(f.host.canDispatch(MIXED_CAPABILITY)).toBe(false); expect(f.host.web.pages()).toEqual([]);
});

test('release collection includes personal notes and public policies with one shared four-call budget', async () => {
    const f = await fixture();
    const result = await f.host.runLocal('release.prepare', { ...window, operation: 'collect', policyQuery: 'API', limit: 5 }, crypto.randomUUID());
    expect(result.execution?.run.status).toBe('succeeded'); expect(result.execution!.result.metrics?.toolCalls).toBe(4);
    const data = result.execution!.result.data as any;
    expect(data.status).toBe('evidence_only'); expect(data.evidence.filter((item: any) => item.kind === 'knowledge').map((item: any) => item.sourceKind)).toEqual(['markdown', 'web']);
    expect(data.knowledge.source.sources).toHaveLength(2); expect(f.requests).toHaveLength(0);
});

test('source disappearance reports missing notes and unavailable pages while preserving prior citations', async () => {
    const f = await fixture(), answer = await f.answer();
    await rm(path.join(f.vault, 'Policy.md')); f.failWeb();
    const report = ((await f.review(answer.execution!.run.id)).execution!.result.data as any).assessments[0];
    expect(report).toMatchObject({ state: 'needs_review', references: [{ sourceKind: 'markdown', status: 'missing' }, { sourceKind: 'web', status: 'unavailable' }] });
});
