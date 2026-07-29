import { WEEKLY_REPORT_CAPABILITY } from "@/agents/native/weeklyReportAgent";
import type { SourceMessage } from "@/models/types";
import type { WeeklyPeriodKind } from "@/domains/weeklyReport/types";
import { StandupService } from "@/services/standupService";
import type { HandlerContext } from "../types";
import { parseIsoDatetime } from "../utils";

const WEEKLY_ACTION = /(生成|出|做|发|发送|来一份|重新生成|更新|刷新)/;
const WEEKLY_NEGATION = /(不要|不用|别|取消|停止|关闭|暂停).{0,8}周报|周报.{0,8}(不要|不用|别|取消|停止|关闭|暂停)/;
const WEEKLY_META_QUESTION = /周报.{0,12}(什么时候|几点|配置|设置|规则|逻辑|口径|怎么|如何|为什么|设计)/;

export class WeeklyReportHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private"): Promise<any> {
        if (source !== "group") return null;
        const text = message.text || "";
        if (!this.isRequest(text)) return null;

        const group = ctx.config.groups.find(item => item.chat_id === message.chat_id);
        if (!group) return { handled: true, action: "weekly_report_failed", reason: "unknown_group" };
        if (!StandupService.isGroupEnabled(group)) {
            await ctx.feishu.sendReplyText(message.id, "当前群未开启日报站会，暂不生成周报。请先在群配置中开启站会模块和每日站会推送。");
            return { handled: true, action: "weekly_report_failed", reason: "standup_disabled" };
        }
        if (!ctx.agentDispatcher?.isAvailable()) {
            await ctx.feishu.sendReplyText(message.id, "周报 Agent 尚未就绪，请稍后重试。");
            return { handled: true, action: "weekly_report_failed", reason: "agent_unavailable" };
        }

        const period: WeeklyPeriodKind = /上周|上一周/.test(text) ? "last_week" : "current_week";
        const cutoffAt = this.messageTime(message).toISOString();
        try {
            await ctx.feishu.sendReplyText(
                message.id,
                `⏳ 已开始同步 TAPD 并汇总${period === "last_week" ? "上周" : "本周"}站会，完成后会在群里发送周报链接。`,
            );
        } catch (error: any) {
            await Promise.resolve(ctx.store.appendAuditLog("weekly_report_progress_reply_failed", {
                group_id: group.chat_id,
                source_message_id: message.id,
                error: String(error?.message || error),
            })).catch(() => {});
        }
        await ctx.store.appendAuditLog("weekly_report_requested", {
            group_id: group.chat_id,
            period,
            source_message_id: message.id,
            cutoff_at: cutoffAt,
        });
        const result = await ctx.agentDispatcher.runManual(
            WEEKLY_REPORT_CAPABILITY,
            group.chat_id,
            {
                groupId: group.chat_id,
                period,
                cutoffAt,
                sourceMessageId: message.id,
            },
            message.id,
        );
        return {
            handled: true,
            action: "weekly_report",
            period,
            run_id: result.run_id,
            status: result.status,
        };
    }

    static isRequest(text: string): boolean {
        if (!text.includes("周报")) return false;
        if (WEEKLY_NEGATION.test(text)) return false;
        if (WEEKLY_META_QUESTION.test(text) && !WEEKLY_ACTION.test(text)) return false;
        return WEEKLY_ACTION.test(text);
    }

    private static messageTime(message: SourceMessage): Date {
        const value = String(message.sent_at || "");
        if (/^\d+$/.test(value)) {
            const numeric = Number(value);
            const date = new Date(value.length <= 10 ? numeric * 1000 : numeric);
            if (!Number.isNaN(date.getTime())) return date;
        }
        const parsed = parseIsoDatetime(value);
        return parsed?.toDate() || new Date();
    }
}
