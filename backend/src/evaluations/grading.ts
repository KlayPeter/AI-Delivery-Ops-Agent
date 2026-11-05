import { z } from 'zod';
import { cases, EVALUATOR_VERSION, suiteHash, type EvaluationCase } from './dataset';

export const evaluationInput = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('fixture'), fixture: z.enum(['baseline', 'regression']), label: z.string().trim().min(1).max(80) }).strict(),
    z.object({ mode: z.literal('model'), confirmed: z.literal(true), label: z.string().trim().min(1).max(80) }).strict(),
]);
export type EvaluationInput = z.infer<typeof evaluationInput>;
const actualSchema = z.object({ runStatus: z.enum(['succeeded', 'failed', 'cancelled', 'waiting_human']), answerStatus: z.enum(['answered', 'insufficient_evidence']).nullable(), text: z.string().max(64 * 1024),
    quotes: z.array(z.object({ path: z.string().max(1024), quote: z.string().max(2000) }).strict()).max(20), citationPaths: z.array(z.string().max(1024)).max(20), citationContract: z.boolean(), generationCalls: z.number().int().min(0).max(1),
    inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
    trace: z.array(z.object({ kind: z.string().max(30), name: z.string().max(160), status: z.string().max(30) }).strict()).max(12),
}).strict();
export type CaseActual = z.infer<typeof actualSchema>;
export function gradeCase(test: EvaluationCase, actual: CaseActual) {
    const text = actual.text.normalize('NFKC').toLocaleLowerCase('en-US');
    const checks = [
        { id: 'execution', label: '运行完成', passed: actual.runStatus === 'succeeded' },
        { id: 'answer-status', label: `回答形态：${test.expected}`, passed: actual.answerStatus === test.expected },
        { id: 'citations', label: test.expected === 'answered' ? '引用契约已核验且包含要求的资料' : '资料不足时不附编造的引用', passed: test.expected === 'answered' ? actual.citationContract && test.requiredPaths.every(path => actual.citationPaths.includes(path)) && actual.citationPaths.every(path => test.requiredPaths.includes(path)) : !actual.citationPaths.length },
        ...test.terms.map((terms, index) => ({ id: `terms-${index}`, label: `包含词语：${terms.join(' / ')}`, passed: terms.some(term => text.includes(term.normalize('NFKC').toLocaleLowerCase('en-US'))) })),
        ...test.forbidden.map((term, index) => ({ id: `forbidden-${index}`, label: `不出现：${term}`, passed: !text.includes(term.normalize('NFKC').toLocaleLowerCase('en-US')) })),
    ];
    return { passed: checks.every(check => check.passed), checks };
}
const caseSchema = z.object({ id: z.string(), title: z.string(), question: z.string(), caseRunId: z.string().uuid(), elapsedMs: z.number().nonnegative(), actual: actualSchema,
    passed: z.boolean(), checks: z.array(z.object({ id: z.string(), label: z.string(), passed: z.boolean() }).strict()).max(20),
}).strict();
export const reportSchema = z.object({ schemaVersion: z.literal('1.0'), suiteId: z.literal('personal-rag-v1'), suiteHash: z.string().regex(/^[a-f0-9]{64}$/), evaluatorVersion: z.literal(EVALUATOR_VERSION),
    graderHash: z.string().regex(/^[a-f0-9]{64}$/), mode: z.enum(['fixture', 'model']), fixture: z.enum(['baseline', 'regression']).nullable(), label: z.string().min(1).max(80), syntheticData: z.literal(true), semanticSupport: z.literal('not_verified'),
    startedAt: z.string().datetime(), finishedAt: z.string().datetime(), elapsedMs: z.number().nonnegative(),
    target: z.object({ provider: z.string().max(80), model: z.string().max(200), endpointOrigin: z.string().max(512).nullable() }).strict(),
    pipeline: z.object({ agentId: z.literal('native.knowledge-answer'), agentVersion: z.string(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), caseTimeoutSeconds: z.literal(12) }).strict(),
    summary: z.object({ total: z.number().int(), passed: z.number().int(), failed: z.number().int(), generationCalls: z.number().int().nonnegative(), medianMs: z.number().nonnegative(), p95Ms: z.number().nonnegative() }).strict(),
    cases: z.array(caseSchema).length(cases.length),
}).strict();
export type EvaluationReport = z.infer<typeof reportSchema>;
export function timings(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return { medianMs: sorted.length ? (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) : 0, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] || 0 };
}
export function validateReport(value: unknown): EvaluationReport {
    const report = reportSchema.parse(value);
    if (report.suiteHash !== suiteHash || new Set(report.cases.map(item => item.id)).size !== cases.length || report.summary.total !== cases.length || report.summary.passed !== report.cases.filter(item => item.passed).length || report.summary.failed !== report.cases.filter(item => !item.passed).length || report.summary.generationCalls !== report.cases.reduce((sum, item) => sum + item.actual.generationCalls, 0) || (report.mode === 'fixture') !== Boolean(report.fixture)) throw new Error('评测报告的题集、模式或统计不一致');
    if (JSON.stringify(timings(report.cases.map(item => item.elapsedMs))) !== JSON.stringify({ medianMs: report.summary.medianMs, p95Ms: report.summary.p95Ms }) || (report.mode === 'fixture' && (report.target.provider !== 'evaluation-fixture' || report.target.model !== `fixture-${report.fixture}` || report.cases.some(item => item.actual.inputTokens !== null || item.actual.outputTokens !== null)))) throw new Error('评测耗时或离线模式凭证不一致');
    for (const item of report.cases) {
        const test = cases.find(test => test.id === item.id); if (!test) throw new Error('评测题目不匹配');
        const checked = gradeCase(test, item.actual);
        if (item.title !== test.title || item.question !== test.question || item.passed !== checked.passed || JSON.stringify(item.checks) !== JSON.stringify(checked.checks)) throw new Error('评测结果与当前规则不一致');
    }
    return report;
}
export function compareReports(before: unknown, after: unknown) {
    const baseline = validateReport(before), candidate = validateReport(after);
    if (baseline.mode !== candidate.mode || baseline.suiteHash !== candidate.suiteHash || baseline.graderHash !== candidate.graderHash) throw new Error('只比较同一题集、同一运行模式的结果');
    return { baseline: { label: baseline.label, target: baseline.target, passed: baseline.summary.passed }, candidate: { label: candidate.label, target: candidate.target, passed: candidate.summary.passed }, mode: baseline.mode,
        passDelta: candidate.summary.passed - baseline.summary.passed,
        cases: candidate.cases.map(item => { const old = baseline.cases.find(previous => previous.id === item.id)!; return { id: item.id, title: item.title, before: old.passed, after: item.passed, change: old.passed === item.passed ? 'unchanged' : item.passed ? 'improved' : 'regressed' }; }),
        changed: { model: JSON.stringify(baseline.target) !== JSON.stringify(candidate.target), pipeline: JSON.stringify(baseline.pipeline) !== JSON.stringify(candidate.pipeline), fixture: baseline.fixture !== candidate.fixture }, semanticSupport: 'not_verified',
    };
}
