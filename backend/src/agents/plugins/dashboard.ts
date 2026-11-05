import { dashboardManifest, registerDashboardAgent } from '@/agents/native/dashboardAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs } from './jobs';

export const dashboardPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.dashboard', name: 'Project dashboard', version: '1.0.0', description: 'Project snapshots through the dashboard domain service.' },
    agents: [{ manifest: dashboardManifest, installationId: 'install-native-dashboard' }],
    apply(ctx) { registerDashboardAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext)); },
};
