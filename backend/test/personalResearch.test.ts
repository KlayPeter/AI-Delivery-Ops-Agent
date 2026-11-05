import { standardModelPlugins } from '@/platform/models/providers';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { knowledgeAnswerPlugin } from '@/knowledge/answer/plugin';
import { knowledgeImpactPlugin } from '@/knowledge/impact/plugin';
import { webCapturePlugin } from '@/knowledge/capture/plugin';
import { createPersonalResearchPlugin, RESEARCH_CAPABILITY } from '@/agents/personal-research/plugin';
import { RunCheckService } from '@/quality/service';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';

const disposers: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
type Mode = 'retrieve' | 'rag' | 'multi' | 'partial' | 'child-pause' | 'plain' | 'failed-child' | 'bad-citation' | 'empty-draft' | 'pause' | 'budget';

async function fixture(mode: Mode = 'retrieve', provider = 'openai-compatible') {
    const root = await mkdtemp(path.join(tmpdir(), 'personal-research-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const vault = path.join(root, 'vault'); await mkdir(vault, { mode: 0o700 });
    await writeFile(path.join(vault, 'Migration.md'), '# Migration\nAPI migration notes are mandatory before release.');
    await writeFile(path.join(vault, 'Unrelated.md'), '# Other\nUNSELECTED_RESEARCH_SENTINEL');
    const requests: any[] = []; let parentCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Not a fixture route', { status: 404 });
        const body = await request.json() as any; requests.push(body);
        const delegated = body.tools?.some((tool: any) => tool.function?.name === 'agent_knowledge_markdown_retrieve');
        let content: string | null = null, toolCalls: unknown[] | undefined;
        if (!delegated) {
            const supplied = JSON.parse(body.messages.find((message: any) => message.role === 'user').content);
            const hit = supplied.evidence[0];
            content = JSON.stringify({ status: 'answered', claims: [{ text: 'Migration notes are required before release.', citations: [{ citationId: mode === 'bad-citation' ? '0'.repeat(64) : hit.citationId, quote: hit.excerpt }] }] });
        } else {
            parentCalls++;
            if (mode !== 'plain' && (parentCalls === 1 || (mode === 'budget' && parentCalls === 3) || (['multi', 'partial'].includes(mode) && parentCalls === 2))) {
                const rag = mode === 'rag' || mode === 'bad-citation' || (mode === 'multi' && parentCalls === 2);
                toolCalls = [{ id: `lookup-${parentCalls}`, type: 'function', function: { name: rag ? 'agent_knowledge_answer' : 'agent_knowledge_markdown_retrieve',
                    arguments: JSON.stringify(rag ? { question: 'API migration', limit: 5 } : { operation: 'search', query: mode === 'failed-child' || (mode === 'partial' && parentCalls === 1) ? 'x'.repeat(501) : 'API migration', limit: 5 }) } }];
            } else if (['pause', 'budget'].includes(mode) && parentCalls === 2) {
                toolCalls = [{ id: 'clarification', type: 'function', function: { name: 'request_human_input', arguments: JSON.stringify({ question: '请确认整理格式', fields: ['format'] }) } }];
            } else content = mode === 'empty-draft' ? '' : '模型整理\n\n本机模拟模型演示：请结合保存的原文资料核对 API migration 要求。';
        }
        return Response.json({ id: `chatcmpl-${requests.length}`, object: 'chat.completion', created: 0, model: 'local-research-fixture',
            choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    } });
    disposers.push(() => server.stop(true));
    const store = new InMemoryPersistentKeyValueStore();
    const research = createPersonalResearchPlugin();
    if (mode === 'budget') research.agents = research.agents!.map(agent => ({ ...agent, manifest: { ...agent.manifest, limits: { ...agent.manifest.limits, maxAgentCalls: 1 } } }));
    const config = { ...buildConfig({}), data_path: path.join(root, 'data'), ai: { provider, model: 'local-research-fixture', api_key: provider === 'ollama' ? '' : 'local-fixture-key', api_base: `${server.url}v1` } };
    const source = mode === 'child-pause' ? { ...knowledgeMarkdownPlugin, apply(ctx: Parameters<typeof knowledgeMarkdownPlugin.apply>[0]) {
        const agent = knowledgeMarkdownPlugin.agents![0]!.manifest;
        ctx.delivery.nativeAgents.register(agent.id, agent.version, async () => ({ status: 'needs_human', data: { question: 'Choose a source' }, artifacts: [] }));
    } } : knowledgeMarkdownPlugin;
    const host = new AgentHost(() => ({ config, store, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: [...standardModelPlugins, research, source, knowledgeAnswerPlugin, knowledgeImpactPlugin, webCapturePlugin],
        pluginConfig: { 'knowledge.markdown': { root: vault, sourceId: 'research-vault' } },
    });
    disposers.push(() => host.stop());
    return { host, requests, store, async call(scopePatch = {}) {
        const input = { prompt: 'Research API migration', source: 'private' };
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: randomUUID(), ...scopePatch });
        return host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), RESEARCH_CAPABILITY, input);
    } };
}

for (const mode of ['retrieve', 'rag'] as const) test(`research ${mode} uses the real model SDK, bounded child execution and saved evidence`, async () => {
    const f = await fixture(mode), result = await f.call();
    expect(result.execution?.run.status).toBe('succeeded');
    const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
    expect(details.children).toHaveLength(1);
    expect(details.children[0]?.status).toBe('succeeded');
    expect(details.steps.some(step => step.name.startsWith('delegate:'))).toBe(true);
    expect(details.steps.filter(step => step.kind === 'model')).toHaveLength(2);
    const index = details.artifacts.find(artifact => (artifact.content as any)?.schemaVersion === 'research-evidence/1.0')!;
    expect(index).toBeDefined();
    expect((index.content as any).evidence[0].runId).toBe(details.children[0]!.id);
    expect((index.content as any).summaryVerification).toBe('not_verified');
    const summary = details.artifacts.find(artifact => artifact.type === 'markdown')!;
    expect(summary.metadata).toMatchObject({ privateKnowledge: true, semanticSupport: 'not_verified' });
    expect(JSON.stringify(f.requests)).not.toContain('UNSELECTED_RESEARCH_SENTINEL');
    const report = await new RunCheckService(f.store, f.host.checks).check(createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: randomUUID() }), { contractId: 'personal.research.evidence', runId: result.execution!.run.id }, new AbortController().signal);
    expect(report.current.verdict).toBe('passed');
    if (mode === 'rag') {
        const child = (await f.host.getLocalRunDetails(details.children[0]!.id))!;
        expect((child.artifacts[0]?.content as any).verification.citationIdentityAndQuotePresence).toBe('checked');
        expect(f.requests).toHaveLength(3);
    }
    expect(f.host.web.pages().some(page => page.path === '/research')).toBe(true);
    await f.host.stop(); expect(f.host.web.pages()).toEqual([]); expect(f.host.checks.list()).toEqual([]);
});

test('compound research retains both retrieval and verified-answer artifacts in separate child runs', async () => {
    const f = await fixture('multi'), result = await f.call();
    expect(result.execution?.run.status).toBe('succeeded');
    const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
    expect(details.children.map(run => run.capability)).toEqual(['knowledge.markdown.retrieve', 'knowledge.answer']);
    expect((details.artifacts.find(artifact => artifact.metadata.artifactRole === 'personal.research.evidence')?.content as any).evidence).toHaveLength(2);
    expect(details.artifacts.filter(artifact => artifact.type === 'json')).toHaveLength(3);
    expect(details.steps.filter(step => step.name.startsWith('delegate:'))).toHaveLength(2);
});

test('partial research retains failed child facts and marks its source coverage for review', async () => {
    const f = await fixture('partial'), result = await f.call();
    expect(result.execution?.run.status).toBe('succeeded');
    const index = result.execution?.artifacts.find(artifact => artifact.metadata?.artifactRole === 'personal.research.evidence')!;
    expect(index.content).toMatchObject({ coverage: 'partial', failures: [{ capability: 'knowledge.markdown.retrieve', status: 'failed' }] });
    expect((index.metadata?.statusPanels as any)[0].tone).toBe('warning');
});

test('a waiting child cannot be bypassed by the parent model returning a completed draft', async () => {
    const f = await fixture('child-pause'), result = await f.call();
    expect(result.execution?.run.status).toBe('failed'); expect(result.execution?.run.error?.code).toBe('RESEARCH_CHILD_PENDING');
    expect(result.execution?.artifacts).toEqual([]);
});

for (const mode of ['plain', 'failed-child', 'bad-citation'] as const) test(`research rejects ${mode} completion without a successful saved source`, async () => {
    const f = await fixture(mode), result = await f.call();
    expect(result.execution?.run.status).toBe('failed');
    expect(result.execution?.run.error?.code).toBe('RESEARCH_EVIDENCE_REQUIRED');
    expect(result.execution?.artifacts).toEqual([]);
    if (mode !== 'plain') expect((await f.host.getLocalRunDetails(result.execution!.run.id))?.children.every(run => run.status === 'failed')).toBe(true);
});

test('research checks personal scope before creating a model request or session', async () => {
    const f = await fixture(), result = await f.call({ chatId: 'unapproved-group' });
    expect(result.execution?.run.status).toBe('failed'); expect(f.requests).toEqual([]);
    expect((await f.host.getLocalRunDetails(result.execution!.run.id))?.children).toEqual([]);
});

test('research cannot deliver an empty draft even after successful retrieval', async () => {
    const f = await fixture('empty-draft'), result = await f.call();
    expect(result.execution?.run.status).toBe('failed'); expect(result.execution?.artifacts).toEqual([]);
    expect((await f.host.getLocalRunDetails(result.execution!.run.id))?.children[0]?.status).toBe('succeeded');
});

test('human continuation reuses the original run and its actual saved child evidence', async () => {
    const f = await fixture('pause'), first = await f.call();
    expect(first.execution?.run.status).toBe('waiting_human');
    expect(first.execution?.artifacts.find(artifact => artifact.metadata.waitingHuman)?.metadata.privateKnowledge).toBe(true);
    const resumed = await f.host.resumeLocal(first.execution!.run.id, { prompt: 'continue with a concise format', text: 'continue with a concise format' }, randomUUID());
    expect(resumed.execution?.run.id).toBe(first.execution!.run.id); expect(resumed.execution?.run.status).toBe('succeeded');
    const report = resumed.execution?.artifacts.find(artifact => (artifact.content as any)?.schemaVersion === 'research-evidence/1.0')!;
    expect((report.content as any).evidence).toHaveLength(1);
});

test('human continuation cannot reset the durable Agent delegation budget', async () => {
    const f = await fixture('budget'), first = await f.call();
    expect(first.execution?.run.status).toBe('waiting_human');
    const resumed = await f.host.resumeLocal(first.execution!.run.id, { prompt: 'continue', text: 'continue' }, randomUUID());
    const details = (await f.host.getLocalRunDetails(resumed.execution!.run.id))!;
    expect(details.children).toHaveLength(1);
    expect(JSON.stringify(f.requests)).toContain('Agent call limit exceeded');
});

test('artifact selectors retain child evidence while rejecting malformed or duplicated research indexes', async () => {
    const f = await fixture(), result = await f.call();
    const runs = new PersistentAgentRunStore(f.store), runId = result.execution!.run.id;
    const artifacts = await runs.listArtifacts(runId), index = artifacts.find(artifact => artifact.metadata.artifactRole === 'personal.research.evidence')!;
    const service = new RunCheckService(f.store, f.host.checks), input = { contractId: 'personal.research.evidence', runId };
    const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
    await runs.saveArtifacts([{ ...index, content: { ...(index.content as any), evidence: [] } }]);
    expect((await service.check(scope, input)).current.verdict).toBe('failed');
    await runs.saveArtifacts([index, { ...index, id: randomUUID() }]);
    const duplicated = await service.check(scope, input);
    expect(duplicated.current.assertions.find(item => item.id === 'artifact:evidence-index')?.message).toContain('实际 2 个');
    const own = createPersonalResearchPlugin();
    expect(() => f.host.checks.register(own, { ...own.checks![0]!, id: 'personal.research.invalid-selector', artifacts: [{ id: 'bad', type: 'json', schema: { type: 'object' }, selector: { $ref: '#/missing' } }] })).toThrow('Invalid result check JSON Schema');
});

test('keyless Ollama can delegate research and persist actual child evidence', async () => {
    const f = await fixture('rag', 'ollama'), result = await f.call();
    expect(result.execution?.run.status).toBe('succeeded');
    const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
    expect(details.children).toHaveLength(1); expect(details.children[0]?.status).toBe('succeeded');
    expect(details.artifacts.some(artifact => artifact.metadata.artifactRole === 'personal.research.evidence')).toBe(true);
    expect(f.requests).toHaveLength(3);
});
