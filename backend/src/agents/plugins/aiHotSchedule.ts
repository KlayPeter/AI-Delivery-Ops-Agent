import { createAiHotInstallHandler } from '@/agents/external/aiHotApi';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { localTimePlan } from '@/platform/scheduling/calendar';

export const aiHotSchedulePlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.ai-hot-schedule', name: 'External AI Hot schedule', version: '1.0.0', description: 'Schedules the separately installed external AI Hot capability.' },
    schedules: [{
        id: 'ai-hot', kind: 'timed', priority: 100, agent: true,
        plan(context) {
            const schedule = context.group.schedule;
            return schedule.ai_hot_enabled === false || schedule.module_ai_hot_enabled === false
                ? null : localTimePlan(context, schedule.ai_hot);
        },
        run(context) {
            if (!context.agents) throw new Error('AI Hot Agent dispatcher is not configured');
            return context.agents.aiHot(context.group.chat_id, context.day, context.retryAttempt);
        },
    }],
    apply(ctx) {
        ctx.delivery.web.register({ id: 'builtin.ai-hot-install', api: { prefix: '/api/agents/ai-hot', routes: [{ method: 'POST', path: '/api/agents/ai-hot/install' }], handle: createAiHotInstallHandler(ctx.delivery.installExternal) } });
    },
};
