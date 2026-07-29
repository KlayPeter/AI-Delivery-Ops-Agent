import type { SourceMessage } from '@/models/types';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';
import type { ToolRegistry } from '@/platform/tools/registry';
import { ContextResolver } from '@/services/messageHandler/ContextResolver';
import { TaskCommandHandler } from '@/services/messageHandler/handlers/TaskCommandHandler';
import type { HandlerContext } from '@/services/messageHandler/types';
import { TaskService } from '@/services/taskService';

export const TASK_AGENT_ID = 'built-in.task-agent';
export const TASK_AGENT_CAPABILITY = 'task.manage';
export const TASK_QUERY_TOOL_ID = 'task.query';
export const TASK_HANDLE_MESSAGE_TOOL_ID = 'task.handle_message';
export const TASK_SYNC_PROJECT_TOOL_ID = 'task.sync_project';

export const taskAgentManifest: AgentManifest = {
    schemaVersion: '1.1',
    id: TASK_AGENT_ID,
    name: 'Task Agent',
    version: '1.0.0',
    description: 'Owns task creation, tracking, status updates and project synchronization through the existing task domain services.',
    runtime: { type: 'model-loop', engine: 'ai-sdk' },
    capabilities: [TASK_AGENT_CAPABILITY],
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
        tools: [TASK_QUERY_TOOL_ID, TASK_HANDLE_MESSAGE_TOOL_ID, TASK_SYNC_PROJECT_TOOL_ID],
        secrets: [],
        networkHosts: [],
    },
    limits: { timeoutSeconds: 120, maxSteps: 8, maxToolCalls: 8, maxAgentCalls: 0, maxDepth: 2, maxOutputBytes: 256 * 1024 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
    modelProfile: 'balanced',
    skills: ['task-management'],
    memory: { mode: 'session', maxMessages: 20, ttlHours: 24 * 7 },
};

const taskAgentInstructions = `你是任务领域 Agent，只负责创建、查询、跟踪、更新任务以及同步项目任务。
所有任务读写必须调用已提供的工具，不能声称执行了未调用工具的操作。
当输入包含原始 message/source/replyContext 时，优先原样传给 task.handle_message，复用系统现有确定性规则和幂等逻辑。
若缺少负责人、标题、任务标识等关键字段，必须通过 request_human_input 请求补充，禁止猜测。
不要处理站会、日报、看板或闲聊；遇到越界请求要明确说明应交给对应 Agent。`;

export function registerTaskAgent(adapter: ModelLoopAgentAdapter): void {
    adapter.register(TASK_AGENT_ID, taskAgentManifest.version, {
        instructions: taskAgentInstructions,
        artifactTitle: '任务处理结果',
    });
}

export function registerTaskTools(registry: ToolRegistry, getContext: () => HandlerContext): void {
    registry.register({
        id: TASK_QUERY_TOOL_ID,
        version: '1.0.0',
        description: 'Query tasks by id, owner or status without changing task state.',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: { type: 'string' },
                ownerOpenId: { type: 'string' },
                status: { type: 'string' },
                includeDeleted: { type: 'boolean' },
            },
        },
        outputSchema: { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', items: { type: 'object' } } } },
        sideEffect: 'read',
        riskLevel: 'low',
        idempotent: true,
        timeoutSeconds: 15,
    }, async input => {
        const query = (input || {}) as { taskId?: string; ownerOpenId?: string; status?: string; includeDeleted?: boolean };
        const ctx = getContext();
        const tasks = query.taskId
            ? [await ctx.store.getTask(query.taskId)].filter(Boolean)
            : await ctx.store.listTasks(query.includeDeleted === true);
        return {
            tasks: tasks.filter((task: any) =>
                (!query.ownerOpenId || task.primary_owner_open_id === query.ownerOpenId || task.assignee_open_ids?.includes(query.ownerOpenId)) &&
                (!query.status || task.status === query.status)
            ),
        };
    });

    registry.register({
        id: TASK_HANDLE_MESSAGE_TOOL_ID,
        version: '1.0.0',
        description: 'Execute the existing deterministic task message workflow, including its validation, replies and idempotency safeguards.',
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
    }, async (input, execution) => {
        const payload = input as { message: SourceMessage; source: 'group' | 'private'; replyContext?: unknown };
        const trusted = execution.trustedContext as { message?: SourceMessage; source?: 'group' | 'private'; replyContext?: unknown } | undefined;
        const message = trusted?.message || payload.message;
        const source = trusted?.source || payload.source;
        const replyContext = trusted && Object.prototype.hasOwnProperty.call(trusted, 'replyContext') ? trusted.replyContext : payload.replyContext;
        if (!message || !['group', 'private'].includes(source)) throw new Error('Trusted task message context is required');
        const ctx = getContext();
        return TaskCommandHandler.maybeHandle(ctx, new ContextResolver(ctx), message, source, replyContext ?? null);
    });

    registry.register({
        id: TASK_SYNC_PROJECT_TOOL_ID,
        version: '1.0.0',
        description: 'Synchronize the configured project task scope from TAPD through TaskService.',
        inputSchema: {
            type: 'object',
            properties: {
                pageSize: { type: 'integer' },
                maxPages: { type: 'integer' },
            },
        },
        outputSchema: { type: 'object' },
        sideEffect: 'write',
        riskLevel: 'high',
        idempotent: true,
        timeoutSeconds: 120,
    }, input => TaskService.syncProjectScope(getContext(), input as any));
}
