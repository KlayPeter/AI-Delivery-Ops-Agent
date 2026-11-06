import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import { createKnowledgeWebPlugin } from '@/knowledge/web/plugin';
import { WebKnowledgeSource } from '@/knowledge/web/source';
import { knowledgeImpactPlugin, KNOWLEDGE_IMPACT_CAPABILITY } from '@/knowledge/impact/plugin';
import { knowledgeWebImpactPlugin } from '@/knowledge/impact/webPlugin';
import { KnowledgeImpactService, type ImpactReport } from '@/knowledge/impact/service';
import { versionInputSchema } from '@/knowledge/versions';
import type { ReleaseDraft } from '@/domains/release/evidence';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { KNOWLEDGE_MARKDOWN_VERSIONS_TOOL } from '@/knowledge/markdown/plugin';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const scope = { workspaceId: 'workspace-default', botInstanceId: 'bot-default' };
async function folder() { const root = await mkdtemp(path.join(tmpdir(), 'knowledge-impact-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }

async function seed(store: InMemoryPersistentKeyValueStore, hits: any[], options: { release?: boolean; legacy?: boolean; bot?: string } = {}) {
    const id = crypto.randomUUID(), now = new Date().toISOString(), runs = new PersistentAgentRunStore(store);
    const evidence = structuredClone(hits);
    if (options.legacy) for (const hit of evidence) { delete hit.sourceKey; delete hit.sourceKind; }
    const cited = evidence[0], ref = { citationId: cited.citationId, quote: cited.excerpt };
    const fact = { citationId: 'f'.repeat(64), documentVersion: 'e'.repeat(64), path: 'https://github.com/example/project/pull/1', excerpt: 'API migration notes are absent in this PR.', kind: 'pull_request' };
    const factRef = { citationId: fact.citationId, quote: fact.excerpt };
    const draft: ReleaseDraft = { entries: [{ number: 1, summary: 'API changes', citations: [factRef] }], findings: [{ kind: 'policy', severity: 'potential_blocker', text: 'Review migration notes', pullRequests: [1], issues: [], citations: [ref, factRef] }] };
    const content = options.release ? { status: 'needs_review', evidence: [...evidence.map((hit: any) => ({ ...hit, kind: 'knowledge' })), fact], draft }
        : { status: 'answered', evidence, claims: [{ text: 'A derived claim', citations: [ref] }] };
    await runs.create({ id, ...scope, botInstanceId: options.bot || scope.botInstanceId, agentInstallationId: 'fixture', capability: options.release ? 'release.prepare' : 'knowledge.answer',
        triggerId: `trigger-${id}`, correlationId: id, rootRunId: id, depth: 0, status: 'succeeded', createdAt: now });
    await runs.saveArtifacts([{ id: crypto.randomUUID(), runId: id, createdAt: now, type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content, metadata: { privateKnowledge: true } }]);
    return id;
}

async function fixture() {
    const root = await folder();
    await writeFile(path.join(root, 'Rule.md'), '# Release Rule\nAPI release requires migration notes.');
    await writeFile(path.join(root, 'Unused.md'), '# Release Preferences\nAPI release notification preferences.');
    const hits = (await new MarkdownKnowledgeSource({ root }).search('release API', 10)).hits;
    hits.sort((a, b) => (a.path === 'Rule.md' ? -1 : 1) - (b.path === 'Rule.md' ? -1 : 1));
    const store = new InMemoryPersistentKeyValueStore();
    const host = makeHost(store, root);
    return { root, hits, store, host, call: (ids: string[], operation = 'check') => check(host, ids, operation) };
}
function makeHost(store: InMemoryPersistentKeyValueStore, root: string, extraConfig = {}) {
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local impact' }, groups: [] } }) as any, 10, undefined, [], {
        plugins: [knowledgeImpactPlugin, knowledgeMarkdownPlugin], pluginConfig: { 'knowledge.markdown': { root, ...extraConfig } },
    });
    cleanup.push(() => host.stop()); return host;
}
async function check(host: AgentHost, runIds: string[], operation = 'check') {
    const input = { runIds, operation }, triggerScope = createTriggerScope({ ...scope, triggerType: 'manual', triggerId: crypto.randomUUID() });
    return host.dispatch(createTriggerEnvelope({ scope: triggerScope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), KNOWLEDGE_IMPACT_CAPABILITY, input);
}
const assessment = (result: any) => result.execution.result.data.assessments[0];

describe('knowledge version impact', () => {
    test('only actual cited documents affect an answer or release; original evidence stays immutable', async () => {
        const f = await fixture(), answer = await seed(f.store, f.hits), release = await seed(f.store, f.hits, { release: true });
        const runs = new PersistentAgentRunStore(f.store), original = await runs.listArtifacts(answer);
        const initial = assessment(await f.call([answer]));
        expect(initial.state).toBe('current'); expect(initial.references[0].quoteChecks).toEqual([{ quote: f.hits[0].excerpt, status: 'found' }]);
        await writeFile(path.join(f.root, 'Unused.md'), '# Release Preferences\nNotification rules changed.');
        expect(assessment(await f.call([answer])).state).toBe('current');
        await writeFile(path.join(f.root, 'Rule.md'), '# Release Rule\nAPI release requires migration notes.\n\nAn unrelated paragraph changed.');
        const outside = assessment(await f.call([answer])); expect(outside.state).toBe('needs_review'); expect(outside.references[0].quoteChecks[0].status).toBe('found');
        await writeFile(path.join(f.root, 'Rule.md'), '# Release Rule\nAPI release now requires human approval.');
        const changed = await f.call([answer, release]);
        expect((changed.execution!.result.data as any).assessments.map((item: any) => item.state)).toEqual(['needs_review', 'needs_review']);
        expect(assessment(changed).references[0].status).toBe('changed');
        expect(assessment(changed).references[0].quoteChecks[0].status).toBe('not_found');
        expect(await runs.listArtifacts(answer)).toEqual(original);
        expect(changed.execution!.result.metrics).toEqual({ modelCalls: 0, toolCalls: 1 });
    });

    test('a quote still present in a changed negative context never makes the result current', async () => {
        const f = await fixture(), id = await seed(f.store, f.hits), runs = new PersistentAgentRunStore(f.store);
        const artifacts = await runs.listArtifacts(id); (artifacts[0]!.content as any).claims[0].citations[0].quote = 'API release requires migration notes.';
        await runs.saveArtifacts(artifacts);
        await writeFile(path.join(f.root, 'Rule.md'), '# Release Rule\nIt is no longer true that API release requires migration notes.');
        const result = assessment(await f.call([id])); expect(result.state).toBe('needs_review'); expect(result.semanticImpact).toBe('not_assessed');
        expect(result.references[0].quoteChecks).toEqual([{ quote: 'API release requires migration notes.', status: 'found' }]);
    });

    test('rename/delete is missing; unreadable or excluded sources are not falsely treated as deleted', async () => {
        const f = await fixture(), id = await seed(f.store, f.hits);
        await rename(path.join(f.root, 'Rule.md'), path.join(f.root, 'Renamed.md'));
        expect(assessment(await f.call([id])).references[0].status).toBe('missing');
        await rename(path.join(f.root, 'Renamed.md'), path.join(f.root, 'Rule.md'));
        await writeFile(path.join(f.root, 'Rule.md'), Buffer.from([0xff]));
        expect(assessment(await f.call([id])).references[0].status).toBe('unavailable');
        expect(assessment(await check(makeHost(f.store, f.root, { exclude: ['Rule.md'] }), [id])).references[0].status).toBe('out_of_scope');
    });

    test('same relative name in another vault has a different identity and cannot verify old references', async () => {
        const f = await fixture(), other = await folder(), id = await seed(f.store, f.hits);
        await writeFile(path.join(other, 'Rule.md'), '# Release Rule\nAPI release requires migration notes.');
        const otherHit = (await new MarkdownKnowledgeSource({ root: other }).search('release')).hits[0]!;
        expect(otherHit.documentVersion).toBe(f.hits[0]!.documentVersion);
        expect(otherHit.sourceKey).not.toBe(f.hits[0]!.sourceKey);
        expect(otherHit.citationId).not.toBe(f.hits[0]!.citationId);
        const result = assessment(await check(makeHost(f.store, other), [id]));
        expect(result.state).toBe('unverifiable'); expect(result.references[0].status).toBe('out_of_scope');
    });

    test('supplied policies without actual citations do not become false dependencies', async () => {
        const f = await fixture(), id = await seed(f.store, f.hits, { release: true }), runs = new PersistentAgentRunStore(f.store);
        const artifacts = await runs.listArtifacts(id); (artifacts[0]!.content as any).draft.findings = [];
        await runs.saveArtifacts(artifacts); await rm(f.root, { recursive: true });
        const result = await f.call([id]);
        expect(assessment(result).state).toBe('not_applicable');
        expect(result.execution!.result.metrics?.toolCalls).toBe(0);
    });

    test('invalid stored quotes cannot be marked current even if the document version matches', async () => {
        const f = await fixture(), id = await seed(f.store, f.hits), runs = new PersistentAgentRunStore(f.store);
        const artifacts = await runs.listArtifacts(id); (artifacts[0]!.content as any).claims[0].citations[0].quote = 'Not in the supplied excerpt';
        await runs.saveArtifacts(artifacts);
        const result = assessment(await f.call([id]));
        expect(result.state).toBe('unverifiable'); expect(result.reason).toBe('unsupported_or_invalid_artifact');
    });

    test('legacy references, source failure and incomplete checks never produce a fresh-current marker', async () => {
        const f = await fixture(), legacy = await seed(f.store, f.hits, { legacy: true });
        expect(assessment(await f.call([legacy])).references[0].status).toBe('legacy_unverifiable');
        const id = await seed(f.store, f.hits);
        expect(assessment(await f.call([id])).state).toBe('current');
        await rm(f.root, { recursive: true });
        const failed = assessment(await f.call([id]));
        expect(failed.state).toBe('unverifiable'); expect(failed.reason).toBe('source_check_failed');
        const cached = assessment(await f.call([id], 'status'));
        expect(cached.state).toBe('unverifiable'); expect(cached.checkRunId).toBe(failed.checkRunId);
    });

    test('another Bot scope cannot read artifact evidence or create an assessment', async () => {
        const f = await fixture(), id = await seed(f.store, f.hits, { bot: 'another-bot' });
        expect((await f.call([id])).status).toBe('failed');
        expect(await f.store.listIdempotencyEntries('knowledge:impact:')).toEqual([]);
    });

    test('a source plugin cannot claim current with a mismatched hash or unrelated reference', async () => {
        const f = await fixture(), id = await seed(f.store, f.hits);
        for (const mode of ['wrong-hash', 'wrong-reference', 'wrong-quote', 'duplicate-quote', 'missing-quote', 'legacy']) {
            const badSource: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'knowledge.markdown', name: 'Fixture source', version: '1.0.0', description: 'Malformed source fixture' }, apply(ctx) {
                ctx.delivery.tools.register({ id: KNOWLEDGE_MARKDOWN_VERSIONS_TOOL, version: '1.0.0', description: 'Fixture', inputSchema: mode.includes('quote') ? versionInputSchema : { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 1 }, async (input: any) => ({ checkedAt: new Date().toISOString(), documents: input.documents.map(({ quotes, ...doc }: any) => ({ ...doc,
                    path: mode === 'wrong-reference' ? 'Unrequested.md' : doc.path, status: 'current', currentVersion: mode === 'wrong-hash' ? '0'.repeat(64) : doc.documentVersion,
                    ...(mode === 'wrong-quote' ? { quoteChecks: [{ quote: 'unrequested', status: 'found' }] } : mode === 'duplicate-quote' ? { quoteChecks: [0, 1].map(() => ({ quote: quotes[0], status: 'found' })) } : mode === 'missing-quote' ? { quoteChecks: [{ quote: quotes[0], status: 'not_found' }] } : {}),
                })) }));
            } };
            const host = new AgentHost(() => ({ store: f.store, config: { feishu: { bot_name: 'Protocol test' }, groups: [] } }) as any, 10, undefined, [], { plugins: [knowledgeImpactPlugin, badSource] });
            cleanup.push(() => host.stop());
            const result = assessment(await check(host, [id]));
            if (mode === 'legacy') { expect(result.state).toBe('current'); expect(result.references[0].quoteChecks).toBeUndefined(); }
            else expect(result).toMatchObject({ state: 'unverifiable', reason: mode === 'missing-quote' ? 'citation_quote_not_found' : 'source_check_failed' });
        }
    });

    test('a batch over the quote budget keeps all document checks and explicitly leaves excess quotes unchecked', async () => {
        const f = await fixture(), words = Array.from({ length: 32 }, (_, i) => `probe-${i}`), runs = new PersistentAgentRunStore(f.store), ids: string[] = [];
        for (let i = 0; i < 7; i++) {
            const filename = `Budget${i}.md`; await writeFile(path.join(f.root, filename), '# Budget\n' + words.join(' '));
            const hit = (await new MarkdownKnowledgeSource({ root: f.root }).search('Budget', 10)).hits.find(hit => hit.path === filename)!;
            const id = await seed(f.store, [hit]), artifacts = await runs.listArtifacts(id);
            (artifacts[0]!.content as any).claims = Array.from({ length: 8 }, (_, claim) => ({ text: 'Synthetic budget fixture', citations: words.slice(claim * 4, claim * 4 + 4).map(quote => ({ citationId: hit.citationId, quote })) }));
            await runs.saveArtifacts(artifacts); ids.push(id);
        }
        const result = await f.call(ids), reports = (result.execution!.result.data as any).assessments;
        expect(reports.every((report: any) => report.state === 'current')).toBe(true);
        expect(reports.map((report: any) => report.references[0].quoteChecks?.length || 0)).toEqual([32, 32, 32, 32, 32, 32, 0]);
        expect(result.execution!.result.metrics).toEqual({ modelCalls: 0, toolCalls: 1 });
    });

    test('an old concurrent check cannot overwrite a newer reservation or clear an unfinished check', async () => {
        const store = new InMemoryPersistentKeyValueStore(), service = new KnowledgeImpactService(store);
        const first = await service.begin(scope, 'target', 'old'), second = await service.begin(scope, 'target', 'new');
        const report: ImpactReport = { runId: 'target', checkRunId: 'new', artifactIds: [], checkedAt: new Date().toISOString(), state: 'not_applicable', references: [], semanticImpact: 'not_assessed' };
        expect(await service.finish(scope, report, second)).toBe(true);
        expect(await service.finish(scope, { ...report, checkRunId: 'old', state: 'needs_review' }, first)).toBe(false);
        expect((await service.latest(scope, 'target') as any).checkRunId).toBe('new');
        await service.begin(scope, 'target', 'interrupted');
        expect(await service.latest(scope, 'target')).toEqual({ runId: 'target', state: 'unverifiable', reason: 'check_incomplete', checkRunId: 'interrupted' });
        expect(await service.latest({ ...scope, workspaceId: 'another' }, 'target')).toEqual({ runId: 'target', state: 'unverifiable', reason: 'not_checked' });
    });

    test('web failures are unavailable and URL changes do not become fabricated deletions', async () => {
        let text = '# Release Rule\nAPI release requires migration notes.', fail = false;
        const url = 'https://example.com/rule';
        const load = async () => { if (fail) throw new Error('Fixture network failure'); return { url, body: Buffer.from(text), contentType: 'text/markdown' }; };
        const hits = (await new WebKnowledgeSource({ urls: [url] }, load).search('release')).hits;
        const store = new InMemoryPersistentKeyValueStore(), id = await seed(store, hits);
        const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Web impact' }, groups: [] } }) as any, 10, undefined, [], {
            plugins: [knowledgeWebImpactPlugin, createKnowledgeWebPlugin(load)], pluginConfig: { 'knowledge.web': { urls: [url] } },
        }); cleanup.push(() => host.stop());
        expect(assessment(await check(host, [id])).state).toBe('current');
        text += '\nA new rule.';
        expect(assessment(await check(host, [id])).state).toBe('needs_review');
        fail = true;
        expect(assessment(await check(host, [id])).references[0].status).toBe('unavailable');
    });

    test('real CLI calls preserve an answer across processes and check it without model credentials', async () => {
        const root = await folder(), file = path.join(root, 'Rule.md'), state = path.join(await folder(), 'runtime.sqlite');
        await writeFile(file, '# Release Rule\nAPI release requires migration notes.');
        let modelCalls = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            modelCalls++;
            const body = await request.json() as any, supplied = JSON.parse(body.messages.find((message: any) => message.role === 'user').content), hit = supplied.evidence[0];
            return Response.json({ id: 'impact-fixture', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ status: 'answered', claims: [{ text: 'Migration notes are required.', citations: [{ citationId: hit.citationId, quote: hit.excerpt }] }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
        } }); cleanup.push(() => server.stop(true));
        async function cli(args: string[], model = false) {
            const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../src/scripts/knowledge.ts`, '--root', root, '--state', state, ...args], {
                env: { ...process.env, KNOWLEDGE_API_BASE: model ? `${server.url}v1` : '', KNOWLEDGE_MODEL: model ? 'fixture' : '', KNOWLEDGE_API_KEY: model ? 'fixture-local-key' : '', KNOWLEDGE_PROVIDER: 'openai-compatible' }, stdout: 'pipe', stderr: 'pipe',
            });
            const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            expect(exit).toBe(0); expect(stderr).toContain('contains private'); return JSON.parse(stdout);
        }
        const answer = await cli(['--ask', 'release'], true);
        await writeFile(file, '# Release Rule\nAPI release now requires human approval.');
        const checked = await cli(['--check-run', answer.runId]);
        expect(checked.result.assessments[0].state).toBe('needs_review');
        await rm(root, { recursive: true });
        expect((await cli(['--check-run', answer.runId, '--impact-status'])).result.assessments[0].state).toBe('needs_review');
        expect(modelCalls).toBe(1);
    });
});
