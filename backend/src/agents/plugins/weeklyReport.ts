import { weeklyReportManifest, registerWeeklyReportAgent } from '@/agents/native/weeklyReportAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { pluginJobs } from './jobs';
import { WeeklyReportHandler } from '@/services/messageHandler/handlers/WeeklyReportHandler';
import { zonedClock } from '@/core/scheduleTime';
import { calendarPlan } from '@/platform/scheduling/calendar';
import { StandupService } from '@/services/standupService';
import { createWeeklyReportApi } from '@/domains/weeklyReport/api';

export const weeklyReportPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.weekly-report', name: 'Weekly report', version: '1.0.0', description: 'Weekly reports with persisted delivery evidence.' },
    agents: [{ manifest: weeklyReportManifest, installationId: 'install-native-weekly-report' }],
    schedules: [{
        id: 'weekly-report', kind: 'timed', priority: 200, agent: true,
        plan(context) {
            const schedule = context.group.schedule;
            if (schedule.weekly_report_enabled === false || schedule.module_weekly_report_enabled === false || !StandupService.isGroupEnabled(context.group)) return null;
            const clock = zonedClock(context.now, schedule.weekly_report_timezone);
            if (!clock || new Date(`${clock.date}T12:00:00Z`).getUTCDay() !== 5 || clock.time !== schedule.weekly_report) return null;
            return calendarPlan(context, clock.date, clock.time, context.now, true);
        },
        run(context) {
            if (!context.agents) throw new Error('Weekly Report Agent dispatcher is not configured');
            return context.agents.weeklyReport(context.group.chat_id, context.day, context.retryAttempt);
        },
    }],
    messageRoutes: [{
        id: 'builtin.weekly-report', priority: 800, sources: ['group'], help: '生成本周/上周周报',
        handle: ({ ctx, message }) => WeeklyReportHandler.maybeHandle(ctx, message, 'group'),
    }],
    apply(ctx) {
        const api = createWeeklyReportApi(ctx.delivery.getContext);
        ctx.delivery.web.register({ id: 'builtin.weekly-report',
            pages: [{ path: '/weekly-reports', label: '周报', section: 'team', view: { kind: 'builtin', id: 'weekly-reports' } }],
            api: { prefix: '/api/weekly-reports', routes: api.routes.map(route => ({ method: route.method, path: route.path })), handle: request => api.handle(request) },
        });
        registerWeeklyReportAgent(ctx.delivery.nativeAgents, () => pluginJobs(ctx.delivery.getContext));
    },
};
