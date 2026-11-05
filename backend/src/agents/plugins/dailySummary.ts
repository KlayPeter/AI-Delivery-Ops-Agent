import { dailySummaryManifest, registerDailySummaryAgent } from '@/agents/native/dailySummaryAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs, scheduledPluginJobs } from './jobs';
import { SummaryHandler } from '@/services/messageHandler/handlers/SummaryHandler';
import { localTimePlan } from '@/platform/scheduling/calendar';

export const dailySummaryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.daily-summary', name: 'Daily summary', version: '1.0.0', description: 'Daily summaries through existing domain services.' },
    agents: [{ manifest: dailySummaryManifest, installationId: 'install-native-daily-summary' }],
    schedules: [{
        id: 'daily-summary', kind: 'timed', priority: 400, agent: true,
        plan(context) {
            const schedule = context.group.schedule;
            return schedule.daily_summary_enabled === false || schedule.module_daily_summary_enabled === false
                ? null : localTimePlan(context, schedule.daily_summary);
        },
        run: context => context.agents
            ? context.agents.dailySummary(context.group.chat_id, context.day, context.retryAttempt)
            : scheduledPluginJobs(context).dailySummary(context.group.chat_id, context.day),
    }],
    messageRoutes: [{
        id: 'builtin.daily-summary', priority: 700, sources: ['group'], help: '生成/发送群聊日报',
        handle: ({ ctx, message }) => SummaryHandler.maybeHandle(ctx, message, 'group'),
    }],
    apply(ctx) {
        ctx.delivery.web.register({ id: 'builtin.daily-summary', manualJobs: ['daily-summary'] });
        registerDailySummaryAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext));
    },
};
