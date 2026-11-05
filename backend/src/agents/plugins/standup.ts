import { registerStandupAgent, registerStandupTools, standupAgentManifest } from '@/agents/domain/standupAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { StandupHandler } from '@/services/messageHandler/handlers/StandupHandler';
import { looksLikeStandup } from '@/services/standup';

const standupContexts = new Set(['standup_prompt', 'standup_receipt', 'task_standup_template', 'standup_commitment_prompt']);
const unmentionedContexts = new Set(['task_standup_template', 'standup_commitment_prompt']);

export const standupPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.standup', name: 'Standup management', version: '1.0.0', description: 'Standup Agent and governed standup tools.' },
    agents: [{ manifest: standupAgentManifest, installationId: 'install-built-in-standup-agent' }],
    skillPackages: ['standup-management'],
    messageRoutes: [
        {
            id: 'builtin.standup.context', phase: 'context', priority: 200, sources: ['group', 'private'],
            requiresProjectMember: true,
            matches: ({ replyContext, message }) => standupContexts.has(replyContext?.context_type) || looksLikeStandup(message.text || ''),
            acceptsUnmentionedReply: context => unmentionedContexts.has(context?.context_type),
            handle: ({ ctx, message, source, replyContext }) => StandupHandler.maybeHandle(ctx, message, source, replyContext),
        },
        {
            id: 'builtin.standup', priority: 900, sources: ['group', 'private'],
            requiresProjectMember: true, help: '提交站会报告或登记带交付时间的任务型站会事项',
            handle: ({ ctx, message, source, replyContext }) => StandupHandler.maybeHandle(ctx, message, source, replyContext),
        },
    ],
    apply(ctx) {
        registerStandupTools(ctx.delivery.tools, ctx.delivery.getContext);
        registerStandupAgent(ctx.delivery.modelAgents);
    },
};
