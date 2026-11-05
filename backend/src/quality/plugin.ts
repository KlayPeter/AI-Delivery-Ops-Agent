import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { StatusPanel } from '@/platform/plugins/runActions';
import { requirePersonalScope } from '@/knowledge/scope';
import { RunCheckService, type RunCheckReport } from './service';

export const CHECK_CAPABILITY = 'quality.runs.check';
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.plugin-checks', name: '插件结果验收', version: '1.0.0', description: '按插件声明的规则检查已保存的运行产物、步骤与版本凭证，可与另一运行比较；不重执行原任务。',
    runtime: { type: 'native' }, capabilities: [CHECK_CAPABILITY], triggers: ['manual', 'agent'],
    inputSchema: { type: 'object', required: ['contractId', 'runId'], properties: { contractId: { type: 'string', minLength: 1, maxLength: 160 }, runId: { type: 'string', format: 'uuid' }, baselineRunId: { type: 'string', format: 'uuid' } }, additionalProperties: false }, outputSchema: { type: 'object' },
    requirements: { tools: [], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 30, maxSteps: 1, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};
function panels(report: RunCheckReport): StatusPanel[] {
    const subjects = [{ name: '受检结果', value: report.current }, ...(report.baseline ? [{ name: '基准结果', value: report.baseline }] : [])];
    const result: StatusPanel[] = subjects.map(({ name, value }) => ({ schemaVersion: '1.0', tone: value.verdict === 'passed' ? 'success' : value.verdict === 'failed' ? 'error' : 'warning',
        title: `${name}：${value.verdict === 'passed' ? '结构验收通过' : value.verdict === 'failed' ? '存在未通过项' : '缺少完整执行凭证'}`,
        description: `按 ${report.contract.title} v${report.contract.version} 检查保存的记录；不评判语义质量。完整规则和证据指纹保留在详情。`, checkedAt: report.checkedAt,
        items: [{ label: '执行 Agent 版本', value: [...new Set(value.executions.map(item => item.agentVersion))].join('、').slice(0, 160) || '旧记录未保存版本' },
            ...value.assertions.slice(0, 14).map(item => ({ label: item.label, value: item.verdict === 'passed' ? '通过' : item.verdict === 'failed' ? '未通过' : '无法核验', ...(item.message ? { detail: item.message } : {}) }))], relatedRun: { id: value.runId, label: `查看${name}原始运行` } }));
    if (report.comparison) result.unshift({ schemaVersion: '1.0', tone: report.comparison.regressed.length ? 'warning' : 'neutral', title: report.comparison.regressed.length ? '发现新增失败项' : '两次记录的规则检查已完成',
        description: '两次记录按同一份当前规则验收；差异不直接证明由插件升级造成。', checkedAt: report.checkedAt,
        items: [{ label: '新增失败', value: String(report.comparison.regressed.length), detail: report.comparison.regressed.join('、') }, { label: '恢复通过', value: String(report.comparison.improved.length) }, { label: '已记录请求输入', value: report.comparison.recordedRequestInputsMatch === true ? '序列化指纹相同' : report.comparison.recordedRequestInputsMatch === false ? '序列化指纹不同' : '无单次执行指纹可直接比较' }] });
    return result;
}
export const pluginChecksPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'quality.checks', name: '插件结果验收', version: '1.0.0', description: manifest.description }, agents: [{ manifest, installationId: 'install-plugin-checks' }],
    apply(ctx) {
        ctx.delivery.web.register({ id: 'quality.checks', pages: [{ path: '/checks', label: '结果验收', section: 'workspace', view: { kind: 'builtin', id: 'plugin-checks', capability: CHECK_CAPABILITY } }],
            api: { prefix: '/api/checks', routes: [{ method: 'GET', path: '/api/checks/contracts' }], handle: request => request.method === 'GET' && new URL(request.url).pathname === '/api/checks/contracts'
                ? Response.json({ contracts: ctx.delivery.checks.list() }) : Response.json({ error: '当前插件未提供此接口' }, { status: 404 }) },
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope);
            const report = await new RunCheckService(ctx.delivery.getContext().store, ctx.delivery.checks).check(request.scope, request.input, signal);
            return { status: 'succeeded', data: report, metrics: { modelCalls: 0, toolCalls: 0 }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: report, metadata: { privateKnowledge: true, title: '插件结果验收', statusPanels: panels(report) } }] };
        });
    },
};
export default pluginChecksPlugin;
