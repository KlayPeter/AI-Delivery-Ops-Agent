import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { KNOWLEDGE_ANSWER_CAPABILITY } from '@/knowledge/answer/plugin';
import { verifyDraft, selectEvidence, type EvidenceHit } from '@/knowledge/answer/evidence';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

type Mode = 'valid' | 'echo-evidence' | 'unknown-id' | 'wrong-quote' | 'invalid-json' | 'provider-failure' | 'abstain';
async function fixture(mode: Mode = 'valid', provider = 'openai-compatible') {
    const root = await mkdtemp(path.join(tmpdir(), 'knowledge-answer-test-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'Migration.md'), '# Migration\nAPI migration notes are mandatory before release.');
    await writeFile(path.join(root, 'Unrelated.md'), '# Other\nUNSELECTED_NOTE_SENTINEL');
    const requests: any[] = [];
    let onRequest: (() => Promise<void>) | undefined;
    const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(request) {
            if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Unexpected fixture route', { status: 404 });
            const body = await request.json() as any;
            requests.push(body);
            await onRequest?.();
            if (mode === 'provider-failure') return Response.json({ error: { message: 'Fixture provider failure', type: 'invalid_request_error' } }, { status: 400 });
            const content = body.messages.find((message: any) => message.role === 'user').content;
            const supplied = JSON.parse(typeof content === 'string' ? content : content.map((part: any) => part.text || '').join(''));
            const hit = supplied.evidence[0];
            const draft = mode === 'abstain' ? { status: 'insufficient_evidence', reason: 'These excerpts do not establish the requested decision.' }
                : { status: 'answered', claims: [{ text: mode === 'echo-evidence' ? hit.excerpt : 'Migration notes are required before release.', citations: [{
                    citationId: mode === 'unknown-id' ? '0'.repeat(64) : hit.citationId,
                    quote: mode === 'wrong-quote' ? 'This sentence was never in the source.' : hit.excerpt,
                }] }] };
            return Response.json({
                id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: 'fixture-model',
                choices: [{ index: 0, message: { role: 'assistant', content: mode === 'invalid-json' ? 'not JSON' : JSON.stringify(draft) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            });
        },
    });
    cleanup.push(() => server.stop(true));
    const selection = await loadPluginConfiguration(`${import.meta.dir}/../profiles/agents/knowledge-answer-demo.yaml`);
    const store = new InMemoryPersistentKeyValueStore();
    const ai = { provider, model: 'fixture-model', api_key: provider === 'ollama' ? '' : 'fixture-local-key', api_base: `${server.url}v1` };
    const ctx: any = { store, config: { feishu: { bot_name: 'Local test' }, groups: [], ai } };
    const host = new AgentHost(() => ctx, 10, undefined, [], { plugins: selection.plugins,
        pluginConfig: { ...selection.config, 'knowledge.markdown': { root, sourceId: 'test-vault', vaultName: 'Private Vault Name' } } });
    cleanup.push(() => host.stop());
    async function call(question = 'API migration', id: string = crypto.randomUUID(), extra: Record<string, string> = {}) {
        const input = { question };
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: id, ...extra });
        return host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), KNOWLEDGE_ANSWER_CAPABILITY, input);
    }
    return { root, host, store, requests, ai, call, selection, setMode: (next: Mode) => { mode = next; }, setOnRequest: (callback: () => Promise<void>) => { onRequest = callback; } };
}

const prepare = async (host: AgentHost, runId: string) => {
    const response = await host.handlePluginRequest(new Request(`http://localhost/api/knowledge-answer/reanswer/${runId}`));
    expect(response.status).toBe(200); return await response.json() as any;
};
const reanswer = (preview: any) => ({ question: preview.question, limit: preview.limit, reanswer: { runId: preview.runId, artifactHash: preview.artifactHash, contextHash: preview.contextHash, confirmed: true } });

describe('reviewed reanswer', () => {
    test('uses current evidence in a new root, preserves the original and reuses one receipt on duplicate submission', async () => {
        const f = await fixture('echo-evidence'), original = (await f.call()).execution!;
        const runs = new PersistentAgentRunStore(f.store), before = { run: await runs.get(original.run.id), steps: await runs.listSteps(original.run.id), artifacts: await runs.listArtifacts(original.run.id) };
        const preview = await prepare(f.host, original.run.id); expect(preview.question).toBe('API migration'); expect(f.requests).toHaveLength(1);
        await writeFile(path.join(f.root, 'Migration.md'), '# Migration\nAPI migration needs a written handoff.');
        const input = reanswer(preview), triggerId = crypto.randomUUID();
        const result = await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, input, triggerId), updated = result.execution!;
        expect(updated.run.status).toBe('succeeded'); expect(updated.run.parentRunId).toBeUndefined(); expect(updated.run.id).not.toBe(original.run.id);
        const data = updated.result.data as any;
        expect(updated.artifacts[0]!.metadata.reusableInput).toBe(false);
        expect(data.reanswerOf).toEqual({ runId: original.run.id, artifactId: preview.artifactId, artifactHash: preview.artifactHash });
        expect(data.claims[0].text).toContain('written handoff'); expect(data.evidence[0].documentVersion).not.toBe((original.result.data as any).evidence[0].documentVersion);
        expect(updated.result.metrics).toMatchObject({ modelCalls: 1, toolCalls: 1 }); expect(f.requests).toHaveLength(2);
        const sent = JSON.stringify(f.requests[1]);
        for (const omitted of [original.run.id, preview.artifactHash, preview.contextHash, 'mandatory before release']) expect(sent).not.toContain(omitted);
        expect((await runs.listSteps(updated.run.id)).find(step => step.name === 'knowledge.answer.reanswer.review')?.metadata).toMatchObject({ reanswerOf: data.reanswerOf });
        const repeated = await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, input, triggerId);
        expect(repeated.claim.runId).toBe(updated.run.id); expect(f.requests).toHaveLength(2);
        expect({ run: await runs.get(original.run.id), steps: await runs.listSteps(original.run.id), artifacts: await runs.listArtifacts(original.run.id) }).toEqual(before);
    });

    test('requires confirmation and matching source/question/context before any retrieval or model call', async () => {
        const f = await fixture(), original = (await f.call()).execution!, preview = await prepare(f.host, original.run.id), input = reanswer(preview);
        const variants = [
            { ...input, reanswer: { ...input.reanswer, confirmed: false } }, { ...input, question: 'A different question' },
            { ...input, reanswer: { ...input.reanswer, artifactHash: '0'.repeat(64) } }, { ...input, reanswer: { ...input.reanswer, contextHash: '0'.repeat(64) } },
        ];
        const runs = new PersistentAgentRunStore(f.store);
        for (const invalid of variants) {
            const result = await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, invalid, crypto.randomUUID());
            expect(result.execution!.run.status).toBe('failed'); expect((await runs.listSteps(result.execution!.run.id)).filter(step => step.kind === 'tool')).toEqual([]);
        }
        const artifacts = await runs.listArtifacts(original.run.id); (artifacts[0]!.content as any).question = 'Modified stored question'; await runs.saveArtifacts(artifacts);
        expect((await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, input, crypto.randomUUID())).execution!.run.status).toBe('failed');
        expect(f.requests).toHaveLength(1);
    });

    test('preparation is local and scope-bound, redacts model credentials and invalidates approval after configuration changes', async () => {
        const f = await fixture(), original = (await f.call()).execution!, preview = await prepare(f.host, original.run.id);
        const foreign = await f.host.handlePluginRequest(new Request(`http://localhost/api/knowledge-answer/reanswer/${original.run.id}`, { headers: { origin: 'https://foreign.example' } })); expect(foreign.status).toBe(403);
        const runs = new PersistentAgentRunStore(f.store), other = crypto.randomUUID();
        await runs.create({ ...original.run, id: other, rootRunId: other, workspaceId: 'another-workspace' });
        const rejected = await f.host.handlePluginRequest(new Request(`http://localhost/api/knowledge-answer/reanswer/${other}`)); expect(rejected.status).toBe(400); expect(await rejected.text()).not.toContain('API migration');
        const base = f.ai.api_base; f.ai.api_key = 'MODEL_SECRET_SENTINEL'; f.ai.api_base = 'https://name:URL_SECRET@example.com/v1?token=PRIVATE_QUERY';
        const changed = await prepare(f.host, original.run.id), text = JSON.stringify(changed);
        expect(changed.contextHash).not.toBe(preview.contextHash); expect(changed.model.endpoint).toBe('https://example.com');
        for (const secret of ['MODEL_SECRET_SENTINEL', 'URL_SECRET', 'PRIVATE_QUERY']) expect(text).not.toContain(secret);
        f.ai.api_base = base;
        expect((await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, reanswer(preview), crypto.randomUUID())).execution!.run.status).toBe('failed'); expect(f.requests).toHaveLength(1);
        await f.host.stop(); expect((await f.host.web.handle(new Request(`http://localhost/api/knowledge-answer/reanswer/${original.run.id}`))).status).toBe(404);
    });

    test('a model setting changed during retrieval is rejected before sending the retrieved evidence', async () => {
        const f = await fixture(), original = (await f.call()).execution!, data = original.result.data as any;
        const config: any = { feishu: { bot_name: 'Review race' }, groups: [], ai: { ...f.ai } };
        const source: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'knowledge.markdown', name: 'Source fixture', version: '1.0.0', description: 'Model configuration race fixture' }, apply(ctx) {
            ctx.delivery.tools.register({ id: 'knowledge.markdown.search', version: '1.0.0', description: 'Fixture', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 1 }, async () => {
                config.ai.model = 'changed-during-retrieval';
                return { retrieval: 'keyword', source: { sourceId: data.retrieval.sourceId, version: data.retrieval.version, partial: false, indexed: 1, syncedAt: new Date().toISOString() }, hits: data.evidence };
            });
        } };
        const host = new AgentHost(() => ({ store: f.store, config }) as any, 10, undefined, [], { plugins: f.selection.plugins.map(plugin => plugin.manifest.id === 'knowledge.markdown' ? source : plugin) }); cleanup.push(() => host.stop());
        await host.initialize(); const stale = await prepare(f.host, original.run.id), preview = await prepare(host, original.run.id);
        expect(preview.contextHash).not.toBe(stale.contextHash);
        expect((await host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, reanswer(stale), crypto.randomUUID())).execution!.run.status).toBe('failed');
        expect(config.ai.model).toBe(f.ai.model);
        const result = await host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, reanswer(preview), crypto.randomUUID());
        expect(result.execution!.run.status).toBe('failed'); expect(f.requests).toHaveLength(1);
        expect((await new PersistentAgentRunStore(f.store).listSteps(result.execution!.run.id)).some(step => step.name === 'knowledge.answer.reanswer.review' && step.status === 'succeeded')).toBe(true);
    });

    test('model failure preserves reviewed provenance in the new run without publishing or changing the original answer', async () => {
        const f = await fixture(), original = (await f.call()).execution!, runs = new PersistentAgentRunStore(f.store), before = await runs.listArtifacts(original.run.id);
        const preview = await prepare(f.host, original.run.id); f.setMode('provider-failure');
        const result = await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, reanswer(preview), crypto.randomUUID());
        expect(result.execution!.run.status).toBe('failed'); expect(await runs.listArtifacts(result.execution!.run.id)).toEqual([]);
        expect((await runs.listSteps(result.execution!.run.id)).find(step => step.name === 'knowledge.answer.reanswer.review')?.metadata?.reanswerOf).toMatchObject({ runId: original.run.id });
        expect(await runs.listArtifacts(original.run.id)).toEqual(before);
    });

    test('an earlier insufficient result can use newly added sources while keeping the earlier result unchanged', async () => {
        const f = await fixture('echo-evidence'), original = (await f.call('zyxwvu')).execution!;
        expect((original.result.data as any).status).toBe('insufficient_evidence'); expect(f.requests).toHaveLength(0);
        const preview = await prepare(f.host, original.run.id);
        await writeFile(path.join(f.root, 'New.md'), '# Added knowledge\nzyxwvu has newly supplied evidence.');
        const result = await f.host.runLocal(KNOWLEDGE_ANSWER_CAPABILITY, reanswer(preview), crypto.randomUUID());
        expect(result.execution!.run.status).toBe('succeeded'); expect((result.execution!.result.data as any).status).toBe('answered');
        expect((result.execution!.result.data as any).reanswerOf.runId).toBe(original.run.id); expect(f.requests).toHaveLength(1);
        expect((await new PersistentAgentRunStore(f.store).listArtifacts(original.run.id))[0]!.content).toMatchObject({ status: 'insufficient_evidence' });
    });
});

describe('personal knowledge RAG', () => {
    test('keyless Ollama follows the same retrieval, citation verification and CLI paths', async () => {
        const f = await fixture('valid', 'ollama');
        const result = await f.call();
        expect(result.execution?.run.status).toBe('succeeded');
        expect(result.execution!.result.data).toMatchObject({ status: 'answered', verification: { citationIdentityAndQuotePresence: 'checked' } });
        const child = Bun.spawn([process.execPath, '--no-env-file', 'run', `${import.meta.dir}/../src/scripts/knowledge.ts`, '--root', f.root, '--ask', 'API migration'], {
            env: { ...process.env, KNOWLEDGE_PROVIDER: 'ollama', KNOWLEDGE_MODEL: f.ai.model, KNOWLEDGE_API_KEY: '', KNOWLEDGE_API_BASE: f.ai.api_base }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exit).toBe(0); expect(JSON.parse(stdout).result.status).toBe('answered'); expect(stderr).toContain(f.ai.api_base);
    });

    test('uses the real SDK and Tool Gateway and retains validated citation evidence', async () => {
        const f = await fixture();
        const result = await f.call('API migration', 'first');
        expect(result.status).not.toBe('failed');
        const data = result.execution!.result.data as any;
        expect(data.status).toBe('answered');
        expect(data.verification).toEqual({ citationIdentityAndQuotePresence: 'checked', semanticSupport: 'not_verified' });
        expect(data.claims[0].citations[0].citationId).toBe(data.evidence[0].citationId);
        const requestText = JSON.stringify(f.requests[0].messages);
        expect(requestText).not.toContain('UNSELECTED_NOTE_SENTINEL');
        expect(requestText).not.toContain('obsidian://');
        expect(requestText).not.toContain('Migration.md');
        expect(f.requests[0].tools || []).toEqual([]);
        const runs = new PersistentAgentRunStore(f.store);
        const steps = await runs.listSteps(result.execution!.run.id);
        expect(steps.some(step => step.kind === 'tool' && step.name === 'knowledge.markdown.search' && step.status === 'succeeded')).toBe(true);
        expect(steps.some(step => step.kind === 'model' && step.status === 'succeeded')).toBe(true);
        const artifacts = await runs.listArtifacts(result.execution!.run.id);
        expect(artifacts[0]).toMatchObject({ type: 'json', metadata: { privateKnowledge: true, semanticSupport: 'not_verified' } });
        expect((await f.call('API migration', 'first')).status).toBe('duplicate');
        expect(f.requests).toHaveLength(1);
    });

    test('no keyword evidence abstains without contacting the model', async () => {
        const f = await fixture();
        const result = await f.call('unfindable791zz');
        expect(result.execution!.result.data).toMatchObject({ status: 'insufficient_evidence', evidence: [] });
        expect(result.execution!.result.metrics?.modelCalls).toBe(0);
        expect(f.requests).toHaveLength(0);
    });

    for (const mode of ['unknown-id', 'wrong-quote', 'invalid-json', 'provider-failure'] as const) {
        test(`rejects ${mode} without publishing an answer artifact`, async () => {
            const f = await fixture(mode);
            const result = await f.call();
            expect(result.status).toBe('failed');
            const runId = result.claim.runId!;
            const runs = new PersistentAgentRunStore(f.store);
            expect(await runs.listArtifacts(runId)).toEqual([]);
            expect((await runs.listSteps(runId)).some(step => step.kind === 'model' && step.status === 'failed')).toBe(true);
        });
    }

    test('can abstain after retrieval without presenting unsupported claims', async () => {
        const f = await fixture('abstain');
        const result = await f.call();
        expect(result.execution!.result.data).toMatchObject({ status: 'insufficient_evidence', verification: { citationIdentityAndQuotePresence: 'not_applicable' } });
        expect((result.execution!.result.data as any).claims).toBeUndefined();
    });

    test('preserves the actual snapshot when a source changes during generation', async () => {
        const f = await fixture();
        f.setOnRequest(async () => { await writeFile(path.join(f.root, 'Migration.md'), '# Migration\nAPI migration policy changed; require human review.'); });
        const first = (await f.call()).execution!.result.data as any;
        f.setOnRequest(async () => {});
        const second = (await f.call()).execution!.result.data as any;
        expect(first.evidence[0].excerpt).toContain('mandatory before release');
        expect(second.evidence[0].excerpt).toContain('require human review');
        expect(first.evidence[0].documentVersion).not.toBe(second.evidence[0].documentVersion);
        expect(first.evidence[0].citationId).not.toBe(second.evidence[0].citationId);
    });

    test('communicates a partial index without sending unrelated failure paths to the model', async () => {
        const f = await fixture();
        await writeFile(path.join(f.root, 'BrokenPrivate.md'), '---\ntags: [broken\n---');
        const result = await f.call();
        expect(result.execution!.result.data).toMatchObject({ retrieval: { partial: true } });
        expect(JSON.stringify(f.requests[0].messages)).toContain('partialIndex');
        expect(JSON.stringify(f.requests[0].messages)).not.toContain('BrokenPrivate.md');
    });

    test('rejects conversation scopes before retrieval or model calls', async () => {
        const f = await fixture();
        const result = await f.call('API migration', 'chat', { conversationId: 'private-chat' });
        expect(result.status).toBe('failed');
        expect(f.requests).toHaveLength(0);
        expect((await new PersistentAgentRunStore(f.store).listSteps(result.claim.runId!)).some(step => step.kind === 'tool')).toBe(false);
    });

    test('CLI --ask uses only explicit knowledge model settings and shows its destination', async () => {
        const f = await fixture();
        const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../src/scripts/knowledge.ts`, '--root', f.root, '--ask', 'API migration'], {
            env: { ...process.env, KNOWLEDGE_MODEL: f.ai.model, KNOWLEDGE_API_KEY: f.ai.api_key, KNOWLEDGE_API_BASE: f.ai.api_base, KNOWLEDGE_PROVIDER: f.ai.provider }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exit).toBe(0);
        expect(JSON.parse(stdout).result.status).toBe('answered');
        expect(stderr).toContain('selected excerpts');
        expect(stderr).not.toContain(f.ai.api_key);
    });

    test('CLI cannot silently fall back to team model credentials', async () => {
        const f = await fixture();
        const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../src/scripts/knowledge.ts`, '--root', f.root, '--ask', 'API migration'], {
            env: { ...process.env, AI_API_KEY: 'test', AI_MODEL: f.ai.model, AI_API_BASE: f.ai.api_base,
                KNOWLEDGE_API_KEY: '', KNOWLEDGE_MODEL: '', KNOWLEDGE_API_BASE: '' }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exit).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('--ask requires KNOWLEDGE_API_BASE');
        expect(f.requests).toHaveLength(0);
    });

    test('quote validation requires exact, supplied, nonempty evidence and bounds context', () => {
        const hit: EvidenceHit = { citationId: 'a'.repeat(64), sourceId: 's', path: 'a.md', title: 'Rule', documentVersion: 'b'.repeat(64), heading: 'Rule', lineStart: 1, lineEnd: 1, excerpt: 'Exact source wording.' };
        const draft = (quote: string) => JSON.stringify({ status: 'answered', claims: [{ text: 'A claim', citations: [{ citationId: hit.citationId, quote }] }] });
        expect(() => verifyDraft(draft(''), [hit])).toThrow();
        expect(() => verifyDraft('x'.repeat(64 * 1024 + 1), [hit])).toThrow('64 KiB');
        expect(() => verifyDraft(draft('exact source wording.'), [hit])).toThrow('not present');
        expect(verifyDraft(draft('Exact source wording.'), [hit]).status).toBe('answered');
        expect(() => selectEvidence([hit, hit])).toThrow('Duplicate');
        expect(selectEvidence(Array.from({ length: 10 }, (_, index) => ({ ...hit, citationId: `${index}`.repeat(64), excerpt: 'x'.repeat(2000) })))).toHaveLength(5);
    });
});
