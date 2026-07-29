import { SourceMessage } from '@/models/types';
import { ContextResolver } from './ContextResolver';
import { ContextRouter } from './ContextRouter';
import { HandlerContext } from './types';
import { DashboardHandler } from './handlers/DashboardHandler';
import { MeetingSummaryHandler } from './handlers/MeetingSummaryHandler';
import { StandupHandler } from './handlers/StandupHandler';
import { StatusUpdateHandler } from './handlers/StatusUpdateHandler';
import { SummaryHandler } from './handlers/SummaryHandler';
import { TaskCommandHandler } from './handlers/TaskCommandHandler';
import { AgentFallbackHandler } from './handlers/AgentFallbackHandler';
import { reply } from './statusUpdates';
import { WeeklyReportHandler } from './handlers/WeeklyReportHandler';

type MessageSource = "group" | "private";
type MessageRouteId = "context" | "standup" | "weekly_report" | "daily_summary" | "dashboard" | "meeting_summary" | "status_update" | "task_command" | "agent_fallback";

export const MESSAGE_ROUTE_POLICY: ReadonlyArray<{
    id: MessageRouteId;
    priority: number;
    sources: readonly MessageSource[];
}> = [
    { id: "context", priority: 1000, sources: ["group", "private"] },
    { id: "standup", priority: 900, sources: ["group", "private"] },
    { id: "weekly_report", priority: 800, sources: ["group"] },
    { id: "daily_summary", priority: 700, sources: ["group"] },
    { id: "dashboard", priority: 600, sources: ["group"] },
    { id: "meeting_summary", priority: 500, sources: ["group", "private"] },
    { id: "status_update", priority: 400, sources: ["group", "private"] },
    { id: "task_command", priority: 300, sources: ["group", "private"] },
    { id: "agent_fallback", priority: 100, sources: ["group", "private"] },
];

export class MessageRouter {
    static async handleGroup(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, replyContext: any): Promise<any> {
        return this.handle(ctx, resolver, message, "group", replyContext);
    }

    static async handlePrivate(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, replyContext: any): Promise<any> {
        return this.handle(ctx, resolver, message, "private", replyContext);
    }

    private static async handle(
        ctx: HandlerContext,
        resolver: ContextResolver,
        message: SourceMessage,
        source: MessageSource,
        replyContext: any,
    ): Promise<any> {
        const handlers: Record<MessageRouteId, () => Promise<any>> = {
            context: () => ContextRouter.maybeHandle(ctx, resolver, message, source, replyContext),
            standup: () => StandupHandler.maybeHandle(ctx, message, source, replyContext),
            weekly_report: () => WeeklyReportHandler.maybeHandle(ctx, message, "group"),
            daily_summary: () => SummaryHandler.maybeHandle(ctx, message, "group"),
            dashboard: () => DashboardHandler.maybeHandle(ctx, message, "group"),
            meeting_summary: () => MeetingSummaryHandler.maybeHandle(ctx, message, source),
            status_update: () => StatusUpdateHandler.maybeHandle(ctx, resolver, message, source, replyContext),
            task_command: () => TaskCommandHandler.maybeHandle(ctx, resolver, message, source, replyContext),
            agent_fallback: () => AgentFallbackHandler.maybeHandle(ctx, message, source, replyContext),
        };
        const routes = MESSAGE_ROUTE_POLICY
            .filter(route => route.sources.includes(source))
            .sort((left, right) => right.priority - left.priority);

        for (const route of routes) {
            const result = await handlers[route.id]();
            if (result) return result;
        }

        if (source === "group") {
            await reply(ctx, message, source, "抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n- 创建/安排/子任务\n- 对我回复接受、打回、完成某任务\n- 回复具体进度\n- 生成/发送群聊日报\n- 生成本周/上周周报");
            return { handled: true, action: "unrecognized_command", reason: "no_valid_intent_found" };
        }
        await reply(ctx, message, source, "抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n- 创建任务、安排一下\n- 向我发送站会报告\n- 对我回复接受、打回、完成某任务\n- 更新任务具体进度\n- 生成/发送群聊日报");
        return { handled: true, action: "unrecognized_command", reason: "no_private_command" };
    }
}
