import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { createGitHubPlugin } from '@/connectors/github/plugin';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { createKnowledgeWebPlugin } from '@/knowledge/web/plugin';
import { releasePlugin, RELEASE_PREPARE_CAPABILITY } from '@/domains/release/plugin';
import { webReleasePlugin } from '@/domains/release/webPlugin';
import { renderReleaseDraft, renderReleaseCollection, type ReleaseDraft } from '@/domains/release/evidence';
import { statusPanelSchema } from '@/platform/plugins/runActions';
import { githubFixture, repository, window, pr } from './helpers/github';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
type Mode = 'valid' | 'no-findings' | 'unknown-pr' | 'omitted-pr' | 'forged-quote' | 'wrong-pr-citation' | 'policy-without-note' | 'invalid-json' | 'provider-failure';
async function fixture(mode: Mode = 'valid', web = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'release-preparation-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const policy = '# Release policy\nAPI changes require migration notes before release.';
    await writeFile(path.join(root, 'Release.md'), policy);
    await writeFile(path.join(root, 'Other.md'), '# Other\nUNSELECTED_PRIVATE_SENTINEL');
    const github = githubFixture(), modelRequests: any[] = [];
    let onModel: (() => Promise<void>) | undefined;
    const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        expect(request.method).toBe('POST'); expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
        const body = await request.json() as any; modelRequests.push(body);
        await onModel?.();
        if (mode === 'provider-failure') return Response.json({ error: { message: 'Fixture provider failure', type: 'invalid_request_error' } }, { status: 400 });
        const input = JSON.parse(body.messages.find((message: any) => message.role === 'user').content);
        const prs = input.evidence.filter((item: any) => item.kind === 'pull_request'), notes = input.evidence.find((item: any) => item.kind === 'knowledge');
        const ref = (item: any) => ({ citationId: item.citationId, quote: item.excerpt.slice(0, 200) });
        const draft: ReleaseDraft = { entries: prs.map((item: any) => ({ number: item.number, summary: 'Update the public API.', citations: [ref(item)] })),
            findings: [{ kind: 'policy', severity: 'potential_blocker', text: 'Confirm migration notes against the release policy.', pullRequests: [prs[0].number], issues: [], citations: [ref(prs[0]), ref(notes)] }] };
        if (mode === 'unknown-pr') draft.entries[0].number = 999;
        if (mode === 'omitted-pr') draft.entries = [];
        if (mode === 'forged-quote') draft.entries[0].citations[0].quote = 'Invented evidence absent from source.';
        if (mode === 'wrong-pr-citation') draft.entries[0].citations = [ref(input.evidence.find((item: any) => item.kind === 'issue'))];
        if (mode === 'policy-without-note') draft.findings[0].citations = [ref(prs[0])];
        if (mode === 'no-findings') draft.findings = [];
        return Response.json({ id: 'release-fixture', object: 'chat.completion', created: 0, model: 'fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: mode === 'invalid-json' ? 'not JSON' : JSON.stringify(draft) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } });
    } });
    cleanup.push(() => model.stop(true));
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Release test' }, groups: [], ai: {
        provider: 'openai-compatible', model: 'fixture', api_key: 'fixture-local-key', api_base: `${model.url}v1`,
    } } }) as any, 10, undefined, [], {
        plugins: [web ? webReleasePlugin : releasePlugin, createGitHubPlugin(github), web ? createKnowledgeWebPlugin(async () => ({ url: 'https://example.com/policy', body: Buffer.from(policy), contentType: 'text/markdown' })) : knowledgeMarkdownPlugin],
        pluginConfig: { 'connector.github': { repository, maxPages: 1 }, [web ? 'knowledge.web' : 'knowledge.markdown']: web ? { urls: ['https://example.com/policy'] } : { root, vaultName: 'Private Vault' } },
    });
    cleanup.push(() => host.stop());
    const call = (input: Record<string, unknown> = {}, id: string = crypto.randomUUID(), scopePatch = {}) => {
        const payload = { ...window, policyQuery: 'release API', ...input };
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: id, ...scopePatch });
        return host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload, replyPolicy: { mode: 'none' } }), RELEASE_PREPARE_CAPABILITY, payload);
    };
    return { root, store, host, github, modelRequests, call, onModel: (handler: () => Promise<void>) => { onModel = handler; } };
}

describe('knowledge-backed release preparation', () => {
    test('combines actual Tool results and the real model SDK into a versioned, reviewable draft', async () => {
        const f = await fixture(), original = await readFile(path.join(f.root, 'Release.md'), 'utf8');
        const result = await f.call({}, 'release-first');
        expect(result.status).not.toBe('failed');
        const data = result.execution!.result.data as any;
        expect(data).toMatchObject({ status: 'needs_review', requiresHumanReview: true, verification: { citationIdentityAndQuotePresence: 'checked', prCoverage: 'checked', semanticSupport: 'not_verified' } });
        expect(data.draft.entries).toHaveLength(1);
        expect(data.draft.findings[0].citations).toHaveLength(2);
        expect(data.markdown).toContain(`https://github.com/${repository}/pull/1`);
        expect(data.evidence.find((item: any) => item.kind === 'knowledge').documentVersion).toHaveLength(64);
        const sent = JSON.stringify(f.modelRequests[0]);
        expect(sent).not.toContain('UNSELECTED_PRIVATE_SENTINEL'); expect(sent).not.toContain('obsidian://'); expect(sent).not.toContain('Release.md');
        expect(f.modelRequests[0].tools || []).toEqual([]);
        const runs = new PersistentAgentRunStore(f.store), steps = await runs.listSteps(result.execution!.run.id);
        expect(steps.filter(step => step.kind === 'tool').map(step => step.name).sort()).toEqual(['github.repository.snapshot', 'knowledge.markdown.search'].sort());
        expect(steps.some(step => step.kind === 'model' && step.status === 'succeeded')).toBe(true);
        expect((await runs.listArtifacts(result.execution!.run.id)).map(item => item.type).sort()).toEqual(['json', 'markdown']);
        expect((await f.call({}, 'release-first')).status).toBe('duplicate');
        expect(f.github.calls).toHaveLength(3); expect(f.modelRequests).toHaveLength(1);
        expect(await readFile(path.join(f.root, 'Release.md'), 'utf8')).toBe(original);
        expect(f.github.calls.every(call => call.init?.method === 'GET')).toBe(true);
    });

    for (const mode of ['unknown-pr', 'omitted-pr', 'forged-quote', 'wrong-pr-citation', 'policy-without-note', 'invalid-json', 'provider-failure'] as const) {
        test(`refuses ${mode} without publishing a draft artifact`, async () => {
            const f = await fixture(mode), result = await f.call();
            expect(result.status).toBe('failed');
            const runs = new PersistentAgentRunStore(f.store);
            expect(await runs.listArtifacts(result.claim.runId!)).toEqual([]);
            expect((await runs.listSteps(result.claim.runId!)).some(step => step.kind === 'model' && step.status === 'failed')).toBe(true);
        });
    }

    test('collect mode reads evidence without a model and missing knowledge or PRs remains explicit', async () => {
        const f = await fixture();
        const result = (await f.call({ operation: 'collect' })).execution!;
        expect(result.result.data).toMatchObject({ status: 'evidence_only', requiresHumanReview: true });
        const panel = (result.artifacts.find(artifact => artifact.type === 'json')!.metadata!.statusPanels as unknown[])[0];
        expect(statusPanelSchema.parse(panel)).toMatchObject({ title: '证据已收集', tone: 'neutral' });
        const markdown = result.artifacts.find(artifact => artifact.type === 'markdown')!.content as string;
        expect(markdown).toContain('本轮没有生成发布草稿');
        expect(markdown).toContain('API changes require migration notes');
        expect(markdown).toContain(`https://github.com/${repository}/pull/1`);
        expect(markdown).toContain('分页已读完');
        expect(f.modelRequests).toHaveLength(0);
        expect((await f.call({ policyQuery: 'missingpolicy849zz' })).execution!.result.data).toMatchObject({ status: 'insufficient_evidence' });
        f.github.state.pulls = [];
        expect((await f.call()).execution!.result.data).toMatchObject({ status: 'insufficient_evidence' });
        expect(f.modelRequests).toHaveLength(0);
    });

    test('a draft without findings still requires human review and performs no GitHub writes', async () => {
        const f = await fixture('no-findings'), data = (await f.call()).execution!.result.data as any;
        expect(data.status).toBe('draft'); expect(data.requiresHumanReview).toBe(true);
        expect(data.verification.semanticSupport).toBe('not_verified');
        expect(f.github.calls.every(call => call.init?.method === 'GET')).toBe(true);
    });

    test('coverage and text truncation are visible to the model and force review', async () => {
        const f = await fixture();
        f.github.state.nextPullPage = true;
        f.github.state.pulls = [pr(1, { body: 'a'.repeat(3001) })];
        const data = (await f.call()).execution!.result.data as any;
        expect(data.status).toBe('needs_review'); expect(data.warnings.length).toBeGreaterThan(1);
        const sent = JSON.parse(f.modelRequests[0].messages.find((message: any) => message.role === 'user').content);
        expect(sent.evidence.find((item: any) => item.kind === 'pull_request').truncated).toBe(true);
        expect(sent.coverage.pullRequests.exhausted).toBe(false);
    });

    test('context beyond budget returns evidence for review rather than silently omitting PRs', async () => {
        const f = await fixture(); f.github.state.pulls = Array.from({ length: 30 }, (_, index) => pr(index + 1, { body: 'x'.repeat(2000) }));
        const data = (await f.call()).execution!.result.data as any;
        expect(data.status).toBe('needs_review');
        expect(data.facts.pullRequests).toHaveLength(30); expect(data.draft).toBeUndefined(); expect(f.modelRequests).toHaveLength(0);
    });

    test('keeps the actual policy version when the underlying note changes during generation', async () => {
        const f = await fixture();
        f.onModel(async () => { await writeFile(path.join(f.root, 'Release.md'), '# Release policy\nAPI changes require a human review before release.'); });
        const first = (await f.call()).execution!.result.data as any;
        f.onModel(async () => {});
        const second = (await f.call()).execution!.result.data as any;
        const note = (data: any) => data.evidence.find((item: any) => item.kind === 'knowledge');
        expect(note(first).excerpt).toContain('migration notes'); expect(note(second).excerpt).toContain('human review');
        expect(note(first).documentVersion).not.toBe(note(second).documentVersion);
    });

    test('rejects chat scopes and source failures without producing false empty facts', async () => {
        const f = await fixture();
        expect((await f.call({}, 'chat', { chatId: 'group' })).status).toBe('failed'); expect(f.github.calls).toHaveLength(0);
        f.github.state.override = () => new Response('', { status: 401 });
        const failed = await f.call(); expect(failed.status).toBe('failed');
        expect(await new PersistentAgentRunStore(f.store).listArtifacts(failed.claim.runId!)).toEqual([]);
        expect(f.modelRequests).toHaveLength(0);
    });

    test('web policy composition uses the same release implementation and preserves extracted-text metadata', async () => {
        const f = await fixture('valid', true), data = (await f.call()).execution!.result.data as any;
        expect(data.status).toBe('needs_review');
        expect(data.evidence.find((item: any) => item.kind === 'knowledge')).toMatchObject({ sourceKind: 'web', lineBasis: 'extracted_text' });
        expect(JSON.stringify(f.modelRequests[0])).not.toContain('https://example.com/policy');
        for (const profile of ['release-demo.yaml', 'release-web-demo.yaml']) {
            const selection = await loadPluginConfiguration(`${import.meta.dir}/../profiles/agents/${profile}`);
            expect(selection.plugins.map(plugin => plugin.manifest.id)).toContain('release.prepare');
            expect(selection.plugins).toHaveLength(3);
        }
    });

    test('CLI requires explicit model settings and refuses ambiguous source configuration before IO', async () => {
        const f = await fixture();
        for (const args of [[], ['--url', 'https://example.com/']]) {
            const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../src/scripts/release.ts`, '--repository', repository, '--since', window.since, '--root', f.root, ...args], {
                env: { ...process.env, KNOWLEDGE_API_BASE: '', KNOWLEDGE_API_KEY: '', KNOWLEDGE_MODEL: '', AI_API_KEY: 'unused-fixture' }, stdout: 'pipe', stderr: 'pipe',
            });
            const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            expect(exit).toBe(1); expect(stdout).toBe(''); expect(stderr).toContain(args.length ? 'Choose exactly one source' : 'Release preparation requires KNOWLEDGE_API_BASE');
        }
    });

    test('exported Markdown treats model HTML and heading syntax as text', async () => {
        const f = await fixture(), data = (await f.call()).execution!.result.data as any;
        data.draft.entries[0].summary = '<script>alert(1)</script>\n# injected heading';
        const markdown = renderReleaseDraft(data.facts, data.draft, data.evidence, []);
        expect(markdown).not.toContain('<script>');
        expect(markdown).not.toContain('\n# injected heading');
        expect(markdown).toContain('&lt;script&gt;');
        data.facts.pullRequests[0].title = '<script>bad</script>\n# injected heading';
        const collection = renderReleaseCollection(data.facts, data.evidence, ['<img src=x>']);
        expect(collection).not.toContain('<script>'); expect(collection).not.toContain('<img');
        expect(collection).not.toContain('\n# injected heading');
    });
});
