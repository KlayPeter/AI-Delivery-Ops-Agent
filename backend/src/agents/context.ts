import { FeishuAdapter } from '@/adapters/feishu';
import type { HandlerContext } from '@/services/messageHandler/types';
import { TapdAdapter } from '@/adapters/tapd';
import { LLMAdapter } from '@/adapters/llm';
import { EmailAdapter } from '@/adapters/email';
import { DashboardService } from '@/services/dashboard';
import { ProjectDashboardService } from '@/services/projectDashboard';
import { DashboardImageService } from '@/services/dashboardImage';
import { MessageIntentParser } from '@/services/messageIntent';

type ContextBase = Pick<HandlerContext, 'config' | 'store' | 'messageRoutes' | 'schedules' | 'agentOrchestrator' | 'agentDispatcher'> & Partial<Pick<HandlerContext, 'feishu'>> & { isTransportAvailable?: () => boolean };

export function createDeliveryOpsContext(base: ContextBase): HandlerContext {
    let tapd: TapdAdapter | undefined, dashboard: DashboardService | undefined;
    let projectDashboard: ProjectDashboardService | undefined, email: EmailAdapter | undefined, intentParser: MessageIntentParser | undefined;
    const { config, store } = base;
    let feishu = base.feishu;
    const context: HandlerContext = {
        ...base,
        get feishu() {
            if (base.isTransportAvailable?.() === false) throw new Error('Feishu transport is not installed');
            if (!feishu) {
                const knownNames: Record<string, string> = {};
                for (const group of config.groups) for (const member of group.members) knownNames[member.open_id] = member.name;
                feishu = new FeishuAdapter(config.feishu, false, knownNames);
                feishu.setAuditCallback((action, payload) => { store.appendAuditLog(action, payload).catch(console.error); });
            }
            return feishu;
        },
        get tapd() { return tapd ??= new TapdAdapter(config.tapd); },
        get dashboard() { return dashboard ??= new DashboardService(store, config.data_path, config.project.name, config.runtime.public_base_url); },
        get projectDashboard() { return projectDashboard ??= new ProjectDashboardService({ config, store, tapd: context.tapd, dashboard: context.dashboard, renderer: new DashboardImageService() }); },
        get email() { return config.email.enabled ? email ??= new EmailAdapter(config.email, false) : null; },
        get intentParser() { return intentParser ??= new MessageIntentParser(new LLMAdapter(config.ai)); },
    };
    return context;
}
