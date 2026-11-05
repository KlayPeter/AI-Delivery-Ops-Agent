import { dailySummaryManifest, registerDailySummaryAgent } from '@/agents/native/dailySummaryAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs } from './jobs';
import { SummaryHandler } from '@/services/messageHandler/handlers/SummaryHandler';

export const dailySummaryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.daily-summary', name: 'Daily summary', version: '1.0.0', description: 'Daily summaries through existing domain services.' },
    agents: [{ manifest: dailySummaryManifest, installationId: 'install-native-daily-summary' }],
    messageRoutes: [{
        id: 'builtin.daily-summary', priority: 700, sources: ['group'], help: '生成/发送群聊日报',
        handle: ({ ctx, message }) => SummaryHandler.maybeHandle(ctx, message, 'group'),
    }],
    apply(ctx) { registerDailySummaryAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext)); },
};
