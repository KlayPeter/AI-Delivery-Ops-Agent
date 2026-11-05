import { weeklyReportManifest, registerWeeklyReportAgent } from '@/agents/native/weeklyReportAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs } from './jobs';

export const weeklyReportPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.weekly-report', name: 'Weekly report', version: '1.0.0', description: 'Weekly reports with persisted delivery evidence.' },
    agents: [{ manifest: weeklyReportManifest, installationId: 'install-native-weekly-report' }],
    apply(ctx) { registerWeeklyReportAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext)); },
};
