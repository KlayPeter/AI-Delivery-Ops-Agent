import { HandlerContext } from '../types';
import { SourceMessage } from '@/models/types';
import { buildDailySummary, renderDailySummary } from '@/services/summaries';
import { ScheduledJobs } from '@/services/jobs';
import dayjs from 'dayjs';
import { parseIsoDatetime } from '../utils';

const SUMMARY_KEYWORDS = ["日报", "日总结", "群聊总结", "研发总结", "每日总结", "总结聊天", "聊天总结", "总结一下"];
const SUMMARY_NEGATION = /(不要|不用|别|取消|停止|关闭|暂停).{0,8}(日报|日总结|群聊总结|研发总结|每日总结|总结聊天|聊天总结|总结一下)|(日报|日总结|群聊总结|研发总结|每日总结|总结聊天|聊天总结|总结一下).{0,8}(不要|不用|别|取消|停止|关闭|暂停)/;
const SUMMARY_META_QUESTION = /(日报|日总结|群聊总结|研发总结|每日总结|总结聊天|聊天总结|总结一下).{0,12}(什么时候|几点|配置|设置|规则|怎么|如何)/;

export class SummaryHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private"): Promise<any> {
        if (source !== "group") return null;

        const text = message.text || "";
        if (!this.isSummaryRequest(text)) return null;

        const targetDay = this.requestedDay(text, this.messageDay(message));

        const targetGroup = ctx.config.groups.find(g => g.chat_id === message.chat_id);
        if (!targetGroup) {
            await ctx.feishu.sendPrivateText(message.sender_open_id || "", "晚报生成只能在群聊中触发，或者我无法识别您所在的群聊。");
            return { handled: true, action: "daily_summary_failed" };
        }

        const period = targetGroup.daily_summary_period || "00:00-23:59";
        const dateText = targetDay.format('YYYY-MM-DD');
        const startedAt = Date.now();
        await ctx.store.appendAuditLog("daily_summary_started", {
            date: dateText,
            trigger: "group_command",
            source_message_id: message.id,
            group_id: targetGroup.chat_id,
        });
        try {
            await ctx.feishu.sendReplyText(
                message.id,
                `⏳ 已收到，正在同步 ${dateText} 的群聊记录并生成日报，通常需要 10～30 秒。`,
            );
        } catch (error: any) {
            await ctx.store.appendAuditLog("daily_summary_progress_reply_failed", {
                date: dateText,
                source_message_id: message.id,
                group_id: targetGroup.chat_id,
                error: String(error?.message || error),
            });
        }
        const jobs = new ScheduledJobs(ctx.config, ctx.store, ctx.feishu, ctx.dashboard, ctx.tapd);
        await jobs.backfillGroupMessagesForSummary(targetGroup.chat_id, targetDay.toDate(), period);

        const summary = await buildDailySummary(ctx.store, targetGroup.chat_id, targetDay.toDate(), ctx.intentParser?.llm, period);
        await ctx.store.saveDailySummary(summary);

        const rendered = renderDailySummary(summary);
        await ctx.feishu.sendReplyMarkdown(message.id, rendered);
        await ctx.store.appendAuditLog("daily_summary_generated", {
            date: dateText,
            trigger: "group_command",
            source_message_id: message.id,
            group_id: targetGroup.chat_id,
            duration_ms: Date.now() - startedAt,
        });

        return { handled: true, action: "daily_summary", summary_id: summary.id, date: dateText };
    }

    private static isSummaryRequest(text: string): boolean {
        const hasSummaryKeyword = SUMMARY_KEYWORDS.some(k => text.includes(k));
        if (!hasSummaryKeyword) return false;
        if (SUMMARY_NEGATION.test(text)) return false;
        if (SUMMARY_META_QUESTION.test(text)) return false;
        return true;
    }

    private static messageDay(message: SourceMessage): Date {
        const val = String(message.sent_at || "");
        if (/^\d+$/.test(val)) return new Date(parseInt(val));
        const dt = parseIsoDatetime(val);
        return dt ? dt.toDate() : new Date();
    }

    private static requestedDay(text: string, messageDay: Date): dayjs.Dayjs {
        const baseDay = dayjs(messageDay);
        const fullDate = text.match(/(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:日|号)?/);
        if (fullDate) {
            const parsed = this.validCalendarDay(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3]));
            if (parsed) return parsed;
        }

        const monthDay = text.match(/(?:^|\D)(\d{1,2})\s*(?:月|[/.-])\s*(\d{1,2})(?:日|号)?/);
        if (monthDay) {
            let year = baseDay.year();
            let parsed = this.validCalendarDay(year, Number(monthDay[1]), Number(monthDay[2]));
            if (parsed && parsed.isAfter(baseDay.endOf('day'))) {
                year -= 1;
                parsed = this.validCalendarDay(year, Number(monthDay[1]), Number(monthDay[2]));
            }
            if (parsed) return parsed;
        }

        if (text.includes("大前天")) return baseDay.subtract(3, 'day');
        if (text.includes("前天")) return baseDay.subtract(2, 'day');
        if (["昨日", "昨天"].some(k => text.includes(k))) return baseDay.subtract(1, 'day');
        return baseDay;
    }

    private static validCalendarDay(year: number, month: number, day: number): dayjs.Dayjs | null {
        const parsed = dayjs(new Date(year, month - 1, day, 12, 0, 0, 0));
        if (parsed.year() !== year || parsed.month() !== month - 1 || parsed.date() !== day) return null;
        return parsed;
    }
}
