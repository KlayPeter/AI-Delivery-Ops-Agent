import type { SourceMessage } from '@/models/types';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';
import type { ToolRegistry } from '@/platform/tools/registry';
import type { HandlerContext } from '@/services/messageHandler/types';
import { StandupService } from '@/services/standupService';

export const STANDUP_AGENT_ID = 'built-in.standup-agent';
export const STANDUP_AGENT_CAPABILITY = 'standup.manage';
export const STANDUP_QUERY_TOOL_ID = 'standup.query';
export const STANDUP_HANDLE_MESSAGE_TOOL_ID = 'standup.handle_message';
export const STANDUP_MISSING_MEMBERS_TOOL_ID = 'standup.missing_members';

export const standupAgentManifest: AgentManifest = {
    schemaVersion: '1.1',
    id: STANDUP_AGENT_ID,
    name: 'Standup Agent',
    version: '1.0.0',
    description: 'Owns standup recognition, submission, task linking and attendance queries through StandupService.',
    runtime: { type: 'model-loop', engine: 'ai-sdk' },
    capabilities: [STANDUP_AGENT_CAPABILITY],
    triggers: ['message', 'manual', 'agent'],
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string' },
            source: { type: 'string', enum: ['group', 'private'] },
            message: { type: 'object' },
            replyContext: { type: 'object' },
        },
    },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    requirements: {
        tools: [STANDUP_QUERY_TOOL_ID, STANDUP_HANDLE_MESSAGE_TOOL_ID, STANDUP_MISSING_MEMBERS_TOOL_ID],
        secrets: [],
        networkHosts: [],
    },
    limits: { timeoutSeconds: 120, maxSteps: 8, maxToolCalls: 8, maxAgentCalls: 0, maxDepth: 2, maxOutputBytes: 256 * 1024 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
    modelProfile: 'balanced',
    skills: ['standup-management'],
    memory: { mode: 'session', maxMessages: 20, ttlHours: 24 * 7 },
};

const standupAgentInstructions = `你是站会领域 Agent，只负责站会提交、补交、查询、缺交统计以及站会与任务的关联。
所有站会读写必须调用已提供的工具，不能绕过 StandupService，也不能声称执行了未调用工具的操作。
当输入包含原始 message/source/replyContext 时，优先原样传给 standup.handle_message，以保持现有归属判断、保存和回执行为。
群组归属或日期不明确时必须通过 request_human_input 请求补充，禁止猜测。
不要创建普通任务，不要生成日报或看板；遇到越界请求要交给对应 Agent。`;

export function registerStandupAgent(adapter: ModelLoopAgentAdapter): void {
    adapter.register(STANDUP_AGENT_ID, standupAgentManifest.version, {
        instructions: standupAgentInstructions,
        artifactTitle: '站会处理结果',
    });
}

export function registerStandupTools(registry: ToolRegistry, getContext: () => HandlerContext): void {
    registry.register({
        id: STANDUP_QUERY_TOOL_ID,
        version: '1.0.0',
        description: 'Query standup submissions for one date and optional group without changing state.',
        inputSchema: {
            type: 'object',
            required: ['date'],
            properties: { date: { type: 'string' }, groupId: { type: 'string' } },
        },
        outputSchema: { type: 'object', required: ['standups'], properties: { standups: { type: 'array', items: { type: 'object' } } } },
        sideEffect: 'read',
        riskLevel: 'low',
        idempotent: true,
        timeoutSeconds: 15,
    }, async input => {
        const query = input as { date: string; groupId?: string };
        return { standups: await getContext().store.listStandups(query.date, query.groupId || null) };
    });

    registry.register({
        id: STANDUP_HANDLE_MESSAGE_TOOL_ID,
        version: '1.0.0',
        description: 'Execute the existing StandupService message workflow with its current validation, storage, linking and reply behavior.',
        inputSchema: {
            type: 'object',
            required: ['message', 'source'],
            properties: {
                message: { type: 'object' },
                source: { type: 'string', enum: ['group', 'private'] },
                replyContext: { type: 'object' },
            },
        },
        outputSchema: {},
        sideEffect: 'write',
        riskLevel: 'high',
        idempotent: true,
        timeoutSeconds: 90,
    }, (input, execution) => {
        const payload = input as { message: SourceMessage; source: 'group' | 'private'; replyContext?: unknown };
        const trusted = execution.trustedContext as { message?: SourceMessage; source?: 'group' | 'private'; replyContext?: unknown } | undefined;
        const message = trusted?.message || payload.message;
        const source = trusted?.source || payload.source;
        const replyContext = trusted && Object.prototype.hasOwnProperty.call(trusted, 'replyContext') ? trusted.replyContext : payload.replyContext;
        if (!message || !['group', 'private'].includes(source)) throw new Error('Trusted standup message context is required');
        return StandupService.handlePrivateMessage(getContext(), message, source, replyContext ?? null);
    });

    registry.register({
        id: STANDUP_MISSING_MEMBERS_TOOL_ID,
        version: '1.0.0',
        description: 'List active group members who have not submitted a standup for a given day.',
        inputSchema: {
            type: 'object',
            required: ['groupId', 'date'],
            properties: { groupId: { type: 'string' }, date: { type: 'string' } },
        },
        outputSchema: { type: 'object', required: ['members'], properties: { members: { type: 'array', items: { type: 'object' } } } },
        sideEffect: 'read',
        riskLevel: 'low',
        idempotent: true,
        timeoutSeconds: 15,
    }, async input => {
        const query = input as { groupId: string; date: string };
        const day = new Date(`${query.date}T00:00:00+08:00`);
        if (Number.isNaN(day.getTime())) throw new Error('date must be YYYY-MM-DD');
        const ctx = getContext();
        return { members: await StandupService.missingMembers(ctx.config, ctx.store, query.groupId, day) };
    });
}
