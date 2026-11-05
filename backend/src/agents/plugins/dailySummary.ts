import { dailySummaryManifest, registerDailySummaryAgent } from '@/agents/native/dailySummaryAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs } from './jobs';

export const dailySummaryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.daily-summary', name: 'Daily summary', version: '1.0.0', description: 'Daily summaries through existing domain services.' },
    agents: [{ manifest: dailySummaryManifest, installationId: 'install-native-daily-summary' }],
    apply(ctx) { registerDailySummaryAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext)); },
};
