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

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

type Mode = 'valid' | 'unknown-id' | 'wrong-quote' | 'invalid-json' | 'provider-failure' | 'abstain';
async function fixture(mode: Mode = 'valid') {
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
                : { status: 'answered', claims: [{ text: 'Migration notes are required before release.', citations: [{
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
    const ai = { provider: 'openai-compatible', model: 'fixture-model', api_key: 'fixture-local-key', api_base: `${server.url}v1` };
    const ctx: any = { store, config: { feishu: { bot_name: 'Local test' }, groups: [], ai } };
    const host = new AgentHost(() => ctx, 10, undefined, [], { plugins: selection.plugins,
        pluginConfig: { ...selection.config, 'knowledge.markdown': { root, sourceId: 'test-vault', vaultName: 'Private Vault Name' } } });
    cleanup.push(() => host.stop());
    async function call(question = 'API migration', id: string = crypto.randomUUID(), extra: Record<string, string> = {}) {
        const input = { question };
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: id, ...extra });
        return host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), KNOWLEDGE_ANSWER_CAPABILITY, input);
    }
    return { root, host, store, requests, ai, call, setOnRequest: (callback: () => Promise<void>) => { onRequest = callback; } };
}

describe('personal knowledge RAG', () => {
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
