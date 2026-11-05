import { registerTaskAgent, registerTaskTools, taskAgentManifest } from '@/agents/domain/taskAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { StatusUpdateHandler } from '@/services/messageHandler/handlers/StatusUpdateHandler';
import { TaskCommandHandler } from '@/services/messageHandler/handlers/TaskCommandHandler';

const taskContexts = new Set([
    'task_confirmation', 'task_plan_request', 'task_group_notice', 'task_acceptance_prompt',
    'missing_task_field', 'task_status_notice', 'task_thread', 'pending_primary_owner',
]);

export const taskPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.task', name: 'Task management', version: '1.0.0', description: 'Task Agent and governed task tools.' },
    agents: [{ manifest: taskAgentManifest, installationId: 'install-built-in-task-agent' }],
    skillPackages: ['task-management'],
    messageRoutes: [
        {
            id: 'builtin.task.context', phase: 'context', priority: 100, sources: ['group', 'private'],
            requiresProjectMember: true,
            matches: ({ replyContext }) => taskContexts.has(replyContext?.context_type),
            async handle({ ctx, resolver, message, source, replyContext }) {
                return await StatusUpdateHandler.maybeHandle(ctx, resolver, message, source, replyContext)
                    || TaskCommandHandler.maybeHandle(ctx, resolver, message, source, replyContext);
            },
        },
        {
            id: 'builtin.task.status', priority: 400, sources: ['group', 'private'],
            requiresProjectMember: true, help: '接受、打回、完成任务，或回复具体进度',
            handle: ({ ctx, resolver, message, source, replyContext }) => StatusUpdateHandler.maybeHandle(ctx, resolver, message, source, replyContext),
        },
        {
            id: 'builtin.task.command', priority: 300, sources: ['group', 'private'],
            requiresProjectMember: true, help: '创建/安排/子任务',
            prepare({ message, replyContext }) {
                const original = replyContext?.metadata?.original_text;
                if (replyContext?.context_type === 'missing_task_field' && original) message.text = `${original} ${message.text}`;
            },
            handle: ({ ctx, resolver, message, source, replyContext }) => TaskCommandHandler.maybeHandle(ctx, resolver, message, source, replyContext),
        },
    ],
    apply(ctx) {
        registerTaskTools(ctx.delivery.tools, ctx.delivery.getContext);
        registerTaskAgent(ctx.delivery.modelAgents);
    },
};
