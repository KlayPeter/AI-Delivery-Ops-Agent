import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AIConfig } from '@/core/config';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { cases, documents } from '@/evaluations/dataset';
import { runEvaluation } from '@/evaluations/runner';
import { compareReports, evaluationInput, timings, validateReport } from '@/evaluations/grading';
import { ragEvaluationPlugin, readEvaluationReports } from '@/evaluations/plugin';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';

const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
const fixture = (variant: 'baseline' | 'regression' = 'baseline') => runEvaluation({ mode: 'fixture', fixture: variant, label: variant }, {} as AIConfig, new AbortController().signal);
describe('isolated RAG evaluation', () => {
    test('actual production citation guard catches the regression control and abstention rule', async () => {
        const baseline = await fixture(), regression = await fixture('regression');
        expect(baseline.summary).toMatchObject({ total: 6, passed: 6, failed: 0, generationCalls: 5 });
        expect(regression.summary).toMatchObject({ passed: 3, failed: 3, generationCalls: 5 });
        expect(regression.cases.find(item => item.id === 'release')!.actual.runStatus).toBe('failed');
        const unsupported = regression.cases.find(item => item.id === 'abstain')!;
        expect(unsupported.actual.citationContract).toBe(true); expect(unsupported.passed).toBe(false);
        expect(regression.cases.find(item => item.id === 'injection')!.checks.find(item => item.id === 'forbidden-0')!.passed).toBe(false);
        expect(baseline.cases.find(item => item.id === 'empty')!.actual.generationCalls).toBe(0);
        expect(compareReports(baseline, regression).passDelta).toBe(-3);
        expect(baseline.semanticSupport).toBe('not_verified');
        expect(baseline.cases.every(item => item.actual.inputTokens === null && item.actual.trace.some(step => step.kind === 'tool'))).toBe(true);
    });
    test('report identity, counts, grades, timings and comparison compatibility are checked', async () => {
        const report = await fixture();
        for (const mutate of [(r: any) => r.summary.passed--, (r: any) => r.cases[0].passed = false, (r: any) => r.cases[0].id = r.cases[1].id, (r: any) => r.suiteHash = '0'.repeat(64), (r: any) => r.summary.medianMs++, (r: any) => r.target.model = 'not-fixture']) {
            const copy = structuredClone(report); mutate(copy); expect(() => validateReport(copy)).toThrow();
        }
        expect(() => compareReports(report, { ...report, graderHash: '0'.repeat(64) })).toThrow();
        expect(() => compareReports(report, { ...report, mode: 'model', fixture: null })).toThrow();
        expect(timings([4, 1, 3, 2])).toEqual({ medianMs: 2.5, p95Ms: 4 });
        expect(evaluationInput.safeParse({ mode: 'model', confirmed: false, label: 'no' }).success).toBe(false);
        expect(evaluationInput.safeParse({ mode: 'fixture', fixture: 'baseline', label: 'no', root: '/secret' }).success).toBe(false);
    });
    test('offline evaluation ignores model credentials and ambient plugin files, removes its corpus', async () => {
        const before = (await readdir(tmpdir())).filter(file => file.startsWith('agent-rag-evaluation-')).sort();
        const old = process.env.AGENT_PLUGINS_FILE; process.env.AGENT_PLUGINS_FILE = '/missing-untrusted-plugin.yaml';
        try {
            const report = await runEvaluation({ mode: 'fixture', fixture: 'baseline', label: 'isolated' }, { provider: 'unknown', api_key: 'evaluation-test-secret', api_base: 'https://secret.example/path?token=private', model: 'ignored' } as AIConfig, new AbortController().signal);
            expect(report.summary.passed).toBe(6); expect(JSON.stringify(report)).not.toContain('evaluation-test-secret'); expect(JSON.stringify(report)).not.toContain('secret.example');
        } finally { if (old === undefined) delete process.env.AGENT_PLUGINS_FILE; else process.env.AGENT_PLUGINS_FILE = old; }
        expect((await readdir(tmpdir())).filter(file => file.startsWith('agent-rag-evaluation-')).sort()).toEqual(before);
    });
    test('current model does not silently choose another provider', async () => {
        await expect(runEvaluation({ mode: 'model', confirmed: true, label: 'missing' }, {} as AIConfig, new AbortController().signal)).rejects.toThrow('配置');
    });
    test('configured HTTP model uses the real SDK adapter and records usage without credentials', async () => {
        let requests = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            requests++; const body = await request.json() as any;
            const context = JSON.parse(body.messages.find((message: any) => message.role === 'user').content);
            const test = cases.find(test => test.question === context.question)!;
            const claims = test.reply.map(reply => ({ text: reply.text, citations: reply.citations.map(citation => ({ citationId: context.evidence.find((hit: any) => hit.title === documents.find(document => document.path === citation.path)!.title).citationId, quote: citation.quote })) }));
            const content = JSON.stringify(claims.length ? { status: 'answered', claims } : { status: 'insufficient_evidence', reason: '资料没有邮箱。' });
            return Response.json({ id: 'eval-controlled', object: 'chat.completion', created: 1, model: 'controlled-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
        } });
        try {
            const report = await runEvaluation({ mode: 'model', confirmed: true, label: 'http-protocol-only' }, { provider: 'openai', model: 'controlled-model', api_key: 'evaluation-test-key', api_base: `http://127.0.0.1:${server.port}/v1` } as AIConfig, new AbortController().signal);
            expect(report.summary.passed).toBe(6); expect(requests).toBe(5);
            expect(report.cases.find(item => item.id === 'release')!.actual).toMatchObject({ inputTokens: 20, outputTokens: 10 });
            expect(JSON.stringify(report)).not.toContain('evaluation-test-key'); expect(report.semanticSupport).toBe('not_verified');
        } finally { server.stop(true); }
    });
    test('provider retries never send a second request per case and raw errors are excluded', async () => {
        let requests = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ error: { message: 'evaluation-private-provider-error' } }, { status: 500 }); } });
        try {
            const report = await runEvaluation({ mode: 'model', confirmed: true, label: 'controlled-http-fixture' }, { provider: 'openai', model: 'mock-eval', api_key: 'evaluation-test-key', api_base: `http://127.0.0.1:${server.port}/v1` } as AIConfig, new AbortController().signal);
            expect(requests).toBe(5); expect(report.summary.generationCalls).toBe(5); expect(report.summary.failed).toBe(5);
            expect(JSON.stringify(report)).not.toContain('evaluation-private-provider-error'); expect(JSON.stringify(report)).not.toContain('evaluation-test-key');
            expect(report.cases.filter(item => item.actual.generationCalls).every(item => item.actual.inputTokens === null)).toBe(true);
        } finally { server.stop(true); }
    }, 30000);
    test('abort reaches the provider and removes temporary notes', async () => {
        const controller = new AbortController(); let requests = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; controller.abort(new Error('test cancellation')); return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({})), 100)); } });
        const before = (await readdir(tmpdir())).filter(file => file.startsWith('agent-rag-evaluation-')).sort();
        try {
            await expect(runEvaluation({ mode: 'model', confirmed: true, label: 'cancel' }, { provider: 'openai', model: 'mock-eval', api_key: 'test', api_base: `http://127.0.0.1:${server.port}/v1` } as AIConfig, controller.signal)).rejects.toThrow('test cancellation');
            expect(requests).toBe(1);
        } finally { server.stop(true); }
        expect((await readdir(tmpdir())).filter(file => file.startsWith('agent-rag-evaluation-')).sort()).toEqual(before);
    });
    test('plugin records a root Tool/Artifact report and refuses foreign reads before any artifact access', async () => {
        const store = new InMemoryPersistentKeyValueStore(), host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'test', app_id: '' }, ai: { provider: 'openai', model: 'disabled-provider', api_key: 'must-not-use', api_base: 'http://127.0.0.1:1/v1' } }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [ragEvaluationPlugin] });
        try {
            await host.initialize();
            const disabled = await host.runLocal('quality.rag.evaluate', { mode: 'model', confirmed: true, label: 'disabled' }, crypto.randomUUID());
            expect(disabled.execution!.run.status).toBe('failed');
            const outcome = await host.runLocal('quality.rag.evaluate', { mode: 'fixture', fixture: 'baseline', label: 'parent' }, crypto.randomUUID());
            const runId = outcome.execution!.run.id, detail = (await host.getLocalRunDetails(runId))!;
            expect(detail.run.status).toBe('succeeded'); expect(detail.steps.some(step => step.kind === 'tool' && step.name === 'quality.rag.evaluate')).toBe(true);
            expect((await readEvaluationReports(store, scope, [runId]))[0]!.summary.passed).toBe(6);
            let artifactReads = 0; const original = store.listIdempotencyEntries.bind(store);
            store.listIdempotencyEntries = async (prefix: string) => { if (prefix.startsWith('agent:artifact:')) artifactReads++; return original(prefix) as any; };
            await expect(readEvaluationReports(store, { ...scope, workspaceId: 'foreign' }, [runId])).rejects.toThrow();
            expect(artifactReads).toBe(0);
            await expect(readEvaluationReports(store, scope, [runId, crypto.randomUUID()])).rejects.toThrow();
            expect(artifactReads).toBe(0);
            const suite = await host.web.handle(new Request('http://localhost/api/evaluations/suite'));
            expect(suite.status).toBe(200); expect((await suite.json()).cases).toHaveLength(6);
        } finally { await host.stop(); }
        expect((await host.web.handle(new Request('http://localhost/api/evaluations/suite'))).status).toBe(404);
    });
    test('CLI emits JSON, fails a regression gate and requires explicit model confirmation', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-cli-'));
        const cli = (...args: string[]) => Bun.spawn([process.execPath, 'run', 'src/scripts/evaluate.ts', ...args], { cwd: path.resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
        try {
            const baseline = cli('--label', 'cli-baseline'), output = await new Response(baseline.stdout).text();
            expect(await baseline.exited).toBe(0); expect(JSON.parse(output).summary.passed).toBe(6);
            const filename = path.join(directory, 'baseline.json'); await writeFile(filename, output);
            const regression = cli('--fixture', 'regression', '--compare', filename); const result = JSON.parse(await new Response(regression.stdout).text());
            expect(await regression.exited).toBe(1); expect(result.comparison.passDelta).toBe(-3);
            const unconfirmed = cli('--mode', 'model'); expect(await unconfirmed.exited).toBe(2); expect(await new Response(unconfirmed.stdout).text()).toBe('');
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
