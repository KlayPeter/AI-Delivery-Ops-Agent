import { HandlerContext, TAPD_STATUS_BLOCKED } from '../types';
import { SourceMessage, utcNowIso } from '@/models/types';
import { ContextResolver } from '../ContextResolver';
import { stripBotMention, findTaskByTitle } from '../utils';
import { parseDueDateText, extractAcceptanceCriteria, hasExplicitTaskCreationIntent } from '@/services/taskParser';
import { reply } from '../statusUpdates';
import { taskDescription, privateConfirmationText, groupCreatedText } from '../taskCommands';
import { TaskService } from '@/services/taskService';
import {
    isDevelopmentCompletedTaskAction,
    isImplementedTaskAction,
    isTransferTestTaskAction,
} from '@/domains/task/actionPolicy';

export class StatusUpdateHandler {
    static async maybeHandle(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        const text = stripBotMention(message, ctx).trim();

        if (replyContext && replyContext.context_type === "pending_primary_owner") {
            const match = /主负责人\s*/.exec(text);
            if (match) {
                return await this.handlePendingOwner(ctx, message, source, replyContext, text);
            }
        }

        if (hasExplicitTaskCreationIntent(message.text || "")) return null;

        const explicitTaskAction = await extractExplicitTaskAction(ctx, message, text);
        if (explicitTaskAction) {
            const { action, identifier } = explicitTaskAction;
            let taskData = await ctx.store.findTask(identifier);
            if (!taskData) {
                await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
                return { handled: true, action: "task_not_found" };
            }
            if (taskData.status === "deleted") {
                await reply(ctx, message, source, deletedTaskText(taskData));
                return { handled: true, action: "task_deleted" };
            }
            if (isImplementedTaskAction(action, taskData)) {
                return await TaskService.applyAction(ctx, message, source, taskData, action, text);
            }
            if (isDevelopmentCompletedTaskAction(action, taskData)) return await TaskService.applyAction(ctx, message, source, taskData, "开发完成", text);
            if (isTransferTestTaskAction(action)) return await TaskService.applyAction(ctx, message, source, taskData, "转测试", text);
            return await TaskService.applyAction(ctx, message, source, taskData, action, text);
        }

        const contextualTask = await resolver.contextualTask(message, replyContext, text);
        const contextualProgress = contextualTask ? extractContextualProgress(text) : null;
        if (contextualTask && contextualProgress) {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? `\n🔗 详情：${contextualTask.tapd_url}` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await TaskService.saveProgress(ctx, message, source, contextualTask, contextualProgress);
        }

        if (contextualTask && replyContext && replyContext.context_type === "task_plan_request") {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? `\n🔗 详情：${contextualTask.tapd_url}` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await TaskService.savePlan(ctx, message, source, contextualTask, text);
        }

        const supplementMatch = /^\s*补充(.+)/s.exec(text);
        if (supplementMatch && contextualTask) {
            const dueDate = parseDueDateText(text) || parseDueDateText("时间" + supplementMatch[1]);
            const criteria = extractAcceptanceCriteria(text);

            if (dueDate || criteria.length > 0) {
                if (contextualTask.status === "deleted") {
                    const link = contextualTask.tapd_url ? `\n🔗 详情：${contextualTask.tapd_url}` : "";
                    await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                    return { handled: true, action: "task_deleted" };
                }
                return await TaskService.updateSupplement(ctx, message, source, contextualTask, dueDate, criteria, text);
            }
        }

        const dueRegex = /(?:截止时间|截止|完成时间)\s*(?:设置为|改为|调整为|设为|改到|到|[:：])/;
        const dueDate = (dueRegex.test(text) || (contextualTask && /(?:截止时间|截止|完成时间)\s*(?:设置为|改为|调整为|设为|改到|到|[:：])/.test(text))) ? parseDueDateText(text) : null;
        if (dueDate && contextualTask) {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? `\n🔗 详情：${contextualTask.tapd_url}` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await TaskService.updateDue(ctx, message, source, contextualTask, dueDate, text);
        }
        if (dueDate && !contextualTask) {
            await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_context_required" };
        }

        const contextAction = /^\s*(接受|拒绝|需要澄清|需求完成|开发完成|开发完毕|开发完了|转测试|提测|测试通过|验收通过|已实现|已经实现|验收完成|已完成|完成了|已经完成|已结束|已经结束|结束|恢复|解除阻塞|打回|删除|取消)(?:[:：].+)?\s*$/.exec(text);
        if (contextAction && contextualTask) {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? `\n🔗 详情：${contextualTask.tapd_url}` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            if (isImplementedTaskAction(contextAction[1], contextualTask)) {
                return await TaskService.applyAction(ctx, message, source, contextualTask, contextAction[1], text);
            }
            if (isDevelopmentCompletedTaskAction(contextAction[1], contextualTask)) return await TaskService.applyAction(ctx, message, source, contextualTask, "开发完成", text);
            if (isTransferTestTaskAction(contextAction[1])) return await TaskService.applyAction(ctx, message, source, contextualTask, "转测试", text);
            return await TaskService.applyAction(ctx, message, source, contextualTask, contextAction[1], text);
        }
        if (contextAction && !contextualTask) {
            await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_context_required" };
        }

        const progressMatch = /任务\s+(.+?)\s*(开发完成|开发完毕|开发完了|转测试|提测|已完成|完成了|已经完成|已实现|已经实现|验收完成|已结束|已经结束|结束|阻塞了|阻塞|进度[:：])(.+)?/.exec(text);
        if (progressMatch) {
            return await this.handleMatchedProgress(ctx, message, source, progressMatch[1].trim(), progressMatch[2], text);
        }

        const directMatch = /(.+?)\s*(开发完成|开发完毕|开发完了|转测试|提测|已完成|完成了|已经完成|已实现|已经实现|验收完成|已结束|已经结束|结束|阻塞了|阻塞|进度[:：])(.+)?$/.exec(text);
        if (directMatch) {
            const title = directMatch[1].trim();
            if (title && !["任务", "这个任务", "该任务"].includes(title)) {
                return await this.handleMatchedProgress(ctx, message, source, title, directMatch[2], text, true);
            }
        }

        if (contextualTask) {
            let handledAction = false;
            if (isDevelopmentCompletedTaskAction(text, contextualTask) || isTransferTestTaskAction(text) || isImplementedTaskAction(text, contextualTask) || /(需求完成|测试通过|解除阻塞|恢复)/.test(text)) handledAction = true;
            if (/(阻塞|阻塞了)/.test(text) && !/(不|没|未)阻塞/.test(text)) handledAction = true;
            if (text.startsWith("进度") || (replyContext && replyContext.context_type === "task_confirmation")) handledAction = true;

            if (handledAction) {
                if (contextualTask.status === "deleted") {
                    const link = contextualTask.tapd_url ? `\n🔗 详情：${contextualTask.tapd_url}` : "";
                    await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                    return { handled: true, action: "task_deleted" };
                }
                if (isImplementedTaskAction(text, contextualTask)) {
                    return await TaskService.applyAction(ctx, message, source, contextualTask, text.includes("验收通过") ? "验收通过" : "已实现", text);
                }
                if (/需求完成/.test(text)) return await TaskService.applyAction(ctx, message, source, contextualTask, "需求完成", text);
                if (/测试通过/.test(text)) return await TaskService.applyAction(ctx, message, source, contextualTask, "测试通过", text);
                if (/解除阻塞|恢复/.test(text)) return await TaskService.applyAction(ctx, message, source, contextualTask, text.includes("解除阻塞") ? "解除阻塞" : "恢复", text);
                if (isDevelopmentCompletedTaskAction(text, contextualTask)) return await TaskService.applyAction(ctx, message, source, contextualTask, "开发完成", text);
                if (isTransferTestTaskAction(text)) return await TaskService.applyAction(ctx, message, source, contextualTask, "转测试", text);
                if (/(阻塞|阻塞了)/.test(text) && !/(不|没|未)阻塞/.test(text)) {
                    return await TaskService.setStatus(ctx, message, source, contextualTask, "blocked", "blocked", text, TAPD_STATUS_BLOCKED);
                }
                return await TaskService.saveProgress(ctx, message, source, contextualTask, text);
            }
        }

        return null;
    }

    private static async handlePendingOwner(ctx: HandlerContext, message: SourceMessage, source: string, replyContext: any, text: string): Promise<any> {
        const targetMention = (message.mentions || []).find(m => m.open_id !== ctx.config.feishu.bot_open_id);
        if (!targetMention) {
            await reply(ctx, message, source, "请 @ 出主负责人。");
            return { handled: true, action: "missing_mention" };
        }

        const taskId = replyContext.task_id;
        const taskData = await ctx.store.getTask(taskId);
        if (!taskData) return { handled: true, action: "task_not_found" };

        taskData.primary_owner_open_id = targetMention.open_id;
        taskData.primary_owner_name = targetMention.name;
        if (!(taskData.assignee_open_ids || []).includes(targetMention.open_id)) {
            taskData.assignee_open_ids = [...(taskData.assignee_open_ids || []), targetMention.open_id];
            taskData.assignee_names = [...(taskData.assignee_names || []), targetMention.name];
        }

        const PRIORITY_TO_TAPD_LABEL_MOCK: Record<string, string> = { "P0": "High", "P1": "Middle", "P2": "Low", "P3": "Low" };
        const command = {
            should_create: true,
            reason: "owner_specified",
            title: taskData.title || "未命名任务",
            primary_owner: targetMention,
            assignees: (taskData.assignee_open_ids || []).map((oid: string, idx: number) => ({ open_id: oid, name: taskData.assignee_names[idx] })),
            priority: taskData.priority || "P2",
            tapd_priority_label: PRIORITY_TO_TAPD_LABEL_MOCK[taskData.priority || "P2"] || "Low",
            due_date: taskData.due_date,
            acceptance_criteria: taskData.acceptance_criteria || [],
            description: taskData.description || "",
            is_independent: false,
            missing_primary_owner: false,
            is_subtask: false
        };

        const description = taskDescription(message, command);
        const tapdResult = await ctx.tapd.createStory(
            command.title,
            targetMention.name,
            command.tapd_priority_label,
            command.due_date,
            description,
            taskData.parent_id,
            taskData.creator_name || message.sender_name || undefined
        );

        if (!tapdResult.ok) {
            await ctx.store.appendAuditLog("tapd_create_failed", { message_id: message.id, error: tapdResult.error });
            await ctx.feishu.sendReplyText(message.id, `任务创建失败：${tapdResult.error || 'TAPD API 调用失败'}`);
            return { handled: true, action: "tapd_create_failed", error: tapdResult.error };
        }

        taskData.tapd_story_id = tapdResult.story_id;
        taskData.tapd_url = tapdResult.url;
        taskData.status = "pending_confirmation";
        taskData.is_draft = false;
        taskData.updated_at = utcNowIso();

        await ctx.store.saveTask(taskData);
        await TaskService.saveUpdate(ctx, taskData, message.sender_open_id || "", message.sender_name || "", "primary_owner_set", `指定主负责人：${targetMention.name}`, source, message.id);

        const groupName = ctx.config.groups.find(g => g.chat_id === taskData.source_group_id)?.name || "未知来源";
        const privateText = privateConfirmationText(taskData, groupName);
        const privateResult = await ctx.feishu.sendPrivateText(targetMention.open_id, privateText);
        if (privateResult.chat_id) await ctx.store.updateChatId(targetMention.open_id, privateResult.chat_id);
        if (privateResult.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: privateResult.message_id,
                context_type: "task_confirmation",
                created_at: utcNowIso(),
                chat_id: privateResult.chat_id || "",
                chat_type: "p2p",
                target_open_id: targetMention.open_id,
                task_id: taskData.id,
                task_title: taskData.title,
                metadata: { tapd_story_id: taskData.tapd_story_id || "" }
            });
        }
        const groupResult = await ctx.feishu.sendReplyText(message.id, groupCreatedText(taskData));
        if (groupResult.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: groupResult.message_id,
                context_type: "task_group_notice",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                chat_type: "group",
                task_id: taskData.id,
                task_title: taskData.title,
                metadata: { tapd_story_id: taskData.tapd_story_id || "" }
            });
        }
        await ctx.store.appendAuditLog("task_created_after_owner_set", { task_id: taskData.id, title: taskData.title, owner: targetMention.name });
        return { handled: true, action: "task_created", task_id: taskData.id };
    }

    private static async handleMatchedProgress(ctx: HandlerContext, message: SourceMessage, source: string, title: string, statusWord: string, text: string, optional: boolean = false): Promise<any> {
        const taskData = await findTaskByTitle(title, ctx);
        if (!taskData) {
            if (optional) return null;
            await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_not_found" };
        }
        if (taskData.status === "deleted") {
            const link = taskData.tapd_url ? `\n🔗 详情：${taskData.tapd_url}` : "";
            await reply(ctx, message, source, `任务「${taskData.title}」${link} 已经被删除。`);
            return { handled: true, action: "task_deleted" };
        }
        if (statusWord.includes("阻塞")) return await TaskService.setStatus(ctx, message, source, taskData, "blocked", "blocked", text, TAPD_STATUS_BLOCKED);
        if (isImplementedTaskAction(statusWord, taskData)) return await TaskService.applyAction(ctx, message, source, taskData, statusWord, text);
        if (isDevelopmentCompletedTaskAction(statusWord, taskData)) return await TaskService.applyAction(ctx, message, source, taskData, "开发完成", text);
        if (isTransferTestTaskAction(statusWord)) return await TaskService.applyAction(ctx, message, source, taskData, "转测试", text);
        return await TaskService.saveProgress(ctx, message, source, taskData, text);
    }
}

function extractContextualProgress(text: string): string | null {
    const trimmed = text.trim();
    const match = /(?:更新|同步|记录|补充)?\s*(?:该|这个|当前)?\s*任务?\s*的?\s*进度\s*(?:为|到|是|[:：])?\s*(.+)$/s.exec(trimmed);
    if (!match) return null;

    const progress = match[1].trim();
    if (!progress || /^(为|到|是|[:：])?$/.test(progress)) return null;
    if (/^(哪|哪个|什么|多少)/.test(progress)) return null;
    return progress;
}

async function extractExplicitTaskAction(ctx: HandlerContext, message: SourceMessage, text: string): Promise<{ action: string; identifier: string } | null> {
    const relatedTexts: string[] = [];
    const seen = new Set<string>();
    if (typeof ctx.store.getSourceMessage === "function") {
        for (const msgId of [message.parent_id, message.root_id]) {
            if (!msgId || seen.has(msgId)) continue;
            seen.add(msgId);
            const sourceMessage = await ctx.store.getSourceMessage(msgId);
            if (sourceMessage?.text) relatedTexts.push(sourceMessage.text);
        }
    }

    const relatedText = relatedTexts.join("\n");
    const searchTexts = relatedText ? [text, `${text}\n${relatedText}`, `${relatedText}\n${text}`] : [text];
    for (const searchText of searchTexts) {
        const result = extractExplicitTaskActionFromText(searchText);
        if (result) return result;
    }
    return null;
}

function extractExplicitTaskActionFromText(text: string): { action: string; identifier: string } | null {
    const actions = "接受|拒绝|需要澄清|需求完成|测试通过|验收通过|已实现|已经实现|验收完成|开发完成|开发完毕|开发完了|转测试|提测|已完成|完成了|已经完成|已结束|已经结束|结束|恢复|解除阻塞|打回|删除|取消";
    const actionRegex = new RegExp(actions, "g");
    const identifierRegex = /https?:\/\/[^\s]+\/stories\/view\/\d{6,}|task-[A-Za-z0-9_-]+|\d{6,}/g;
    const actionMatches = Array.from(text.matchAll(actionRegex));
    const identifierMatches = Array.from(text.matchAll(identifierRegex));

    for (const actionMatch of actionMatches) {
        for (const identifierMatch of identifierMatches) {
            const actionIndex = actionMatch.index || 0;
            const identifierIndex = identifierMatch.index || 0;
            if (Math.abs(identifierIndex - actionIndex) <= 500) {
                return { action: actionMatch[0], identifier: extractTaskIdentifier(identifierMatch[0]) };
            }
        }
    }

    return null;
}

function extractTaskIdentifier(raw: string): string {
    const tapdStoryMatch = /\/stories\/view\/(\d{6,})/.exec(raw);
    return tapdStoryMatch ? tapdStoryMatch[1] : raw;
}

function deletedTaskText(taskData: any): string {
    const identifier = taskData.tapd_story_id || taskData.id || "未知ID";
    const link = taskData.tapd_url ? `\n🔗 详情：${taskData.tapd_url}` : "";
    return `该任务：${taskData.title || "未命名任务"} ${identifier} 已经被删除。${link}`;
}
