import { weeklyReportManifest, registerWeeklyReportAgent } from '@/agents/native/weeklyReportAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs } from './jobs';
import { WeeklyReportHandler } from '@/services/messageHandler/handlers/WeeklyReportHandler';

export const weeklyReportPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.weekly-report', name: 'Weekly report', version: '1.0.0', description: 'Weekly reports with persisted delivery evidence.' },
    agents: [{ manifest: weeklyReportManifest, installationId: 'install-native-weekly-report' }],
    messageRoutes: [{
        id: 'builtin.weekly-report', priority: 800, sources: ['group'], help: '生成本周/上周周报',
        handle: ({ ctx, message }) => WeeklyReportHandler.maybeHandle(ctx, message, 'group'),
    }],
    apply(ctx) { registerWeeklyReportAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext)); },
};
