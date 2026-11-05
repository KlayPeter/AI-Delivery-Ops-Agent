import { z } from 'zod';
import * as path from 'node:path';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { requirePersonalScope } from '../scope';
import { KnowledgeWritebackService, newNotePatch, prepareInput, applyInput, writebackConfig, writebackInput, type NoteProposal } from './service';

export const WRITEBACK_CAPABILITY = 'knowledge.note.writeback';
const prepareTool = 'knowledge.note.prepare', writeTool = 'knowledge.note.create';
const inputSchema = { type: 'object', properties: { operation: { enum: ['prepare', 'apply'] }, sourceRunId: { type: 'string' }, title: { type: 'string' }, markdown: { type: 'string' }, proposalId: { type: 'string' }, reviewedSha256: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['operation'], additionalProperties: false };
const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
export function createKnowledgeWritebackPlugin(source = { pluginId: 'knowledge.markdown', versionsTool: 'knowledge.markdown.versions', kind: 'markdown' as 'markdown' | 'web' | 'mixed' }): FeaturePlugin {
    const sourceCalls = source.kind === 'mixed' ? 3 : 1;
    const manifest: AgentManifest = {
        schemaVersion: '1.1', id: 'native.knowledge-writeback', name: '知识笔记回写', version: '1.0.0',
        description: '从带引用的成功回答或发布草稿生成新笔记提案，人工审查固定内容后重验来源版本并在所选目录排他创建；不覆盖已有笔记，不调用模型。',
        runtime: { type: 'native' }, capabilities: [WRITEBACK_CAPABILITY], triggers: ['manual'], inputSchema, outputSchema: { type: 'object' },
        requirements: { tools: [prepareTool, writeTool, source.versionsTool], secrets: [], networkHosts: [] },
        limits: { timeoutSeconds: 90, maxSteps: sourceCalls + 2, maxToolCalls: sourceCalls + 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 }, delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
    };
    return {
        manifest: { apiVersion: '1.0', id: 'knowledge.writeback', name: manifest.name, version: '1.0.0', description: manifest.description, requires: [source.pluginId] }, Config: writebackConfig,
        agents: [{ manifest, installationId: 'install-knowledge-writeback' }],
        async apply(ctx, raw) {
            const config = writebackConfig.parse(raw), service = new KnowledgeWritebackService(config.outputRoot, ctx.delivery.getContext().store, kind => source.kind === 'mixed' || kind === source.kind);
            const directory = (await service.directory()).directory;
            ctx.effect(() => () => service.drain());
            ctx.delivery.web.register({ id: 'knowledge.writeback', pages: [{ path: '/knowledge-writeback', label: '笔记回写', section: 'workspace', view: { kind: 'builtin', id: 'knowledge-writeback', capability: WRITEBACK_CAPABILITY } }],
                api: { prefix: '/api/knowledge-writeback', routes: [{ method: 'GET', path: '/api/knowledge-writeback/proposals' }, { method: 'GET', path: '/api/knowledge-writeback/proposal' }, { method: 'GET', path: '/api/knowledge-writeback/source' }], async handle(request) {
                    const url = new URL(request.url);
                    if (request.method !== 'GET') return Response.json({ error: '接口不存在' }, { status: 404 });
                    try {
                        if (url.pathname === '/api/knowledge-writeback/proposals' && !url.search) return Response.json({ directory, proposals: (await service.list(scope)).map(({ id, title, state, sourceRunId, createdAt, savedAt }) => ({ id, title, state, sourceRunId, createdAt, savedAt })) });
                        const field = url.pathname === '/api/knowledge-writeback/source' ? 'runId' : url.pathname === '/api/knowledge-writeback/proposal' ? 'proposalId' : '';
                        if (!field || url.search.length > 100 || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has(field)) throw new Error();
                        const id = z.string().uuid().parse(url.searchParams.get(field));
                        if (field === 'runId') return Response.json(await service.source(scope, id));
                        const proposal = await service.get(scope, id); return Response.json({ ...proposal, patch: newNotePatch(proposal) });
                    } catch { return Response.json({ error: '无法读取所选记录；仅支持当前范围内带已核验引用的成功回答或发布草稿，请核对插件来源与提案 ID' }, { status: 400 }); }
                } },
            });
            for (const id of [prepareTool, writeTool]) ctx.delivery.tools.register({ id, version: '1.0.0', description: id === prepareTool ? 'Prepare a bounded new-note patch from the actual cited source run; no note file is written.' : 'Create exactly the manually reviewed note in a fixed configured inbox after checking the original evidence versions; never overwrite a file.',
                inputSchema, outputSchema: { type: 'object' }, sideEffect: 'write', riskLevel: id === writeTool ? 'high' : 'low', idempotent: true, timeoutSeconds: 70 }, async (value, execution) => {
                requirePersonalScope(execution.scope);
                if (execution.scope.triggerType !== 'manual' || !execution.budget) throw new Error('笔记回写需要本机人工操作与共享工具预算');
                const check = (documents: NoteProposal['references']) => ctx.delivery.toolGateway.execute(source.versionsTool, { documents: documents.map(({ path, sourceKey, documentVersion }) => ({ path, sourceKey, documentVersion })) }, { ...execution, allowedTools: [source.versionsTool], idempotencyKey: undefined, budget: execution.budget });
                return id === prepareTool ? service.prepare(execution.scope, execution.runId, prepareInput.parse(value), check, execution.signal) : service.apply(execution.scope, applyInput.parse(value), check, execution.signal);
            });
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope); const input = writebackInput.parse(request.input), budget = new RunToolCallBudget(sourceCalls + 1);
                const proposal = await ctx.delivery.toolGateway.execute(input.operation === 'prepare' ? prepareTool : writeTool, input, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal, allowedTools: manifest.requirements.tools, budget, idempotencyKey: `${request.runId}:writeback` }) as Awaited<ReturnType<KnowledgeWritebackService['prepare']>>;
                const saved = proposal.state === 'saved', data = { proposal, patch: newNotePatch(proposal), directory, targetPath: path.join(directory, proposal.filename) };
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: budget.used }, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data,
                    metadata: { privateKnowledge: true, artifactRole: saved ? 'knowledge.note.receipt' : 'knowledge.note.proposal', title: saved ? '笔记保存回执' : '新笔记提案', statusPanels: [{ schemaVersion: '1.0', tone: saved ? 'success' : 'warning', title: saved ? '新笔记已创建并读回核验' : '提案已生成，尚未写入笔记', description: saved ? '这是保存时的回执。原笔记与原运行保持；不会监控此文件后续是否变化，引用核验不证明内容语义正确。' : '审查完整内容、来源和收件目录后明确确认。写入前会再次检查原引用；任何变化或无法核验都拒绝写入。', checkedAt: proposal.checkedAt,
                        items: [{ label: '目标文件', value: proposal.filename, detail: directory }, { label: '审查指纹', value: proposal.approvalSha256 }, { label: '实际知识来源', value: `${proposal.references.length} 份` }] }] } }] };
            });
        },
    };
}
export const knowledgeWritebackPlugin = createKnowledgeWritebackPlugin();
export default knowledgeWritebackPlugin;
