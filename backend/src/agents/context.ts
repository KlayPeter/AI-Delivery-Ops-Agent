import type { HandlerContext } from '@/services/messageHandler/types';
import { TapdAdapter } from '@/adapters/tapd';
import { LLMAdapter } from '@/adapters/llm';
import { EmailAdapter } from '@/adapters/email';
import { DashboardService } from '@/services/dashboard';
import { ProjectDashboardService } from '@/services/projectDashboard';
import { DashboardImageService } from '@/services/dashboardImage';
import { MessageIntentParser } from '@/services/messageIntent';

type ContextBase = Pick<HandlerContext, 'config' | 'store' | 'feishu' | 'messageRoutes' | 'schedules' | 'agentOrchestrator' | 'agentDispatcher'>;

export function createDeliveryOpsContext(base: ContextBase): HandlerContext {
    let tapd: TapdAdapter | undefined, dashboard: DashboardService | undefined;
    let projectDashboard: ProjectDashboardService | undefined, email: EmailAdapter | undefined, intentParser: MessageIntentParser | undefined;
    const { config, store } = base;
    const context: HandlerContext = {
        ...base,
        get tapd() { return tapd ??= new TapdAdapter(config.tapd); },
        get dashboard() { return dashboard ??= new DashboardService(store, config.data_path, config.project.name, config.runtime.public_base_url); },
        get projectDashboard() { return projectDashboard ??= new ProjectDashboardService({ config, store, tapd: context.tapd, dashboard: context.dashboard, renderer: new DashboardImageService() }); },
        get email() { return config.email.enabled ? email ??= new EmailAdapter(config.email, false) : null; },
        get intentParser() { return intentParser ??= new MessageIntentParser(new LLMAdapter(config.ai)); },
    };
    return context;
}
