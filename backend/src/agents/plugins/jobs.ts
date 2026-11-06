import { DashboardService } from '@/services/dashboard';
import { ScheduledJobs, type ScheduledJobOptions } from '@/services/jobs';
import type { HandlerContext } from '@/services/messageHandler/types';
import type { GroupScheduleContext } from '@/platform/scheduling/registry';

export function pluginJobs(getContext: () => HandlerContext, options?: ScheduledJobOptions): ScheduledJobs {
    const ctx = getContext();
    const dashboard = new DashboardService(ctx.store, ctx.config.data_path, ctx.config.project.name, ctx.config.runtime.public_base_url);
    return new ScheduledJobs(ctx.config, ctx.store, ctx.feishu, dashboard, ctx.tapd, ctx.intentParser?.llm, options);
}

export function scheduledPluginJobs(context: GroupScheduleContext): ScheduledJobs {
    let jobs = context.resources.get(pluginJobs) as ScheduledJobs | undefined;
    if (!jobs) {
        jobs = pluginJobs(() => context.ctx);
        context.resources.set(pluginJobs, jobs);
    }
    return jobs;
}
