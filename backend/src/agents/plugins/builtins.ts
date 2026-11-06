import { standardModelPlugins } from '@/platform/models/providers';
import { aiNewsPlugin } from './aiNews';
import { dailySummaryPlugin } from './dailySummary';
import { dashboardPlugin } from './dashboard';
import { weeklyReportPlugin } from './weeklyReport';
import { taskPlugin } from './task';
import { standupPlugin } from './standup';
import { orchestratorPlugin } from './orchestrator';
import { meetingSummaryPlugin } from './meetingSummary';
import { aiHotSchedulePlugin } from './aiHotSchedule';
import { directoryPlugin } from './directory';
import { configurationPlugin } from './configuration';
import { maintenancePlugin } from './maintenance';

export const deliveryTeamPlugins = [
    ...standardModelPlugins,
    maintenancePlugin,
    configurationPlugin,
    directoryPlugin, aiNewsPlugin, dailySummaryPlugin, dashboardPlugin, weeklyReportPlugin, taskPlugin, standupPlugin, orchestratorPlugin, meetingSummaryPlugin, aiHotSchedulePlugin,
] as const;
