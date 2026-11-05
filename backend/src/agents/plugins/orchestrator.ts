import { deliveryOpsAgentManifest, registerDeliveryOpsAgent } from '@/agents/orchestrator/deliveryOpsAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { AgentFallbackHandler } from '@/services/messageHandler/handlers/AgentFallbackHandler';

export const orchestratorPlugin: FeaturePlugin = {
    manifest: {
        apiVersion: '1.0', id: 'builtin.orchestrator', name: 'Delivery orchestrator', version: '1.0.0',
        description: 'Coordinates bounded delivery capabilities.',
        requires: ['builtin.task', 'builtin.standup', 'builtin.daily-summary', 'builtin.weekly-report', 'builtin.dashboard'],
    },
    agents: [{ manifest: deliveryOpsAgentManifest, installationId: 'install-built-in-delivery-ops-agent' }],
    messageRoutes: [
        {
            id: 'builtin.orchestrator.context', phase: 'context', priority: 300, sources: ['group', 'private'],
            requiresProjectMember: true,
            matches: ({ replyContext }) => replyContext?.context_type === 'agent_checkpoint',
            handle: ({ ctx, message, source, replyContext }) => AgentFallbackHandler.maybeResume(ctx, message, source, replyContext),
        },
        {
            id: 'builtin.orchestrator', priority: 100, sources: ['group', 'private'], requiresProjectMember: true,
            handle: ({ ctx, message, source, replyContext }) => AgentFallbackHandler.maybeHandle(ctx, message, source, replyContext),
        },
    ],
    apply(ctx) { registerDeliveryOpsAgent(ctx.delivery.modelAgents); },
};
