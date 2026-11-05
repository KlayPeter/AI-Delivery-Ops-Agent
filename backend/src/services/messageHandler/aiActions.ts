import { HandlerContext, AI_CONFIDENCE_THRESHOLD, PRIORITY_TO_TAPD_LABEL, TAPD_STATUS_IN_PROGRESS, TAPD_STATUS_TESTING, TAPD_STATUS_BLOCKED } from './types';
import { SourceMessage, Task, utcNowIso, Mention } from '@/models/types';
import { ContextResolver } from './ContextResolver';
import { MessageIntent, IntentFields, IntentTaskDraft } from '@/services/messageIntent';
import { findUniqueTaskByTitle, stripBotMention } from './utils';
import { reply } from './statusUpdates';
import { notifyTaskCreatorPrivate, createSingleTask, buildTask } from './taskCommands';
import { parseDueDateText, ParsedTaskCommand } from '@/services/taskParser';
import { TaskService } from '@/services/taskService';
import { TaskAttachmentService } from '@/domains/task/attachments';
import dayjs from 'dayjs';

export async function maybeHandleAiIntent(
    ctx: HandlerContext,
    resolver: ContextResolver,
    message: SourceMessage,
    source: string,
    replyContext: any,
    explicitCreateCommand?: ParsedTaskCommand
): Promise<any> {
    if (!ctx.intentParser || !resolver.shouldConsiderAi(message, source, replyContext)) return null;

    const contextualTask = await resolver.taskFromReplyContext(replyContext);
    const allMembers = ctx.config.groups.flatMap(g => g.members);

    let intent: MessageIntent;
    try {
        intent = await ctx.intentParser.parse(
            message,
            replyContext,
            contextualTask,
            allMembers,
            undefined,
            explicitCreateCommand ? "create_task" : undefined
        );
    } catch (error: any) {
        const failure = aiIntentFailure(error);
        await auditAiIntentFailure(ctx, message, failure);
        await saveAiFallbackMetadata(ctx, message, failure);
        return null;
    }
    if (!intent.available) {
        const failure = aiIntentFailure(intent.error);
        await auditAiIntentFailure(ctx, message, failure);
        await saveAiFallbackMetadata(ctx, message, failure);
        return null;
    }
    if (explicitCreateCommand) {
        constrainToExplicitCreate(intent, explicitCreateCommand);
    }

    message.ai_result = intentPayload(intent);
    message.confidence = intent.confidence;
    ctx.store.saveSourceMessage(message);

    if (intent.needs_clarification || intent.confidence < AI_CONFIDENCE_THRESHOLD) {
        if (intent.clarification) {
            await sendAiClarificationReply(ctx, message, source, intent.clarification);
            auditAiIntent(ctx, message, intent, false, "clarification");
            return { handled: true, action: "ai_clarification", intent: intent.intent };
        }
        auditAiIntent(ctx, message, intent, false, "low_confidence");
        return null;
    }

    const taskData = await resolveAiTask(ctx, intent, contextualTask);
    let result: any = null;
    let reason = "";

    if (intent.intent === "update_task") {
        if (!taskData) {
            result = await aiClarification(ctx, message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required");
            reason = "missing_task";
        } else {
            result = await updateTaskFields(ctx, message, source, taskData, intent.fields);
            reason = result ? result.action : "no_fields";
        }
    } else if (intent.intent === "add_progress") {
        if (!taskData) {
            result = await aiClarification(ctx, message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required");
            reason = "missing_task";
        } else {
            const progress = intent.fields.progress || stripBotMention(message, ctx).trim();
            result = await TaskService.saveProgress(ctx, message, source, taskData, progress);
            reason = "progress_saved";
        }
    } else if (intent.intent === "change_status") {
        if (!taskData) {
            result = await aiClarification(ctx, message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required");
            reason = "missing_task";
        } else {
            result = await applyAiStatusAction(ctx, message, source, taskData, intent.fields.status_action);
            reason = result ? result.action : "unsupported_status_action";
        }
    } else if (intent.intent === "create_task") {
        result = await createTaskFromAiIntent(ctx, message, intent);
        reason = result ? result.action : "missing_create_fields";
    } else if (intent.intent === "unknown") {
        reason = "unknown";
    }

    if (result) {
        auditAiIntent(ctx, message, intent, result.handled || false, reason);
        return result;
    }
    auditAiIntent(ctx, message, intent, false, reason || "not_executed");
    return null;
}

type AiIntentFailure = {
    category: "rate_limited" | "timeout" | "unavailable";
    error: string;
};

function aiIntentFailure(error: unknown): AiIntentFailure {
    const messageText = String(error instanceof Error ? error.message : error || "AI intent unavailable").slice(0, 500);
    const category = /too many requests|rate limit|quota|\b429\b/i.test(messageText)
        ? "rate_limited"
        : /timed out|timeout|abort/i.test(messageText)
            ? "timeout"
            : "unavailable";
    return { category, error: messageText };
}

async function auditAiIntentFailure(ctx: HandlerContext, message: SourceMessage, failure: AiIntentFailure): Promise<void> {
    try {
        await ctx.store.appendAuditLog("ai_intent_failed", {
            message_id: message.id,
            category: failure.category,
            error: failure.error,
            fallback: "deterministic_rule",
        });
    } catch (auditError) {
        console.error("Failed to audit AI intent failure:", auditError);
    }
}

async function saveAiFallbackMetadata(ctx: HandlerContext, message: SourceMessage, failure: AiIntentFailure): Promise<void> {
    message.ai_result = {
        type: "message_intent",
        parser: "llm",
        available: false,
        category: failure.category,
        fallback: "deterministic_rule",
    };
    message.confidence = 0;
    try {
        await ctx.store.saveSourceMessage(message);
    } catch (saveError) {
        console.error("Failed to persist AI fallback metadata:", saveError);
    }
}

function constrainToExplicitCreate(intent: MessageIntent, command: ParsedTaskCommand): void {
    intent.intent = "create_task";
    intent.confidence = Math.max(intent.confidence, AI_CONFIDENCE_THRESHOLD);
    intent.needs_clarification = false;
    intent.clarification = "";

    if (intent.tasks.length > 0) return;

    const assignees = command.assignees.length
        ? command.assignees
        : (command.primary_owner ? [command.primary_owner] : []);
    intent.fields.title ||= command.title;
    intent.fields.description ||= command.description;
    intent.fields.due_date ||= command.due_date || "";
    intent.fields.priority ||= command.priority;
    intent.fields.owner_open_id ||= assignees.map(assignee => assignee.open_id).filter(Boolean).join(",");
}

async function updateTaskFields(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, fields: IntentFields): Promise<any> {
    await TaskService.syncFromTapd(ctx, taskData);
    const changes: string[] = [];
    let replyTitle = taskData.title;

    if (fields.title) {
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryTitle(taskData.tapd_story_id, fields.title);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.title = fields.title;
        replyTitle = fields.title;
        changes.push(`标题：${fields.title}`);
    }

    if (fields.description) {
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryDescription(taskData.tapd_story_id, fields.description);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.description = fields.description;
        changes.push(`详细信息：${fields.description}`);
    }

    if (fields.due_date) {
        const dueDate = dayjs(fields.due_date).isValid() ? fields.due_date : null;
        if (!dueDate) {
            await sendAiClarificationReply(ctx, message, source, "截止时间格式不明确，支持的格式如：YYYY-MM-DD，本周三，下周三，本月6号，明天等。");
            return { handled: true, action: "ai_clarification", reason: "invalid_due_date" };
        }
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryDueDate(taskData.tapd_story_id, fields.due_date);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.due_date = fields.due_date;
        changes.push(`截止时间：${fields.due_date}`);
    }

    if (fields.priority) {
        const priority = PRIORITY_TO_TAPD_LABEL[fields.priority];
        if (!priority) {
            await sendAiClarificationReply(ctx, message, source, "优先级只支持 P0/P1/P2（或高/中/低）。");
            return { handled: true, action: "ai_clarification", reason: "invalid_priority" };
        }
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryPriority(taskData.tapd_story_id, priority);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.priority = fields.priority;
        changes.push(`优先级：${fields.priority}`);
    }

    if (fields.owner_open_id) {
        const ownerOpenIds = fields.owner_open_id.split(",").map(id => id.trim()).filter(Boolean);
        const members = ctx.config.groups.flatMap(g => g.members);
        const owners = ownerOpenIds.map(id => members.find(m => m.open_id === id)).filter(Boolean);

        if (owners.length === 0) {
            await sendAiClarificationReply(ctx, message, source, "没有找到要变更的负责人，请重新 @ 对应成员。");
            return { handled: true, action: "ai_clarification", reason: "owner_not_found" };
        }

        const primaryOwner = owners[0]!;
        const tapdOwnerStr = owners.map(o => o!.name).join(";") + ";";

        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryOwner(taskData.tapd_story_id, tapdOwnerStr);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.primary_owner_open_id = primaryOwner.open_id;
        taskData.primary_owner_name = primaryOwner.name;
        taskData.assignee_open_ids = owners.map(o => o!.open_id);
        taskData.assignee_names = owners.map(o => o!.name);

        changes.push(`负责人：${tapdOwnerStr}`);
    }

    if (!changes.length) {
        await sendAiClarificationReply(ctx, message, source, "我理解是要修改任务，但没有识别到可更新的字段。");
        return { handled: true, action: "ai_clarification", reason: "empty_update_fields" };
    }

    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);

    const content = changes.join("；");
    const cleanTaskTitle = replyTitle.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    await TaskService.saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "ai_task_updated", content, source, message.id);
    await reply(ctx, message, source, `已更新任务：${cleanTaskTitle}\n${content}`, task);
    if (source === "private" && task.source_message_id) {
        await notifyTaskCreatorPrivate(ctx, task, `${message.sender_name} 更新了任务：${cleanTaskTitle}\n${content}`, "task_status_notice", message.sender_open_id);
    }
    if (task.primary_owner_open_id && task.primary_owner_open_id !== message.sender_open_id) {
        await ctx.feishu.sendPrivateText(task.primary_owner_open_id, `您的任务信息已被 ${message.sender_name} 更新...\n任务：${cleanTaskTitle}\n修改内容：${content}`);
    }

    ctx.store.appendAuditLog("task_ai_updated", { task_id: task.id, changes });
    return { handled: true, action: "ai_task_updated", task_id: task.id, changes };
}

async function applyAiStatusAction(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, action: string): Promise<any> {
    const content = stripBotMention(message, ctx).trim() || action;
    if (["接受", "拒绝", "需要澄清", "验收通过", "已实现", "已经实现", "验收完成", "已结束", "已经结束", "结束", "打回"].includes(action)) {
        return TaskService.applyAction(ctx, message, source, taskData, action, content);
    }
    if (["已完成", "完成了", "已经完成"].includes(action) && taskData.status === "owner_marked_done") {
        return TaskService.applyAction(ctx, message, source, taskData, "已实现", content);
    }
    if (["转测试", "提测"].includes(action)) {
        return TaskService.applyAction(ctx, message, source, taskData, "转测试", content);
    }
    if (["已完成", "完成了", "已经完成", "开发完成", "开发完毕", "开发完了"].includes(action)) {
        return TaskService.applyAction(ctx, message, source, taskData, "开发完成", content);
    }
    if (action === "已修复") {
        if (action === "已修复" && taskData.status === "blocked") {
            // Context-aware: If currently blocked, "已修复" likely means the blocker is fixed, not the whole task.
            action = "阻塞已修复";
        } else {
            return TaskService.applyAction(ctx, message, source, taskData, "开发完成", content);
        }
    }
    if (["解除阻塞", "阻塞已修复", "阻塞解决"].includes(action)) {
        let prevStatus = "in_progress";
        let prevTapdStatus = TAPD_STATUS_IN_PROGRESS;
        try {
            const updates = await ctx.store.listTaskUpdates(taskData.id);
            updates.sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
            const statusChanges = ["accepted_by_owner", "owner_marked_done", "accepted", "reopened"];
            const lastStatusChange = updates.find((u: any) => statusChanges.includes(u.update_type));
            if (lastStatusChange && lastStatusChange.update_type === "owner_marked_done") {
                prevStatus = "owner_marked_done";
                prevTapdStatus = TAPD_STATUS_TESTING;
            }
        } catch (e) {
            // ignore
        }
        return TaskService.setStatus(ctx, message, source, taskData, prevStatus, "unblocked", content, prevTapdStatus);
    }
    if (["阻塞", "阻塞了"].includes(action)) {
        return TaskService.setStatus(ctx, message, source, taskData, "blocked", "blocked", content, TAPD_STATUS_BLOCKED);
    }
    await sendAiClarificationReply(ctx, message, source, "我理解是要更新任务状态，但没有识别到支持的状态动作。");
    return { handled: true, action: "ai_clarification", reason: "unsupported_status_action" };
}

async function createTaskFromAiIntent(ctx: HandlerContext, message: SourceMessage, intent: MessageIntent): Promise<any> {
    const drafts = intent.tasks.length ? intent.tasks : [{
        title: intent.fields.title || intent.task_ref.title,
        description: intent.fields.description,
        due_date: intent.fields.due_date,
        priority: intent.fields.priority,
        owner_open_id: intent.fields.owner_open_id,
        acceptance_criteria: [],
    }];
    const commands: ParsedTaskCommand[] = [];

    for (const draft of drafts) {
        const title = draft.title || intent.fields.title || intent.task_ref.title;
        const ownerOpenIds = parseOwnerOpenIds(draft.owner_open_id || intent.fields.owner_open_id);
        const owners = resolveOwners(ctx, ownerOpenIds);
        const missingOwner = !ownerOpenIds.length || owners.length !== ownerOpenIds.length;

        if (missingOwner || !title) {
            const missing = [];
            if (!title) missing.push("任务标题");
            if (missingOwner) missing.push("负责人");

            const msg = `请补充${missing.join("和")}。`;
            await sendAiClarificationReply(ctx, message, message.chat_type || "private", msg);
            return { handled: true, action: "ai_clarification", reason: "missing_create_fields" };
        }
        const command = aiDraftToCommand(ctx, draft, intent, message);
        if (command) commands.push(command);
    }

    if (!commands.length) {
        await sendAiClarificationReply(ctx, message, message.chat_type || "private", intent.clarification || "请补充任务标题和负责人。");
        return { handled: true, action: "ai_clarification", reason: "missing_create_fields" };
    }

    if (commands.length === 1) {
        return TaskService.createFromCommand(ctx, message, commands[0]);
    }

    let rawText = stripBotMention(message, ctx);
    rawText = rawText.replace(/@[^\s]+\s*/g, "");
    rawText = rawText.replace(/^(?:帮我)?(?:创建一个任务|新建任务|创建任务|创建需求|建个任务)[，。,\s]*/, "");
    rawText = rawText.replace(/\n/g, " ").replace(/\s+/g, " ");
    let fallbackTitle = rawText.substring(0, 30).trim();
    if (fallbackTitle.length < 2) fallbackTitle = "批量分配任务";

    const parentTitle = intent.fields.title || intent.task_ref.title || fallbackTitle;
    const parentOwner = commands[0].primary_owner;
    let tapdStoryId: string | undefined;
    let tapdUrl: string | undefined;

    if (parentOwner) {
        const allAssignees = commands.flatMap(c => c.assignees || [c.primary_owner]);
        const uniqueAssignees = Array.from(new Map(allAssignees.map(a => [a.open_id, a])).values());
        const parentOwnerStr = uniqueAssignees.map(a => a.name).join(";") + ";";

        const tapdResult = await ctx.tapd.createStory(
            parentTitle,
            parentOwnerStr,
            commands[0].tapd_priority_label || "Middle",
            commands[0].due_date || undefined,
            "AI 批量拆分任务父节点\n<br />--- 来源：飞书消息",
            undefined,
            message.sender_name || undefined
        );
        tapdStoryId = tapdResult.ok ? tapdResult.story_id : undefined;
        tapdUrl = tapdResult.ok ? tapdResult.url : undefined;

        const parentCommand = { ...commands[0], title: parentTitle, is_independent: true };
        const parentTask = buildTask(ctx, message, parentCommand, "pending_confirmation", tapdStoryId, tapdUrl);
        parentTask.is_draft = true;
        await ctx.store.saveTask(parentTask);
        if (tapdStoryId) {
            await TaskAttachmentService.attachSourceImages(ctx, message, tapdStoryId);
        }
    }

    const results = [];
    for (const command of commands) {
        results.push(await createSingleTask(ctx, message, command, tapdStoryId, true, false));
    }

    let replyText = `已根据 AI 分析，为你拆分为 1 个父任务和 ${commands.length} 个子任务，等待各负责人确认。\n\n`;
    if (tapdUrl) {
        replyText += `父任务（${parentTitle}）：${tapdUrl}\n`;
    }
    for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.task && res.task.tapd_url) {
            replyText += `子任务 ${i + 1}（${res.task.title}）：${res.task.tapd_url}\n`;
        }
    }

    if (message.sender_open_id) {
        await ctx.feishu.sendPrivateText(message.sender_open_id, replyText.trim());
    } else {
        await reply(ctx, message, "private", replyText.trim());
    }

    return {
        handled: true,
        action: "ai_tasks_created",
        task_ids: results.map(result => result.task_id).filter(Boolean),
        results,
    };
}

function aiDraftToCommand(ctx: HandlerContext, draft: IntentTaskDraft, intent: MessageIntent, message: SourceMessage): ParsedTaskCommand | null {
    const rawOwnerOpenId = draft.owner_open_id || intent.fields.owner_open_id || "";
    const ownerOpenIds = parseOwnerOpenIds(rawOwnerOpenId);
    const owners = resolveOwners(ctx, ownerOpenIds);

    const title = draft.title || intent.fields.title || intent.task_ref.title;
    if (!ownerOpenIds.length || owners.length !== ownerOpenIds.length || !title) return null;

    const priority = draft.priority || intent.fields.priority || "P1";
    const command: ParsedTaskCommand = {
        should_create: true,
        reason: "ai_intent",
        title,
        primary_owner: { open_id: owners[0]!.open_id, name: owners[0]!.name } as Mention,
        assignees: owners.map(o => ({ open_id: o!.open_id, name: o!.name } as Mention)),
        priority,
        tapd_priority_label: PRIORITY_TO_TAPD_LABEL[priority] || "Middle",
        due_date: draft.due_date || intent.fields.due_date || parseDueDateText(message.text || "") || dayjs().add(1, 'day').format('YYYY-MM-DD'),
        acceptance_criteria: draft.acceptance_criteria || [],
        description: draft.description || intent.fields.description || "",
        is_independent: false,
        missing_primary_owner: false,
        is_subtask: false
    };
    return command;
}

function parseOwnerOpenIds(raw: string): string[] {
    return Array.from(new Set(raw.split(/[,，;；\s]+/).map(id => id.trim()).filter(Boolean)));
}

function resolveOwners(ctx: HandlerContext, ownerOpenIds: string[]): any[] {
    if (!ownerOpenIds.length) return [];
    const members = new Map(
        ctx.config.groups.flatMap(g => g.members).map(member => [member.open_id, member] as const)
    );
    return ownerOpenIds.map(id => members.get(id)).filter(Boolean);
}

export async function updateTaskDueDate(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string, content: string): Promise<any> {
    await TaskService.syncFromTapd(ctx, taskData);
    if (taskData.tapd_story_id) {
        const tapdResult = await ctx.tapd.updateStoryDueDate(taskData.tapd_story_id, dueDate);
        if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
    }
    taskData.due_date = dueDate;
    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);

    await TaskService.saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "ai_due_updated", `更新截止时间为：${dueDate}`, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    const cleanTaskTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    await reply(ctx, message, source, `任务截止时间已更新：${cleanTaskTitle}${link} -> ${dueDate}`, task);
    if (source === "private" && task.source_message_id) {
        await notifyTaskCreatorPrivate(ctx, task, `负责人 ${message.sender_name} 更新了任务截止时间为：${dueDate}`, "task_status_notice", message.sender_open_id);
    }
    if (task.primary_owner_open_id && task.primary_owner_open_id !== message.sender_open_id) {
        await ctx.feishu.sendPrivateText(task.primary_owner_open_id, `您的任务截止时间已被 ${message.sender_name} 更新...\n任务：${cleanTaskTitle}\n修改内容：更新截止时间为 ${dueDate}`);
    }
    ctx.store.appendAuditLog("task_due_date_updated", { task_id: task.id, due_date: dueDate });
    return { handled: true, action: "due_date_updated", task_id: task.id, due_date: dueDate };
}

async function resolveAiTask(ctx: HandlerContext, intent: MessageIntent, contextualTask: any): Promise<any> {
    if (intent.task_ref.task_id) {
        const task = await ctx.store.findTask(intent.task_ref.task_id);
        if (task) return task;
    }
    if (intent.task_ref.tapd_story_id) {
        const task = await ctx.store.findTask(intent.task_ref.tapd_story_id);
        if (task) return task;
    }
    if (intent.task_ref.title) {
        return await findUniqueTaskByTitle(intent.task_ref.title, ctx);
    }
    if (contextualTask) return contextualTask;
    return null;
}

function intentPayload(intent: MessageIntent): any {
    const fields: Record<string, string> = {};
    if (intent.fields.title) fields.title = intent.fields.title;
    if (intent.fields.description) fields.description = intent.fields.description;
    if (intent.fields.due_date) fields.due_date = intent.fields.due_date;
    if (intent.fields.priority) fields.priority = intent.fields.priority;
    if (intent.fields.owner_open_id) fields.owner_open_id = intent.fields.owner_open_id;
    if (intent.fields.progress) fields.progress = intent.fields.progress;
    if (intent.fields.status_action) fields.status_action = intent.fields.status_action;

    return {
        type: "message_intent",
        parser: "llm",
        intent: intent.intent,
        task_ref: {
            task_id: intent.task_ref.task_id,
            tapd_story_id: intent.task_ref.tapd_story_id,
            title: intent.task_ref.title,
        },
        fields,
        tasks: intent.tasks,
        needs_clarification: intent.needs_clarification,
        clarification: intent.clarification,
    };
}

async function aiClarification(ctx: HandlerContext, message: SourceMessage, source: string, intent: MessageIntent, fallback: string, action: string): Promise<any> {
    await sendAiClarificationReply(ctx, message, source, intent.clarification || fallback);
    return { handled: true, action, intent: intent.intent };
}

async function sendAiClarificationReply(ctx: HandlerContext, message: SourceMessage, source: string, text: string) {
    const res = await reply(ctx, message, source, text);
    if (res && res.message_id) {
        await ctx.store.saveBotMessageContext({
            message_id: res.message_id,
            context_type: "missing_task_field",
            created_at: utcNowIso(),
            chat_id: res.chat_id || (source === "group" ? message.chat_id : "") || "",
            chat_type: source === "group" ? "group" : "p2p",
            target_open_id: source === "private" ? message.sender_open_id : undefined,
            metadata: { original_text: stripBotMention(message, ctx).trim() }
        });
    }
    return res;
}

function auditAiIntent(ctx: HandlerContext, message: SourceMessage, intent: MessageIntent, executed: boolean, reason: string): void {
    const fields: Record<string, string> = {};
    if (intent.fields.title) fields.title = intent.fields.title;
    if (intent.fields.description) fields.description = intent.fields.description;
    if (intent.fields.due_date) fields.due_date = intent.fields.due_date;
    if (intent.fields.priority) fields.priority = intent.fields.priority;
    if (intent.fields.owner_open_id) fields.owner_open_id = intent.fields.owner_open_id;
    if (intent.fields.progress) fields.progress = intent.fields.progress;
    if (intent.fields.status_action) fields.status_action = intent.fields.status_action;

    ctx.store.appendAuditLog("ai_intent_parsed", {
        message_id: message.id,
        intent: intent.intent,
        confidence: intent.confidence,
        executed,
        reason,
        task_ref: {
            task_id: intent.task_ref.task_id,
            tapd_story_id: intent.task_ref.tapd_story_id,
            title: intent.task_ref.title,
        },
        fields,
        tasks: intent.tasks,
    });
}
