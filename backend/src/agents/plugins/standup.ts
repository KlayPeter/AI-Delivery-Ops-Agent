import { registerStandupAgent, registerStandupTools, standupAgentManifest } from '@/agents/domain/standupAgent';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { StandupHandler } from '@/services/messageHandler/handlers/StandupHandler';
import { looksLikeStandup } from '@/services/standup';
import dayjs from 'dayjs';
import { isScheduleDateEnabled } from '@/core/scheduleCalendar';
import { localTimePlan } from '@/platform/scheduling/calendar';
import type { GroupScheduleContext } from '@/platform/scheduling/registry';
import { scheduledPluginJobs } from './jobs';

const standupContexts = new Set(['standup_prompt', 'standup_receipt', 'task_standup_template', 'standup_commitment_prompt']);
const unmentionedContexts = new Set(['task_standup_template', 'standup_commitment_prompt']);

function standupPlan(context: GroupScheduleContext, key: string) {
    const schedule = context.group.schedule;
    return schedule.module_standup_enabled === false || schedule[`${key}_enabled`] === false
        ? null : localTimePlan(context, schedule[key]);
}

export const standupPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.standup', name: 'Standup management', version: '1.0.0', description: 'Standup Agent and governed standup tools.' },
    agents: [{ manifest: standupAgentManifest, installationId: 'install-built-in-standup-agent' }],
    skillPackages: ['standup-management'],
    schedules: [
        {
            id: 'task-standup-remind', kind: 'poll', priority: 1100,
            async run(context) {
                const groupId = context.group.chat_id;
                if (!isScheduleDateEnabled(dayjs(context.now).format('YYYY-MM-DD'), context.group.schedule, true)) return {};
                try {
                    const result = await scheduledPluginJobs(context).taskStandupRemindDue(groupId, context.now);
                    return result.sent || result.failed ? { [`task-standup-remind:${groupId}`]: result.failed ? 'completed_with_warnings' : 'completed' } : {};
                } catch (error: any) {
                    await context.ctx.store.appendAuditLog('standup_commitment_reminder_failed', { group_id: groupId, error: error?.message || String(error) });
                    return { [`task-standup-remind:${groupId}`]: 'failed' };
                }
            },
        },
        {
            id: 'standup-push', kind: 'timed', priority: 1000,
            plan: context => standupPlan(context, 'standup_push'),
            run: context => scheduledPluginJobs(context).standupPush(context.group.chat_id, context.day),
        },
        {
            id: 'task-standup-template', kind: 'timed', priority: 900,
            plan: context => context.group.schedule.task_standup_enabled === true && context.group.schedule.module_standup_enabled !== false
                ? localTimePlan(context, context.group.schedule.task_standup_template) : null,
            run: context => scheduledPluginJobs(context).taskStandupTemplate(context.group.chat_id, context.day),
        },
        {
            id: 'standup-second-remind', kind: 'timed', priority: 800,
            plan: context => standupPlan(context, 'standup_second_remind'),
            run: context => scheduledPluginJobs(context).standupSecondRemind(context.group.chat_id, context.day),
        },
        {
            id: 'standup-summary', kind: 'timed', priority: 700,
            plan: context => standupPlan(context, 'standup_summary'),
            run: context => scheduledPluginJobs(context).standupSummary(context.group.chat_id, context.day),
        },
        {
            id: 'standup-supplement-summary', kind: 'timed', priority: 600,
            plan(context) {
                const schedule = context.group.schedule;
                if (schedule.module_standup_enabled === false || schedule.standup_summary_enabled === false) return null;
                const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule.standup_summary || ''));
                if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
                const nextHour = Number(match[1]) + 1;
                const time = `${String(nextHour % 24).padStart(2, '0')}:${match[2]}`;
                const day = nextHour >= 24 ? dayjs(context.now).subtract(1, 'day').toDate() : context.now;
                return localTimePlan(context, time, day);
            },
            run: context => scheduledPluginJobs(context).standupSupplementSummary(context.group.chat_id, context.day),
        },
    ],
    messageRoutes: [
        {
            id: 'builtin.standup.context', phase: 'context', priority: 200, sources: ['group', 'private'],
            requiresProjectMember: true,
            matches: ({ replyContext, message }) => standupContexts.has(replyContext?.context_type) || looksLikeStandup(message.text || ''),
            acceptsUnmentionedReply: context => unmentionedContexts.has(context?.context_type),
            handle: ({ ctx, message, source, replyContext }) => StandupHandler.maybeHandle(ctx, message, source, replyContext),
        },
        {
            id: 'builtin.standup', priority: 900, sources: ['group', 'private'],
            requiresProjectMember: true, help: '提交站会报告或登记带交付时间的任务型站会事项',
            handle: ({ ctx, message, source, replyContext }) => StandupHandler.maybeHandle(ctx, message, source, replyContext),
        },
    ],
    apply(ctx) {
        registerStandupTools(ctx.delivery.tools, ctx.delivery.getContext);
        registerStandupAgent(ctx.delivery.modelAgents);
    },
};
