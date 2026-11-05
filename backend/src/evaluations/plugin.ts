import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { requirePersonalScope } from '@/knowledge/scope';
import { cases, suiteHash, CASE_TIMEOUT_SECONDS } from './dataset';
import { compareReports, evaluationInput, validateReport } from './grading';
import { runEvaluation } from './runner';

export const EVALUATION_CAPABILITY = 'quality.rag.evaluate';
const toolId = 'quality.rag.evaluate', role = 'evaluation.rag.report';
const labelSchema = { type: 'string', minLength: 1, maxLength: 80 };
const inputSchema: AgentManifest['inputSchema'] = { oneOf: [
    { type: 'object', properties: { mode: { const: 'fixture' }, fixture: { enum: ['baseline', 'regression'] }, label: labelSchema }, required: ['mode', 'fixture', 'label'], additionalProperties: false },
    { type: 'object', properties: { mode: { const: 'model' }, confirmed: { const: true }, label: labelSchema }, required: ['mode', 'confirmed', 'label'], additionalProperties: false },
] };
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.rag-evaluation', name: '知识问答评测', version: '1.0.0',
    description: '用六道虚构资料题运行实际 RAG 管线，保存规则检查、模型调用和版本凭证；离线样例检验协议，真实模型需明确确认。规则通过不证明语义正确。',
    runtime: { type: 'native' }, capabilities: [EVALUATION_CAPABILITY], triggers: ['manual'], inputSchema, outputSchema: { type: 'object' },
    requirements: { tools: [toolId], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 90, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};
export async function readEvaluationReports(store: PersistentKeyValueStore, scope: { workspaceId: string; botInstanceId: string }, ids: string[]) {
    if (!ids.length || ids.length > 2) throw new Error('请选择一或两份报告');
    const runs = new PersistentAgentRunStore(store), targets = await Promise.all(ids.map(id => runs.get(z.string().uuid().parse(id))));
    for (const run of targets) if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.parentRunId || run.status !== 'succeeded' || run.capability !== EVALUATION_CAPABILITY) throw new Error('评测记录不存在或不属于当前范围');
    const reports = [];
    for (const run of targets) {
        const artifacts = (await runs.listArtifacts(run!.id)).filter(artifact => artifact.metadata?.artifactRole === role);
        if (artifacts.length !== 1 || artifacts[0]!.type !== 'json' || Buffer.byteLength(JSON.stringify(artifacts[0]!.content)) > 1024 * 1024) throw new Error('评测记录缺少有效报告');
        reports.push(validateReport(artifacts[0]!.content));
    }
    return reports;
}
export const ragEvaluationPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'quality.evaluation', name: manifest.name, version: '1.0.0', description: manifest.description },
    agents: [{ manifest, installationId: 'install-rag-evaluation' }],
    apply(ctx) {
        ctx.delivery.web.register({ id: 'quality.evaluation', pages: [{ path: '/evaluations', label: '问答评测', section: 'workspace', view: { kind: 'builtin', id: 'rag-evaluation', capability: EVALUATION_CAPABILITY } }],
            api: { prefix: '/api/evaluations', routes: [{ method: 'GET', path: '/api/evaluations/suite' }, { method: 'GET', path: '/api/evaluations/report' }, { method: 'GET', path: '/api/evaluations/compare' }], async handle(request) {
                const url = new URL(request.url);
                if (request.method !== 'GET') return Response.json({ error: '接口不存在' }, { status: 404 });
                if (url.pathname === '/api/evaluations/suite' && !url.search) return Response.json({ id: 'personal-rag-v1', suiteHash, syntheticData: true, caseTimeoutSeconds: CASE_TIMEOUT_SECONDS, maxGenerationCalls: cases.length, cases: cases.map(({ id, title, question, expected }) => ({ id, title, question, expected })) });
                try {
                    const fields = url.pathname === '/api/evaluations/report' ? ['runId'] : url.pathname === '/api/evaluations/compare' ? ['baselineId', 'candidateId'] : [];
                    if (!fields.length || url.search.length > 200 || [...url.searchParams.keys()].length !== fields.length || fields.some(field => !url.searchParams.has(field))) throw new Error();
                    const reports = await readEvaluationReports(ctx.delivery.getContext().store, { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID }, fields.map(field => url.searchParams.get(field)!));
                    return Response.json(fields.length === 1 ? reports[0] : compareReports(reports[0], reports[1]));
                } catch { return Response.json({ error: '无法读取或比较所选评测；需要当前范围内、同题集与同模式的有效报告' }, { status: 400 }); }
            } },
        });
        ctx.delivery.tools.register({ id: toolId, version: '1.0.0', description: manifest.description, inputSchema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: false, timeoutSeconds: 85 }, async (value, execution) => {
            requirePersonalScope(execution.scope);
            if (execution.scope.triggerType !== 'manual') throw new Error('评测需要本机人工发起');
            const input = evaluationInput.parse(value);
            if (input.mode === 'model' && !ctx.delivery.modelProviders?.configured(ctx.delivery.getContext().config.ai)) throw new Error('当前模型插件未启用或尚未配置');
            return runEvaluation(input, ctx.delivery.getContext().config.ai, execution.signal, ctx.delivery.modelProviders);
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope); const input = evaluationInput.parse(request.input), budget = new RunToolCallBudget(1);
            const report = validateReport(await ctx.delivery.toolGateway.execute(toolId, input, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: [toolId], budget }));
            return { status: 'succeeded', data: report, metrics: { modelCalls: report.summary.generationCalls, toolCalls: budget.used }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: report,
                metadata: { privateKnowledge: true, artifactRole: role, title: '知识问答评测报告', statusPanels: [{ schemaVersion: '1.0', tone: report.summary.failed ? 'warning' : 'success', title: `${report.summary.passed}/${report.summary.total} 道题规则通过`, checkedAt: report.finishedAt,
                    description: report.mode === 'fixture' ? '固定样例验证 RAG 协议与评测规则，不代表真实模型质量。内部题目在隔离内存环境运行，轨迹保留在报告。' : '当前模型在虚构题集的规则结果；引用存在与词语命中不证明语义正确。内部题目轨迹保留在报告。',
                    items: [{ label: '运行模式', value: report.mode === 'fixture' ? '离线固定样例' : '当前模型' }, { label: '生成调用', value: String(report.summary.generationCalls) }, { label: '语义支持', value: '未验证' }] }] } }] };
        });
    },
};
export default ragEvaluationPlugin;
