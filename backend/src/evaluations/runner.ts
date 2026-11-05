import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { AIConfig } from '@/core/config';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { modelProviderPlugin, standardModelProviders } from '@/platform/models/providers';
import { ModelProviderRegistry, modelProviderId } from '@/platform/models/registry';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { knowledgeAnswerPlugin } from '@/knowledge/answer/plugin';
import { cases, documents, suiteHash, EVALUATOR_VERSION, CASE_TIMEOUT_SECONDS, hash, type EvaluationCase } from './dataset';
import { evaluationInput, gradeCase, timings, validateReport, type CaseActual, type EvaluationInput, type EvaluationReport } from './grading';

function fixtureModel(test: EvaluationCase, variant: 'baseline' | 'regression') {
    return new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
        const user = prompt.findLast(message => message.role === 'user');
        const context = JSON.parse(user && Array.isArray(user.content) ? user.content.filter(part => part.type === 'text').map(part => part.text).join('') : '{}');
        const evidence = context.evidence as Array<{ title: string; excerpt: string; citationId: string }>;
        const replies = test.reply.map(reply => ({ text: reply.text, citations: reply.citations.map(citation => {
            const title = documents.find(document => document.path === citation.path)!.title;
            const hit = evidence.find(hit => hit.title === title && hit.excerpt.includes(citation.quote));
            return { citationId: hit?.citationId || '0'.repeat(64), quote: citation.quote };
        }) }));
        if (variant === 'regression') {
            if (test.id === 'release') replies[0]!.citations[0]!.citationId = '0'.repeat(64);
            if (test.id === 'injection') replies[0]!.text += ' EVAL_INJECTION_CANARY';
            if (test.id === 'abstain') {
                const hit = evidence.find(hit => hit.title === 'API 发布规则')!;
                replies.push({ text: '负责人的邮箱是 invented@example.test。', citations: [{ citationId: hit?.citationId || '0'.repeat(64), quote: 'API 发布前必须提供迁移说明和回滚计划。' }] });
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify(replies.length ? { status: 'answered', claims: replies } : { status: 'insufficient_evidence', reason: '虚构资料没有给出所问事实。' }) }],
            finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }, warnings: [] };
    } });
}
export function endpointOrigin(config: AIConfig) {
    if (modelProviderId(config) === 'google' && (!config.api_base || config.api_base.includes('api.openai.com'))) return 'https://generativelanguage.googleapis.com';
    if (modelProviderId(config) === 'ollama') return new URL(config.api_base || 'http://127.0.0.1:11434/v1').origin;
    if (!config.api_base) return modelProviderId(config) === 'openai' ? 'https://api.openai.com' : null;
    try { return new URL(config.api_base).origin; } catch { return null; }
}
export async function runEvaluation(raw: EvaluationInput, config: AIConfig, signal: AbortSignal, providers: Pick<ModelProviderRegistry, 'configured' | 'resolve'> = new ModelProviderRegistry(standardModelProviders)): Promise<EvaluationReport> {
    const input = evaluationInput.parse(raw); signal.throwIfAborted();
    const ai = { ...config };
    if (input.mode === 'model' && (!['openai', 'google', 'ollama'].includes(modelProviderId(ai)) || !providers.configured(ai) || !ai.model?.trim() || ai.model.length > 200)) throw new Error('请配置已支持的标准模型提供者；评测不会自动回退其他供应商');
    const startedAt = new Date().toISOString(), start = performance.now();
    const codeFiles = ['../knowledge/answer/plugin.ts', '../knowledge/answer/evidence.ts', '../knowledge/markdown/source.ts', '../knowledge/search.ts', '../platform/models/aiSdkOrchestrator.ts', '../platform/models/providers/cloud.ts', '../platform/models/providers/ollama.ts', '../../bun.lock', './runner.ts', './dataset.ts'];
    const sourceHash = hash(await Promise.all(codeFiles.map(async file => hash(await readFile(path.join(import.meta.dir, file), 'utf8')))));
    const graderHash = hash(await readFile(path.join(import.meta.dir, 'grading.ts'), 'utf8'));
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-rag-evaluation-'));
    let host: AgentHost | undefined, active: EvaluationCase | undefined;
    const calls = new Map<string, number>();
    const results: EvaluationReport['cases'] = [];
    try {
        for (const document of documents) await writeFile(path.join(directory, document.path), document.text, { mode: 0o600 });
        const childConfig = { ...ai, provider: 'evaluation-model', model: input.mode === 'fixture' ? `fixture-${input.fixture}` : ai.model };
        const model = modelProviderPlugin({ id: 'evaluation-model', name: 'Isolated evaluation model', isConfigured: () => true, create() {
            const test = active; if (!test) throw new Error('No active evaluation case');
            let base;
            try { base = input.mode === 'fixture' ? fixtureModel(test, input.fixture) : providers.resolve(ai); }
            catch { throw new Error('评测模型初始化失败，供应商原始错误未保存'); }
            if (typeof base === 'string' || base.specificationVersion !== 'v3') throw new Error('评测需要已支持的 V3 标准模型实现');
            return wrapLanguageModel({ model: base, middleware: { specificationVersion: 'v3',
                transformParams: async ({ params }) => ({ ...params, abortSignal: AbortSignal.any([signal, ...(params.abortSignal ? [params.abortSignal] : [])]) }),
                wrapGenerate: async ({ doGenerate }) => {
                    signal.throwIfAborted(); if (calls.get(test.id)) throw new Error('Each evaluation case permits only one provider request; retries are disabled');
                    calls.set(test.id, 1); return doGenerate();
                },
            } });
        } });
        const answer = { ...knowledgeAnswerPlugin, agents: knowledgeAnswerPlugin.agents!.map(agent => ({ ...agent, manifest: { ...agent.manifest, limits: { ...agent.manifest.limits, timeoutSeconds: CASE_TIMEOUT_SECONDS } } })) };
        const memory = new InMemoryPersistentKeyValueStore();
        host = new AgentHost(() => ({ store: memory, config: { feishu: { bot_name: 'Isolated evaluation', app_id: '' }, ai: childConfig, data_path: directory }, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
            plugins: [knowledgeMarkdownPlugin, answer, model], pluginConfig: { 'knowledge.markdown': { root: directory, sourceId: 'evaluation-fixture' } },
        });
        await host.initialize();
        for (const test of cases) {
            signal.throwIfAborted(); active = test; const tick = performance.now();
            const outcome = await host.runLocal('knowledge.answer', { question: test.question, limit: 5 }, randomUUID()); signal.throwIfAborted();
            const execution = outcome.execution!;
            const detail = (await host.getLocalRunDetails(execution.run.id))!;
            const data = execution.run.status === 'succeeded' ? execution.result.data as any : undefined;
            const claims = data?.status === 'answered' && Array.isArray(data.claims) ? data.claims : [];
            const quotes: CaseActual['quotes'] = claims.flatMap((claim: any) => claim.citations.map((citation: any) => ({ path: data.evidence.find((hit: any) => hit.citationId === citation.citationId)?.path || '__unknown__', quote: citation.quote })));
            const paths = quotes.map(citation => citation.path);
            const modelStep = detail.steps.find(step => step.kind === 'model');
            const actual: CaseActual = { runStatus: execution.run.status === 'succeeded' ? 'succeeded' : execution.run.status === 'cancelled' ? 'cancelled' : execution.run.status === 'waiting_human' ? 'waiting_human' : 'failed', answerStatus: ['answered', 'insufficient_evidence'].includes(data?.status) ? data.status : null,
                text: claims.length ? claims.map((claim: any) => claim.text).join('\n') : typeof data?.reason === 'string' ? data.reason : '', quotes, citationPaths: [...new Set(paths)], citationContract: data?.verification?.citationIdentityAndQuotePresence === 'checked', generationCalls: calls.get(test.id) || 0,
                inputTokens: input.mode === 'fixture' ? null : typeof modelStep?.metadata?.inputTokens === 'number' ? modelStep.metadata.inputTokens : calls.has(test.id) ? null : 0,
                outputTokens: input.mode === 'fixture' ? null : typeof modelStep?.metadata?.outputTokens === 'number' ? modelStep.metadata.outputTokens : calls.has(test.id) ? null : 0,
                trace: detail.steps.map(step => ({ kind: step.kind, name: step.name, status: step.status })),
            };
            results.push({ id: test.id, title: test.title, question: test.question, caseRunId: execution.run.id, elapsedMs: Math.round((performance.now() - tick) * 1000) / 1000, actual, ...gradeCase(test, actual) });
        }
        const passed = results.filter(test => test.passed).length;
        return validateReport({ schemaVersion: '1.0', suiteId: 'personal-rag-v1', suiteHash, evaluatorVersion: EVALUATOR_VERSION, graderHash, mode: input.mode, fixture: input.mode === 'fixture' ? input.fixture : null, label: input.label,
            syntheticData: true, semanticSupport: 'not_verified', startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round((performance.now() - start) * 1000) / 1000,
            target: input.mode === 'fixture' ? { provider: 'evaluation-fixture', model: `fixture-${input.fixture}`, endpointOrigin: null } : { provider: modelProviderId(ai), model: ai.model, endpointOrigin: endpointOrigin(ai) },
            pipeline: { agentId: 'native.knowledge-answer', agentVersion: answer.agents[0]!.manifest.version, manifestHash: hash(answer.agents[0]!.manifest), sourceHash, caseTimeoutSeconds: CASE_TIMEOUT_SECONDS },
            summary: { total: cases.length, passed, failed: results.length - passed, generationCalls: [...calls.values()].reduce((sum, value) => sum + value, 0), ...timings(results.map(test => test.elapsedMs)) }, cases: results,
        });
    } finally { try { await host?.stop(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
