import { dashboardManifest, registerDashboardAgent } from '@/agents/native/dashboardAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs, scheduledPluginJobs } from './jobs';
import { DashboardHandler } from '@/services/messageHandler/handlers/DashboardHandler';
import { localTimePlan } from '@/platform/scheduling/calendar';

export const dashboardPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.dashboard', name: 'Project dashboard', version: '1.0.0', description: 'Project snapshots through the dashboard domain service.' },
    agents: [{ manifest: dashboardManifest, installationId: 'install-native-dashboard' }],
    schedules: [{
        id: 'dashboard', kind: 'timed', priority: 300, agent: true,
        plan(context) {
            const schedule = context.group.schedule;
            return schedule.dashboard_enabled === false || schedule.module_dashboard_enabled === false
                ? null : localTimePlan(context, schedule.dashboard);
        },
        run: context => context.agents
            ? context.agents.dashboard(context.group.chat_id, context.day, context.retryAttempt)
            : scheduledPluginJobs(context).dashboardGenerate(context.group.chat_id, context.day),
    }],
    messageRoutes: [{
        id: 'builtin.dashboard', priority: 600, sources: ['group'], help: '生成项目看板',
        handle: ({ ctx, message }) => DashboardHandler.maybeHandle(ctx, message, 'group'),
    }],
    apply(ctx) {
        ctx.delivery.web.register({ id: 'builtin.dashboard', manualJobs: ['dashboard'] });
        registerDashboardAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext));
    },
};
