import { DashboardService } from '@/services/dashboard';
import { ScheduledJobs } from '@/services/jobs';
import type { HandlerContext } from '@/services/messageHandler/types';

export function pluginJobs(getContext: () => HandlerContext): ScheduledJobs {
    const ctx = getContext();
    const dashboard = new DashboardService(ctx.store, ctx.config.data_path, ctx.config.project.name, ctx.config.runtime.public_base_url);
    return new ScheduledJobs(ctx.config, ctx.store, ctx.feishu, dashboard, ctx.tapd, ctx.intentParser?.llm);
}
