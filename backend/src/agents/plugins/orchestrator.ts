import { deliveryOpsAgentManifest, registerDeliveryOpsAgent } from '@/agents/orchestrator/deliveryOpsAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

export const orchestratorPlugin: FeaturePlugin = {
    manifest: {
        apiVersion: '1.0', id: 'builtin.orchestrator', name: 'Delivery orchestrator', version: '1.0.0',
        description: 'Coordinates bounded delivery capabilities.',
        requires: ['builtin.task', 'builtin.standup', 'builtin.daily-summary', 'builtin.weekly-report', 'builtin.dashboard'],
    },
    agents: [{ manifest: deliveryOpsAgentManifest, installationId: 'install-built-in-delivery-ops-agent' }],
    apply(ctx) { registerDeliveryOpsAgent(ctx.delivery.modelAgents); },
};
