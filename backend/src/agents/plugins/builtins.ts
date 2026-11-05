import { aiNewsPlugin } from './aiNews';
import { dailySummaryPlugin } from './dailySummary';
import { dashboardPlugin } from './dashboard';
import { weeklyReportPlugin } from './weeklyReport';
import { taskPlugin } from './task';
import { standupPlugin } from './standup';
import { orchestratorPlugin } from './orchestrator';

export const deliveryTeamPlugins = [
    aiNewsPlugin, dailySummaryPlugin, dashboardPlugin, weeklyReportPlugin, taskPlugin, standupPlugin, orchestratorPlugin,
] as const;
