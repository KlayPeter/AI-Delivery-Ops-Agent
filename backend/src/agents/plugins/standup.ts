import { registerStandupAgent, registerStandupTools, standupAgentManifest } from '@/agents/domain/standupAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

export const standupPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.standup', name: 'Standup management', version: '1.0.0', description: 'Standup Agent and governed standup tools.' },
    agents: [{ manifest: standupAgentManifest, installationId: 'install-built-in-standup-agent' }],
    skillPackages: ['standup-management'],
    apply(ctx) {
        registerStandupTools(ctx.delivery.tools, ctx.delivery.getContext);
        registerStandupAgent(ctx.delivery.modelAgents);
    },
};
