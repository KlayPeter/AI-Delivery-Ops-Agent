import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { createPluginApi } from '@/platform/workspace/api';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import { knowledgeImpactPlugin } from '@/knowledge/impact/plugin';
import { KnowledgeImpactService } from '@/knowledge/impact/service';
import type { AgentRun } from '@/platform/agents/contracts';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'knowledge-reviews-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'Rules.md'), '# Rules\nAPI requires migration notes.');
    await writeFile(path.join(root, 'Rollback.md'), '# Rollback\nAPI requires rollback steps.');
    const hits = (await new MarkdownKnowledgeSource({ root }).search('API', 10)).hits;
    const store = new InMemoryPersistentKeyValueStore(), runs = new PersistentAgentRunStore(store);
    const context = () => ({ store, config: { feishu: { bot_name: 'Review fixture' }, groups: [] } } as any);
    const host = new AgentHost(context, 100, undefined, [], { plugins: [knowledgeMarkdownPlugin, knowledgeImpactPlugin], pluginConfig: { 'knowledge.markdown': { root } } });
    cleanup.push(() => host.stop()); await host.initialize();
    const app = createPluginApi(host);
    const request = (ids: string[], extra = '', origin = 'http://localhost:15173') => app.handle(new Request(`http://localhost/api/knowledge-impact/reviews?${new URLSearchParams(ids.map(id => ['runId', id]))}${extra}`, { headers: { origin } }));
    async function seed(index = 0, patch: Partial<AgentRun> = {}, content?: unknown) {
        const id = crypto.randomUUID(), now = new Date().toISOString(), hit = hits[index]!;
        await runs.create({ id, ...scope, rootRunId: id, agentInstallationId: 'fixture', capability: 'knowledge.answer', triggerId: id, correlationId: id, depth: 0, status: 'succeeded', createdAt: now, ...patch });
        await runs.saveArtifacts([{ id: crypto.randomUUID(), runId: id, type: 'json', createdAt: now, mediaType: 'application/json', schemaVersion: '1.0', metadata: { privateKnowledge: true },
            content: content || { status: 'answered', evidence: [hit], claims: [{ text: 'Fixture answer', citations: [{ citationId: hit.citationId, quote: hit.excerpt }] }] } }]);
        return id;
    }
    return { root, hits, store, runs, context, host, request, seed };
}

test('review listing is a read-only snapshot; explicit bulk checking records separate results for changed and unchanged citations', async () => {
    const f = await fixture(), first = await f.seed(0), second = await f.seed(1), ids = [first, second];
    const originals = await Promise.all(ids.map(id => f.runs.listArtifacts(id)));
    const before = await f.store.listIdempotencyEntries('');
    const listed = await (await f.request(ids)).json() as any;
    expect(listed.reviews.map((review: any) => review.assessment.reason)).toEqual(['not_checked', 'not_checked']);
    expect(listed.reviews[0]).toMatchObject({ id: first, canCheck: true, references: [{ path: f.hits[0]!.path, sourceKind: 'markdown' }] });
    expect(JSON.stringify(listed)).not.toContain('Fixture answer');
    expect(JSON.stringify(listed)).not.toContain('migration notes.');
    expect(await f.store.listIdempotencyEntries('')).toEqual(before);
    await writeFile(path.join(f.root, f.hits[0]!.path), '# Changed\nAPI now requires human review.');
    expect((await (await f.request(ids)).json() as any).reviews[0].assessment.reason).toBe('not_checked');
    const result = await f.host.runLocal('knowledge.impact.check', { runIds: ids }, crypto.randomUUID());
    expect(result.execution!.run.status).toBe('succeeded');
    expect(result.execution!.result.metrics).toEqual({ modelCalls: 0, toolCalls: 1 });
    const checked = (await (await f.request(ids)).json() as any).reviews;
    expect(checked.map((review: any) => review.assessment.state)).toEqual(['needs_review', 'current']);
    expect(checked.every((review: any) => review.assessment.checkRunId === result.execution!.run.id && Boolean(review.assessment.checkedAt))).toBe(true);
    await rm(f.root, { recursive: true, force: true });
    expect((await (await f.request(ids)).json() as any).reviews).toEqual(checked);
    expect(await Promise.all(ids.map(id => f.runs.listArtifacts(id)))).toEqual(originals);
});

test('the whole batch must belong to the local workspace and bot before any artifacts are read', async () => {
    const f = await fixture(), owned = await f.seed(), foreign = await f.seed(0, { botInstanceId: 'foreign-bot' }), foreignWorkspace = await f.seed(0, { workspaceId: 'foreign-workspace' });
    const reads = spyOn(f.store, 'listIdempotencyEntries');
    try {
        for (const id of [foreign, foreignWorkspace, crypto.randomUUID()]) {
            reads.mockClear();
            const response = await f.request([owned, id]);
            expect(response.status).toBe(400);
            expect(reads.mock.calls.some(([prefix]) => prefix.startsWith('agent:artifact:'))).toBe(false);
            expect(JSON.stringify(await response.json())).not.toContain('Rules.md');
        }
    } finally { reads.mockRestore(); }
});

test('empty, unsupported and malformed original results cannot inherit a green cached assessment', async () => {
    const f = await fixture();
    const empty = await f.seed(0, {}, { status: 'insufficient_evidence', evidence: [], claims: [] });
    const invalid = await f.seed(0, {}, { status: 'answered', evidence: [], claims: [{ citations: [{ citationId: 'a'.repeat(64), quote: 'forged' }] }] });
    const unsupported = await f.seed(0, { capability: 'example.echo' });
    const failed = await f.seed(0, { status: 'failed' });
    const reviews = (await (await f.request([empty, invalid, unsupported, failed])).json() as any).reviews;
    expect(reviews.map((review: any) => review.canCheck)).toEqual([false, false, false, false]);
    expect(reviews[0].assessment).toMatchObject({ state: 'not_applicable', reason: 'no_cited_knowledge' });
    expect(reviews.slice(1).map((review: any) => review.assessment.state)).toEqual(['unverifiable', 'unverifiable', 'unverifiable']);
    const checked = await f.host.runLocal('knowledge.impact.check', { runIds: [empty] }, crypto.randomUUID());
    expect((await (await f.request([empty])).json() as any).reviews[0].assessment).toMatchObject({ state: 'not_applicable', checkRunId: checked.execution!.run.id });
});

test('unfinished and invalid cached assessments remain unknown, including a valid report stored under the wrong target', async () => {
    const f = await fixture(), id = await f.seed(), service = new KnowledgeImpactService(f.store);
    await service.begin(scope, id, 'pending');
    expect((await (await f.request([id])).json() as any).reviews[0].assessment).toMatchObject({ state: 'unverifiable', reason: 'check_incomplete', checkRunId: 'pending' });
    const entry = (await f.store.listIdempotencyEntries('knowledge:impact:'))[0]!;
    for (const report of [
        { runId: id, state: 'current' },
        { runId: id, state: 'current', checkedAt: new Date().toISOString(), checkRunId: 'fixture', references: [{ path: 'Rules.md', documentVersion: 'a'.repeat(64), currentVersion: 'b'.repeat(64), status: 'changed' }] },
        { runId: 'another-target', state: 'current', checkedAt: new Date().toISOString(), checkRunId: 'other-check', references: [{ path: 'Rules.md', documentVersion: 'a'.repeat(64), status: 'current' }] },
    ]) {
        await f.store.setIdempotencyKey(entry.key, { revision: 1, phase: 'complete', checkRunId: 'fixture', report });
        expect((await (await f.request([id])).json() as any).reviews[0]).toMatchObject({ canCheck: true, assessment: { state: 'unverifiable', reason: 'invalid_assessment' } });
    }
});

test('review API enforces request bounds, local origin and plugin ownership', async () => {
    const f = await fixture(), id = await f.seed();
    expect((await f.request([])).status).toBe(200);
    expect((await f.request([id, id])).status).toBe(400);
    expect((await f.request(Array.from({ length: 51 }, () => crypto.randomUUID()))).status).toBe(400);
    expect((await f.request([id], '&workspaceId=other')).status).toBe(400);
    expect((await f.request([], 'x'.repeat(15001))).status).toBe(413);
    expect((await f.request([id], '', 'https://foreign.example')).status).toBe(403);
    expect(f.host.web.pages()).toContainEqual({ path: '/knowledge-reviews', label: '知识复核', section: 'workspace', view: { kind: 'builtin', id: 'knowledge-reviews', capability: 'knowledge.impact.check' } });
    const absent = new AgentHost(f.context); cleanup.push(() => absent.stop());
    expect((await absent.handlePluginRequest(new Request('http://localhost/api/knowledge-impact/reviews'))).status).toBe(404);
    expect(absent.web.pages()).toEqual([]);
});
