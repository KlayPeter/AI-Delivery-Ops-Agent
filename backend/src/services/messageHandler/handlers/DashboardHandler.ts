import { HandlerContext } from '../types';
import { SourceMessage } from '@/models/types';
import dayjs from 'dayjs';

const DASHBOARD_KEYWORDS = ["看板", "驾驶舱", "项目概览", "进展页", "进度页"];
const DASHBOARD_NEGATION = /(不要|不用|别|取消|停止|关闭|暂停).{0,8}(看板|驾驶舱|项目概览|进展页|进度页)|(看板|驾驶舱|项目概览|进展页|进度页).{0,8}(不要|不用|别|取消|停止|关闭|暂停)/;
const DASHBOARD_ACTION = /(生成|刷新|重新|发一份|发下|给我|打开|看一下|看下|看看|有吗|来一份|出一份|最新)/;
const DASHBOARD_META_QUESTION = /(什么时候|几点|配置|设置|规则|逻辑|样式|设计|口径|区分|怎么|如何|为什么|有问题|检查一下)/;

export class DashboardHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private"): Promise<any> {
        if (source !== "group") return null;

        const text = message.text || "";
        if (this.isDashboardRequest(text)) {
            const targetGroup = ctx.config.groups.find(g => g.chat_id === message.chat_id);
            if (!targetGroup) return { handled: true, reason: "unknown_group_for_dashboard" };

            const explicit = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
            let targetDay = dayjs();
            if (explicit) {
                targetDay = dayjs(`${explicit[1]}-${explicit[2]}-${explicit[3]}`);
            } else if (text.includes("前天")) {
                targetDay = targetDay.subtract(2, 'day');
            } else if (["昨日", "昨天"].some(k => text.includes(k))) {
                targetDay = targetDay.subtract(1, 'day');
            }

            const isCurrentDay = targetDay.isSame(dayjs(), 'day');
            const artifact = isCurrentDay
                ? (await ctx.projectDashboard.generateFresh(targetDay.toDate(), "manual", targetGroup.chat_id)).artifact
                : await ctx.projectDashboard.findHistoricalSnapshot(targetDay.format('YYYY-MM-DD'), targetGroup.chat_id);

            if (!artifact) {
                await ctx.feishu.sendReplyText(message.id, `${targetDay.format('YYYY-MM-DD')} 暂无已保存的看板快照。历史看板不会用当前数据补生成。`);
                return { handled: true, action: "dashboard_missing", date: targetDay.format('YYYY-MM-DD') };
            }

            const stateText = isCurrentDay ? "已刷新 TAPD 并生成新快照" : "历史快照";
            const dashboardBaseUrl =
              ctx.config.runtime?.public_base_url ||
              "http://localhost:8080/";
            const dashboardQuery = new URLSearchParams({
                groupId: targetGroup.chat_id,
                dashboardId: artifact.id,
            }).toString();
            const dashboardUrl = artifact.public_url || `${dashboardBaseUrl}${dashboardBaseUrl.includes("?") ? "&" : "?"}${dashboardQuery}`;
            const replyText = `${stateText}。${artifact.image_path ? "\n完整看板图片已发送。" : ""}\n[打开在线看板](${dashboardUrl})`;

            if (artifact.image_path) {
                const uploaded = await ctx.feishu.uploadImage(artifact.image_path);
                if (uploaded.ok && uploaded.image_key) {
                    const sent = await ctx.feishu.sendReplyImageKey(uploaded.image_key, message.id);
                    if (!sent.ok) {
                        await ctx.store.appendAuditLog("dashboard_image_delivery_failed", { artifact_id: artifact.id, message_id: message.id, error: sent.error || sent.raw });
                    }
                } else {
                    await ctx.store.appendAuditLog("dashboard_image_delivery_failed", { artifact_id: artifact.id, message_id: message.id, error: uploaded.error || uploaded.raw });
                }
            }
            await ctx.feishu.sendReplyMarkdown(message.id, replyText, `进度看板 · ${artifact.date}`);
            if (!isCurrentDay) {
                await ctx.store.appendAuditLog("dashboard_snapshot_viewed", { artifact_id: artifact.id, requested_by_group_id: targetGroup.chat_id });
            }
            return { handled: true, action: "dashboard", artifact: artifact.html_path };
        }
        return null;
    }

    private static isDashboardRequest(text: string): boolean {
        const hasDashboardKeyword = DASHBOARD_KEYWORDS.some(k => text.includes(k));
        if (!hasDashboardKeyword) return false;
        if (DASHBOARD_NEGATION.test(text)) return false;
        if (DASHBOARD_META_QUESTION.test(text) && !DASHBOARD_ACTION.test(text)) return false;
        return DASHBOARD_ACTION.test(text) || DASHBOARD_KEYWORDS.some(keyword => text.trim().endsWith(keyword));
    }
}
