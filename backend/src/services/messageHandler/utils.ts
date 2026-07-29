import type { SourceMessage, Task, BotMessageContext } from '@/models/types';
import { utcNowIso } from '@/models/types';
import type { HandlerContext } from './types';
import dayjs from 'dayjs';

export function stripBotMention(message: SourceMessage, ctx: HandlerContext): string {
    let text = message.text || "";
    for (const mention of (message.mentions || [])) {
        if (mention.open_id !== ctx.config.feishu.bot_open_id) continue;
        const names = [mention.name, ctx.config.feishu.bot_name].filter(Boolean);
        for (const name of names) {
            if (!name) continue;
            const regex = new RegExp(`@?${escapeRegExp(name)}\\s*`, 'g');
            text = text.replace(regex, "").trim();
        }
    }
    return text;
}

export function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sourceTrace(message: SourceMessage | any, aiResult?: any, confidence?: number): any {
    if ((message as SourceMessage).chat_type !== undefined) {
        const msg = message as SourceMessage;
        return {
            source_group_id: msg.chat_id || "",
            source_message_id: msg.id || "",
            source_message_ids: [msg.id || ""],
            sender_open_id: msg.sender_open_id || "",
            sender_name: msg.sender_name || "",
            sent_at: msg.sent_at || "",
            raw_text: msg.text || "",
            ai_result: aiResult || msg.ai_result || {},
            confidence: confidence !== undefined ? confidence : (msg.confidence || 0),
        };
    }
    const msgId = String(message.id || message.source_message_id || "");
    return {
        source_group_id: String(message.chat_id || message.source_group_id || ""),
        source_message_id: msgId,
        source_message_ids: msgId ? [msgId] : [],
        sender_open_id: String(message.sender_open_id || message.source_sender_open_id || ""),
        sender_name: String(message.sender_name || message.source_sender_name || ""),
        sent_at: String(message.sent_at || message.source_sent_at || ""),
        raw_text: String(message.text || message.raw_text || ""),
        ai_result: aiResult || message.ai_result || {},
        confidence: confidence !== undefined ? confidence : (message.confidence || 0),
    };
}

export function isSystemNoise(text: string): boolean {
    return text.includes("<system-reminder>") || text.includes("<cb_summary>") || text.startsWith("This is a summary");
}

export async function resolvePrivateSender(message: SourceMessage, ctx: HandlerContext) {
    if (message.sender_open_id) return (ctx.config.groups.flatMap(g => g.members).find(m => m.open_id === message.sender_open_id));
    const openId = await ctx.store.openIdForChatId(message.chat_id);
    return openId ? (ctx.config.groups.flatMap(g => g.members).find(m => m.open_id === openId)) : undefined;
}

export async function findTaskByTitle(title: string, ctx: HandlerContext): Promise<any> {
    let deletedMatch = null;
    for (const task of await ctx.store.listTasks(true)) {
        const taskTitle = task.title || "";
        if (taskTitle.includes(title) || title.includes(taskTitle)) {
            if (task.status === "deleted") deletedMatch = task;
            else return task;
        }
    }
    return deletedMatch;
}

export async function findUniqueTaskByTitle(title: string, ctx: HandlerContext): Promise<any> {
    const candidates = [];
    let deletedMatch = null;
    for (const task of await ctx.store.listTasks(true)) {
        const taskTitle = task.title || "";
        if (title === taskTitle || title.includes(taskTitle) || taskTitle.includes(title)) {
            if (task.status === "deleted") deletedMatch = task;
            else candidates.push(task);
        }
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0 && deletedMatch) return deletedMatch;
    return undefined;
}

export function parseIsoDatetime(value: string): dayjs.Dayjs | null {
    if (!value) return null;
    const dt = dayjs(value.replace("Z", ""));
    return dt.isValid() ? dt : null;
}

export async function syncTaskFromTapd(ctxOrTapd: any, taskData: any, explicitStore?: any): Promise<boolean> {
    const tapd = ctxOrTapd?.tapd || ctxOrTapd;
    const store = explicitStore || ctxOrTapd?.store;
    if (!taskData || !taskData.tapd_story_id || !tapd) return false;
    if (typeof tapd.getStory !== 'function') return false;

    let changed = false;
    try {
        const tapdResult = await tapd.getStory(taskData.tapd_story_id);

        if (tapdResult && tapdResult.ok && tapdResult.raw && tapdResult.raw.data) {
            const data = tapdResult.raw.data;

            if (Array.isArray(data) && data.length === 0) {
                if (taskData.status !== "deleted") {
                    taskData.status = "deleted";
                    changed = true;
                }
            } else if (data && typeof data === 'object') {
                const story = Array.isArray(data) ? (data[0].Story || data[0].story || data[0]) : (data.Story || data.story || data);
                if (story && typeof story === 'object') {
                    if (story.name && taskData.title !== story.name) { taskData.title = story.name; changed = true; }
                    if (story.description && taskData.description !== story.description) { taskData.description = story.description; changed = true; }
                    if (story.due && taskData.due_date !== story.due) { taskData.due_date = story.due; changed = true; }

                    if (story.status && ["resolved", "closed", "rejected", "done"].includes(String(story.status).toLowerCase())) {
                        if (taskData.status !== "accepted" && taskData.status !== "deleted") {
                            taskData.status = "accepted";
                            changed = true;
                        }
                    }
                }
            }
        } else if (tapdResult && !tapdResult.ok && String(tapdResult.error).includes("404")) {
             if (taskData.status !== "deleted") {
                 taskData.status = "deleted";
                 changed = true;
             }
        }

        if (changed && store && typeof store.saveTask === 'function') {
            await store.saveTask(taskData);
        }
        return changed;
    } catch (e) {
        console.error("Failed to sync task from TAPD", e);
        return false;
    }
}
