import { registerTaskAgent, registerTaskTools, taskAgentManifest } from '@/agents/domain/taskAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

export const taskPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.task', name: 'Task management', version: '1.0.0', description: 'Task Agent and governed task tools.' },
    agents: [{ manifest: taskAgentManifest, installationId: 'install-built-in-task-agent' }],
    skillPackages: ['task-management'],
    apply(ctx) {
        registerTaskTools(ctx.delivery.tools, ctx.delivery.getContext);
        registerTaskAgent(ctx.delivery.modelAgents);
    },
};
