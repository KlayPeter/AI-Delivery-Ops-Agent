import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { createTriggerEnvelope, createTriggerScope, createExecutionScope } from '@/platform/runtime/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { selectEvidence } from '@/knowledge/answer/evidence';
import { createKnowledgeWebPlugin } from '@/knowledge/web/plugin';
import knowledgeMixedPlugin from '@/knowledge/mixed/plugin';
import { createKnowledgeWritebackPlugin, WRITEBACK_CAPABILITY } from '@/knowledge/writeback/plugin';

const answer: AgentManifest = { schemaVersion: '1.1', id: 'fixture.cited-answer', name: 'Cited fixture', version: '1.0.0', description: 'Deterministic test evidence, no model', runtime: { type: 'native' }, capabilities: ['knowledge.answer'], triggers: ['manual'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, requirements: { tools: ['knowledge.markdown.search'], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 10, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 512 * 1024 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false } };
const sourceFixtureFor = (searchTool = 'knowledge.markdown.search'): FeaturePlugin => ({ manifest: { apiVersion: '1.0', id: 'fixture.cited-answer', name: 'Fixture', version: '1.0.0', description: 'actual source evidence' }, agents: [{ manifest: { ...answer, limits: { ...answer.limits, maxToolCalls: 3, maxSteps: 4 }, requirements: { ...answer.requirements, tools: [searchTool] } }, installationId: 'fixture-answer' }], apply(ctx) {
    ctx.delivery.nativeAgents.register(answer.id, answer.version, async (request, _resolved, signal) => {
        const budget = new RunToolCallBudget(3);
        const data = await ctx.delivery.toolGateway.execute(searchTool, { query: 'API', limit: 5 }, { runId: request.runId, agentId: answer.id, scope: request.scope, signal, allowedTools: [searchTool], budget }) as any;
        const evidence = selectEvidence(data.hits);
        const content = { status: 'answered', evidence, claims: evidence.map(hit => ({ text: 'API 发布需要迁移说明。', citations: [{ citationId: hit.citationId, quote: hit.excerpt }] })) };
        return { status: 'succeeded', data: content, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content, metadata: { privateKnowledge: true } }] };
    });
} });
const sourceFixture = sourceFixtureFor();
let root: string, vault: string, inbox: string, store: InMemoryPersistentKeyValueStore, host: AgentHost;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'knowledge-writeback-')); vault = path.join(root, 'vault'); inbox = path.join(vault, 'Agent Inbox'); await mkdir(inbox, { recursive: true, mode: 0o700 });
    await writeFile(path.join(vault, 'Rules.md'), '# API 发布规则\n\nAPI 发布必须提供迁移说明。\n'); store = new InMemoryPersistentKeyValueStore();
    host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'fixture', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [knowledgeMarkdownPlugin, sourceFixture, createKnowledgeWritebackPlugin()], pluginConfig: { 'knowledge.markdown': { root: vault, sourceId: 'test-vault' }, 'knowledge.writeback': { outputRoot: inbox } } });
});
afterEach(async () => { await host.stop(); await rm(root, { recursive: true, force: true }); });
async function sourceRun() { const result = await host.runLocal('knowledge.answer', {}, randomUUID()); expect(result.execution?.run.status).toBe('succeeded'); return result.execution!.run.id; }
async function preview(id = '') {
    const result = await host.runLocal(WRITEBACK_CAPABILITY, { operation: 'prepare', sourceRunId: id || await sourceRun(), title: '我的 API 发布笔记', markdown: '# 发布检查\n\n发布时补齐迁移说明。' }, randomUUID());
    expect(result.execution?.run.error).toBeUndefined(); expect(result.execution?.run.status).toBe('succeeded'); return { result, ...(result.execution!.result.data as any) };
}
const confirmation = (proposal: any) => ({ operation: 'apply', proposalId: proposal.id, reviewedSha256: proposal.approvalSha256, confirmed: true });
const apply = (proposal: any, extra = {}) => host.runLocal(WRITEBACK_CAPABILITY, { ...confirmation(proposal), ...extra }, randomUUID());

test('preview writes no note, produces an applicable patch, and explicit approval creates exactly the reviewed indexed file', async () => {
    const id = await sourceRun(), original = await readFile(path.join(vault, 'Rules.md'));
    const p = await preview(id); expect(await readdir(inbox)).toEqual([]); expect(p.proposal.state).toBe('draft');
    expect(p.result.execution.result.metrics).toEqual({ modelCalls: 0, toolCalls: 2 });
    expect((await (await host.web.handle(new Request(`http://localhost/api/knowledge-writeback/proposal?proposalId=${p.proposal.id}`))).json()).patch).toBe(p.patch);
    expect(p.patch).toContain('--- /dev/null'); expect(p.proposal.content).toContain('semanticSupport'); expect(p.proposal.content).toContain(id);
    const patches = path.join(root, 'patch-check'); await mkdir(patches);
    const checked = Bun.spawnSync(['git', 'apply', '--check', '-'], { cwd: patches, stdin: Buffer.from(p.patch) }); expect(checked.exitCode).toBe(0);
    expect(Bun.spawnSync(['git', 'apply', '-'], { cwd: patches, stdin: Buffer.from(p.patch) }).exitCode).toBe(0); expect(await readFile(path.join(patches, p.proposal.filename), 'utf8')).toBe(p.proposal.content);
    const saved = await apply(p.proposal); expect(saved.execution?.run.status).toBe('succeeded');
    const receipt = (saved.execution!.result.data as any).proposal; expect(receipt.state).toBe('saved'); expect(receipt.savedAt).toBeTruthy();
    expect(await readFile(path.join(inbox, receipt.filename), 'utf8')).toBe(p.proposal.content); expect((await stat(path.join(inbox, receipt.filename))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(vault, 'Rules.md'))).toEqual(original);
    const repeat = await Promise.all([apply(p.proposal), apply(p.proposal)]); expect(repeat.every(value => value.execution?.run.status === 'succeeded')).toBe(true); expect(await readdir(inbox)).toEqual([receipt.filename]);
    const search = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: '发布检查', limit: 5 }, randomUUID()); expect((search.execution!.result.data as any).hits.some((hit: any) => hit.path === `Agent Inbox/${receipt.filename}`)).toBe(true);
    const details = await host.getLocalRunDetails(saved.execution!.run.id); expect(details!.steps.map(step => step.kind).sort()).toEqual(['agent', 'tool', 'tool']);
    const listing = await (await host.web.handle(new Request('http://localhost/api/knowledge-writeback/proposals'))).json(); expect(listing.proposals).toHaveLength(1); expect(listing.proposals[0].content).toBeUndefined();
    await host.stop(); expect(host.web.pages()).toEqual([]); expect(host.toolRegistry.list()).toEqual([]); expect(await store.getIdempotencyValue(`agent:run:${id}`)).toMatchObject({ status: 'succeeded' });
});

test('edited, missing, unreadable and moved source references reject approval without creating notes', async () => {
    const p = await preview();
    for (const mode of ['changed', 'missing', 'invalid']) {
        if (mode === 'changed') await writeFile(path.join(vault, 'Rules.md'), '# API\n\n规则已改变。');
        if (mode === 'missing') await rm(path.join(vault, 'Rules.md'));
        if (mode === 'invalid') await writeFile(path.join(vault, 'Rules.md'), Buffer.from([255]));
        const rejected = await apply(p.proposal); expect(rejected.execution?.run.status).toBe('failed'); expect(rejected.execution?.artifacts).toEqual([]); expect(await readdir(inbox)).toEqual([]);
    }
    await writeFile(path.join(vault, 'Rules.md'), '# API 发布规则\n\nAPI 发布必须提供迁移说明。\n');
    await rename(inbox, path.join(vault, 'Old Inbox')); await mkdir(inbox);
    expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); expect(await readdir(inbox)).toEqual([]);
});

test('approval binds content hash and original evidence; false confirmation, extra paths and mutated records fail closed', async () => {
    const p = await preview();
    for (const extra of [{ reviewedSha256: 'a'.repeat(64) }, { confirmed: false }, { filename: '../Rules.md' }, { outputRoot: '/tmp' }]) expect((await apply(p.proposal, extra)).execution?.run.status).toBe('failed');
    const entries = await store.listIdempotencyEntries<any>('knowledge%3Awriteback:'); const entry = entries.find(value => value.value.id === p.proposal.id)!;
    await store.setIdempotencyKey(entry.key, { ...entry.value, content: 'tampered' }); expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); await store.setIdempotencyKey(entry.key, entry.value);
    const artifacts = await store.listIdempotencyEntries<any>(`agent:artifact:${p.proposal.sourceRunId}:`); await store.setIdempotencyKey(artifacts[0]!.key, { ...artifacts[0]!.value, content: { ...artifacts[0]!.value.content, claims: [{ text: 'changed claim', citations: artifacts[0]!.value.content.claims[0].citations }] } });
    expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); expect(await readdir(inbox)).toEqual([]);
});

test('preexisting files and symlinks cannot be overwritten; saved notes are never silently recreated or changed', async () => {
    const p = await preview(), target = path.join(inbox, p.proposal.filename), outside = path.join(root, 'outside.md');
    await writeFile(outside, 'keep'); await symlink(outside, target); expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); expect(await readFile(outside, 'utf8')).toBe('keep'); await rm(target);
    await writeFile(target, 'existing'); expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); expect(await readFile(target, 'utf8')).toBe('existing'); await rm(target);
    const saved = await apply(p.proposal); expect(saved.execution?.run.status).toBe('succeeded');
    await link(target, path.join(root, 'hardlink.md')); expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); await rm(path.join(root, 'hardlink.md'));
    await writeFile(target, 'manual edit'); expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); expect(await readFile(target, 'utf8')).toBe('manual edit');
    await rm(target); expect((await apply(p.proposal)).execution?.run.status).toBe('failed'); expect(await readdir(inbox)).toEqual([]);
});

test('a failed final receipt is recoverable after restart without duplicating or overwriting the created note', async () => {
    const p = await preview(); const cas = store.compareAndSetIdempotencyKey.bind(store);
    store.compareAndSetIdempotencyKey = async (key, before, after) => key.startsWith('knowledge%3Awriteback:') && (after as any).state === 'saved' ? false : cas(key, before, after);
    const uncertain = await apply(p.proposal); expect(uncertain.execution?.run.status).toBe('failed'); expect(await readdir(inbox)).toEqual([p.proposal.filename]);
    store.compareAndSetIdempotencyKey = cas;
    await host.stop(); host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'fixture', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [knowledgeMarkdownPlugin, sourceFixture, createKnowledgeWritebackPlugin()], pluginConfig: { 'knowledge.markdown': { root: vault, sourceId: 'test-vault' }, 'knowledge.writeback': { outputRoot: inbox } } });
    await writeFile(path.join(vault, 'Rules.md'), '# changed after original creation');
    const recovered = await apply(p.proposal); expect(recovered.execution?.run.status).toBe('succeeded'); expect((recovered.execution!.result.data as any).proposal.state).toBe('saved'); expect(await readdir(inbox)).toEqual([p.proposal.filename]); expect(await readFile(path.join(inbox, p.proposal.filename), 'utf8')).toBe(p.proposal.content);
});

test('scope, local manual intent, shared budget, API bounds and source ownership are checked before writing', async () => {
    const p = await preview(), key = `agent:run:${p.proposal.sourceRunId}`, original = await store.getIdempotencyValue<any>(key);
    for (const patch of [{ workspaceId: 'other' }, { botInstanceId: 'other' }, { parentRunId: randomUUID() }, { status: 'failed' }]) {
        await store.setIdempotencyKey(key, { ...original, ...patch }); expect((await apply(p.proposal)).execution?.run.status).toBe('failed');
    }
    await store.setIdempotencyKey(key, original);
    const scope = createExecutionScope(createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: 'fixture' }), 'install-knowledge-writeback');
    for (const changed of [{ ...scope, triggerType: 'agent' as const }, { ...scope, chatId: 'group' }]) await expect(host['toolGateway']!.execute('knowledge.note.create', confirmation(p.proposal), { scope: changed, runId: randomUUID(), agentId: 'native.knowledge-writeback', allowedTools: ['knowledge.note.create'], idempotencyKey: randomUUID(), budget: new RunToolCallBudget(2) })).rejects.toThrow();
    await expect(host['toolGateway']!.execute('knowledge.note.create', confirmation(p.proposal), { scope, runId: randomUUID(), agentId: 'native.knowledge-writeback', allowedTools: ['knowledge.note.create'], idempotencyKey: randomUUID(), budget: new RunToolCallBudget(1) })).rejects.toMatchObject({ code: 'TOOL_CALL_LIMIT_EXCEEDED' });
    const trigger = createTriggerEnvelope({ scope: createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'agent', triggerId: randomUUID() }), occurredAt: new Date().toISOString(), payload: confirmation(p.proposal), replyPolicy: { mode: 'none' } }); expect((await host.dispatch(trigger, WRITEBACK_CAPABILITY, confirmation(p.proposal))).execution?.run.status).toBe('failed');
    for (const suffix of ['source?runId=invalid', `proposal?proposalId=${p.proposal.id}&extra=x`, `source?runId=${p.proposal.sourceRunId}&runId=${p.proposal.sourceRunId}`]) expect((await host.web.handle(new Request('http://localhost/api/knowledge-writeback/' + suffix))).status).toBe(400);
    expect(await readdir(inbox)).toEqual([]);
});

for (const kind of ['web', 'mixed'] as const) test(`${kind} writeback checks actual selected source versions through a shared budget`, async () => {
    await host.stop();
    const web = createKnowledgeWebPlugin(async () => ({ url: 'https://example.com/policy', body: Buffer.from('# API policy\nAPI 发布必须提供迁移说明。'), contentType: 'text/markdown' }));
    host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'fixture', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: [...(kind === 'mixed' ? [knowledgeMarkdownPlugin, knowledgeMixedPlugin] : []), web, sourceFixtureFor(`knowledge.${kind}.search`), createKnowledgeWritebackPlugin({ pluginId: `knowledge.${kind}`, versionsTool: `knowledge.${kind}.versions`, kind })],
        pluginConfig: { 'knowledge.markdown': { root: vault, sourceId: 'test-vault' }, 'knowledge.web': { urls: ['https://example.com/policy'], sourceId: 'test-web' }, 'knowledge.writeback': { outputRoot: inbox } },
    });
    const p = await preview(); expect(p.proposal.references.some((value: any) => value.sourceKind === 'web')).toBe(true);
    if (kind === 'mixed') expect(p.proposal.references.some((value: any) => value.sourceKind === 'markdown')).toBe(true);
    const result = await apply(p.proposal); expect(result.execution?.run.status).toBe('succeeded'); expect(result.execution?.result.metrics).toEqual({ modelCalls: 0, toolCalls: kind === 'mixed' ? 4 : 2 });
    expect(await readdir(inbox)).toEqual([p.proposal.filename]);
});

test('authored Markdown whitespace is preserved and invalid or oversized proposals do not create files', async () => {
    const sourceRunId = await sourceRun();
    for (const markdown of ['   ', 'x'.repeat(64 * 1024 + 1), '\u0000bad', '\ud800']) {
        const run = await host.runLocal(WRITEBACK_CAPABILITY, { operation: 'prepare', sourceRunId, title: 'draft', markdown }, randomUUID()); expect(run.execution?.run.status).toBe('failed');
    }
    const markdown = '    console.log("keep indent");\n\n';
    const run = await host.runLocal(WRITEBACK_CAPABILITY, { operation: 'prepare', sourceRunId, title: 'code note', markdown }, randomUUID());
    expect(run.execution?.run.status).toBe('succeeded'); expect((run.execution!.result.data as any).proposal.content).toContain('\n---\n\n' + markdown + '\n\n---'); expect(await readdir(inbox)).toEqual([]);
});
