import { HandlerContext, PRIORITY_TO_TAPD_LABEL } from './types';
import { SourceMessage, Task, utcNowIso, BotMessageContext, Mention, TaskUpdate } from '@/models/types';
import { sourceTrace } from './utils';
import { ParsedTaskCommand } from '@/services/taskParser';
import { initializeWorkflow } from '@/domains/task/workflow';
import { TaskAttachmentService } from '@/domains/task/attachments';

export async function createTaskFromCommand(
    ctx: HandlerContext,
    message: SourceMessage,
    command: ParsedTaskCommand,
    parentId?: string
): Promise<any> {
    if (command.missing_primary_owner) {
        const task = buildTask(ctx, message, command, "pending_primary_owner", undefined, undefined, parentId);
        task.is_draft = true;
        await ctx.store.saveTask(task);

        const assignees = (command as any).assignee_names ? (command as any).assignee_names.join("、") : command.assignees.map(i => i.name).join("、");
        const res = await ctx.feishu.sendReplyText(message.id, `已识别到多人任务，请指定主负责人：\n\n任务：${command.title}\n参与人：${assignees}\n\n请引用本消息并回复：主负责人 @某某`);

        if (res.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "pending_primary_owner",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                task_id: task.id,
                task_title: task.title,
            });
        }
        return { handled: true, action: "pending_primary_owner", task_id: task.id };
    }

    if (command.is_independent && command.assignees.length > 1) {
        const tapdOwnerStr = command.assignees.map(a => a.name).join(";") + ";";
        const description = taskDescription(message, command);

        const tapdResult = await ctx.tapd.createStory(
            command.title,
            tapdOwnerStr,
            command.tapd_priority_label,
            command.due_date || undefined,
            description,
            parentId,
            message.sender_name || undefined
        );

        const tapdStoryId = tapdResult.ok ? tapdResult.story_id : undefined;
        const tapdUrl = tapdResult.ok ? tapdResult.url : undefined;

        const parentTask = buildTask(ctx, message, command, "pending_confirmation", tapdStoryId, tapdUrl, parentId);
        parentTask.title = command.title;
        parentTask.is_draft = true;
        await ctx.store.saveTask(parentTask);
        if (tapdStoryId) {
            await TaskAttachmentService.attachSourceImages(ctx, message, tapdStoryId);
        }

        const childIds: string[] = [];
        for (const assignee of command.assignees) {
            const childCommand: ParsedTaskCommand = {
                should_create: true,
                reason: "ok",
                title: `${assignee.name}：${command.title}`,
                primary_owner: assignee,
                assignees: [assignee],
                priority: command.priority,
                tapd_priority_label: command.tapd_priority_label,
                due_date: command.due_date,
                acceptance_criteria: command.acceptance_criteria,
                description: command.description,
                is_independent: false,
                missing_primary_owner: false,
                is_subtask: false
            };
            const childResult = await createSingleTask(ctx, message, childCommand, tapdStoryId, true, false);
            if (childResult.task_id) childIds.push(childResult.task_id);
        }

        await sendTaskPrivateNotice(ctx, parentTask, message.sender_open_id || "", `已创建父任务和 ${childIds.length} 个子任务，等待各负责人确认。`, "task_creation_receipt");
        return { handled: true, action: "independent_tasks_created", parent_id: parentTask.id, child_ids: childIds };
    }

    return createSingleTask(ctx, message, command, parentId);
}

export async function createSingleTask(
    ctx: HandlerContext,
    message: SourceMessage,
    command: ParsedTaskCommand,
    parentId?: string,
    suppressGroupReply: boolean = false,
    attachSourceImages: boolean = true
): Promise<any> {
    const owner = command.primary_owner;
    if (!owner) throw new Error("Missing owner");
    const assignees = Array.from(new Map(
        (command.assignees.length ? command.assignees : [owner])
            .map(assignee => [assignee.open_id, assignee] as const)
    ).values());
    const normalizedCommand = { ...command, assignees };

    const description = taskDescription(message, normalizedCommand);
    const tapdOwnerStr = assignees.map(a => a.name).join(";") + ";";
    const tapdResult = await ctx.tapd.createStory(
        command.title,
        tapdOwnerStr,
        command.tapd_priority_label,
        command.due_date || undefined,
        description,
        parentId,
        message.sender_name || undefined
    );

    if (!tapdResult.ok) {
        await ctx.store.appendAuditLog("tapd_create_failed", { message_id: message.id, error: tapdResult.error });
        const errorText = `任务创建失败：${tapdResult.error || 'TAPD API 调用失败'}`;
        if (message.sender_open_id) await ctx.feishu.sendPrivateText(message.sender_open_id, errorText);
        else await ctx.feishu.sendReplyText(message.id, errorText);
        return { handled: true, action: "tapd_create_failed", error: tapdResult.error };
    }

    const task = buildTask(ctx, message, normalizedCommand, "pending_confirmation", tapdResult.story_id, tapdResult.url, parentId);
    await ctx.store.saveTask(task);

    await saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "created", "任务已创建", "group", message.id);
    if (attachSourceImages && tapdResult.story_id) {
        await TaskAttachmentService.attachSourceImages(ctx, message, tapdResult.story_id);
    }

    const groupName = ctx.config.groups.find(g => g.chat_id === task.source_group_id)?.name || "未知来源";
    const privateText = privateConfirmationText(task, groupName);
    for (const assignee of assignees) {
        const privateResult = await ctx.feishu.sendPrivateText(assignee.open_id, privateText);
        if (privateResult.chat_id) {
            await ctx.store.updateChatId(assignee.open_id, privateResult.chat_id);
        }
        if (privateResult.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: privateResult.message_id,
                context_type: "task_confirmation",
                created_at: utcNowIso(),
                chat_id: privateResult.chat_id || "",
                chat_type: "p2p",
                target_open_id: assignee.open_id,
                task_id: task.id,
                task_title: task.title,
                metadata: { tapd_story_id: task.tapd_story_id || "" },
            });
        }
    }

    if (!suppressGroupReply) {
        const creatorIsAssignee = assignees.some(assignee => assignee.open_id === message.sender_open_id);
        await sendTaskPrivateNotice(
            ctx,
            task,
            message.sender_open_id || "",
            groupCreatedText(task),
            "task_creation_receipt",
            creatorIsAssignee ? message.sender_open_id : undefined
        );
    }

    await ctx.store.appendAuditLog("task_created", {
        task_id: task.id,
        title: task.title,
        owner: owner.name,
        owners: assignees.map(item => item.name),
        tapd_id: task.tapd_story_id,
    });
    return { handled: true, action: "task_created", task_id: task.id, tapd_story_id: task.tapd_story_id, task };
}

export function buildTask(
    ctx: HandlerContext,
    message: SourceMessage,
    command: ParsedTaskCommand,
    status: string,
    tapdStoryId?: string,
    tapdUrl?: string,
    parentId?: string
): Task {
    const now = utcNowIso();
    const owner = command.primary_owner || { open_id: "", name: "" };

    let hashStr = command.title + owner.open_id;
    let hash = 0;
    for (let i = 0; i < hashStr.length; i++) hash = ((hash << 5) - hash) + hashStr.charCodeAt(i);
    const taskId = `task-${message.id}-${Math.abs(hash) % 100000}`;

    const aiResult = message.ai_result || {
        type: "task_command",
        parser: command.reason || "rule",
        title: command.title,
    };
    const confidence = (message.confidence !== undefined && message.confidence !== null) ? message.confidence : 1.0;
    const trace = sourceTrace(message, aiResult, confidence);
    trace.roles = {
        creator: { open_id: message.sender_open_id || "", name: message.sender_name || "" },
        developer: { open_id: owner.open_id || "", name: owner.name || "" },
        tester: null,
    };

    const task: Task = {
        id: taskId,
        title: command.title,
        creator_open_id: message.sender_open_id || "",
        creator_name: message.sender_name || "",
        primary_owner_open_id: owner.open_id,
        primary_owner_name: owner.name,
        assignee_open_ids: command.assignees.map(a => a.open_id),
        assignee_names: command.assignees.map(a => a.name),
        status,
        priority: command.priority,
        due_date: command.due_date || null,
        acceptance_criteria: command.acceptance_criteria || [],
        description: command.description || "",
        source_message_id: message.id,
        source_group_id: message.chat_id,
        source_sender_open_id: message.sender_open_id,
        source_sender_name: message.sender_name,
        source_sent_at: message.sent_at,
        raw_text: message.text,
        ai_result: aiResult,
        confidence,
        trace,
        tapd_story_id: tapdStoryId || null,
        tapd_url: tapdUrl || null,
        parent_id: parentId || null,
        created_at: now,
        updated_at: now,
    };
    initializeWorkflow(task, ctx.config, now);
    return task;
}

export function taskDescription(message: SourceMessage, command: ParsedTaskCommand): string {
    const lines: string[] = [];
    const body = taskDetailBody(message, command);

    if (command.title && command.reason === "ai_intent" && !body.startsWith(command.title)) {
        lines.push(command.title);
        lines.push("---");
    }

    if (body) {
        const bulletBody = body.split("\n").map(line => {
            const trimmed = line.trim();
            if (!trimmed) return "";
            if (trimmed.startsWith("-") || trimmed.match(/^\d+\./)) return trimmed;
            return `- ${trimmed}`;
        }).filter(Boolean).join("\n");
        lines.push(bulletBody);
    }

    if (command.acceptance_criteria && command.acceptance_criteria.length && !body.includes("验收标准")) {
        lines.push("- 验收标准：" + command.acceptance_criteria.join("；"));
    }
    if (command.due_date && !body.includes("截止")) {
        lines.push(`- 截止时间：${command.due_date}`);
    }

    const chatSource = message.chat_type === "group" ? "群聊" : "私聊";
    if (lines.length) {
        lines.push("");
        lines.push("");
    }

    const metaParts = [];
    metaParts.push(`提出人：${message.sender_name || "未设置"}`);
    metaParts.push(`创建人：${message.sender_name || "未设置"}`);
    metaParts.push(`开发人员：${command.primary_owner?.name || "未设置"}`);
    if (command.assignees && command.assignees.length) {
        metaParts.push(`参与人：${command.assignees.map(a => a.name).filter(Boolean).join("、")}`);
    }

    lines.push(metaParts.join("；"));
    lines.push(`--- 来源：飞书${chatSource}消息`);
    return lines.join("<br />").replace(/\n/g, "<br />");
}

function taskDetailBody(message: SourceMessage, command: ParsedTaskCommand): string {
    const description = (command.description || "").trim();
    if (description) return description;

    let raw = (message.text || "").trim();
    raw = raw.replace(/@\S*(?:机器人|Robot|Bot)\s*/ig, "");
    raw = raw.replace(/^(?:帮我创建任务|新建任务|创建需求)\s*/, "");
    return raw.trim();
}

export function privateConfirmationText(task: Task, groupName: string): string {
    const ownerNames = (task.assignee_names || []).filter(Boolean).join("、") || task.primary_owner_name;
    return (
        "新任务待确认：\n\n" +
        `来源：【${groupName}】\n` +
        `任务：${task.title}\n` +
        `任务ID：${task.tapd_story_id || task.id}\n` +
        `负责人：${ownerNames}\n` +
        `截止时间：${task.due_date || '未设置'}\n` +
        `验收标准：${(task.acceptance_criteria || []).join("；") || '未设置'}\n` +
        `提出人：${task.creator_name}\n` +
        `链接：${task.tapd_url || '未生成'}\n\n` +
        `回复：接受${task.tapd_story_id || task.id} / 拒绝${task.tapd_story_id || task.id} / 需要澄清${task.tapd_story_id || task.id}，也可以引用消息回复`
    );
}

export function groupCreatedText(task: Task): string {
    const ownerNames = (task.assignee_names || []).filter(Boolean).join("、") || task.primary_owner_name;
    return (
        "已创建任务：\n\n" +
        `任务：${task.title}\n` +
        `负责人：${ownerNames}\n` +
        `截止时间：${task.due_date || '未设置'}\n` +
        `优先级：${task.priority}\n` +
        `状态：待负责人确认\n` +
        `任务ID：${task.tapd_story_id || task.id}\n` +
        `查看TAPD：${task.tapd_url || '未生成'}`
    );
}

export async function saveUpdate(
    ctx: HandlerContext,
    task: Task,
    userOpenId: string,
    userName: string,
    updateType: string,
    content: string,
    source: string,
    sourceMessageId?: string,
    metadata?: Record<string, any>
): Promise<void> {
    const sourceMessage = sourceMessageId ? await ctx.store.getSourceMessage(sourceMessageId) : undefined;
    const aiResult = { type: updateType, parser: "structured_event", content };
    const trace = sourceMessage ? sourceTrace(sourceMessage, aiResult, 1.0) : {};

    const updates = await ctx.store.listTaskUpdates(task.id);
    const update: TaskUpdate = {
        id: `update-${task.id}-${Date.now()}-${Math.floor(Math.random()*10000)}`,
        task_id: task.id || "",
        user_open_id: userOpenId,
        user_name: userName,
        update_type: updateType,
        content,
        source,
        source_message_id: sourceMessageId || null,
        source_group_id: trace.source_group_id || "",
        source_sender_open_id: trace.sender_open_id || "",
        source_sender_name: trace.sender_name || "",
        source_sent_at: trace.sent_at || "",
        raw_text: trace.raw_text || "",
        ai_result: aiResult,
        confidence: 1.0,
        trace,
        metadata: metadata || {},
        created_at: utcNowIso(),
    };
    await ctx.store.saveTaskUpdate(update);
}

export async function notifySourceGroup(ctx: HandlerContext, task: Task, text: string, contextType: string = "task_status_notice"): Promise<void> {
    if (!task.source_message_id) return;
    const res = await ctx.feishu.sendReplyText(task.source_message_id, text);
    if (res.message_id) {
        await ctx.store.saveBotMessageContext({
            message_id: res.message_id,
            context_type: contextType,
            created_at: utcNowIso(),
            chat_id: task.source_group_id || "",
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" }
        });
    }
}

export async function notifyTaskCreatorPrivate(ctx: HandlerContext, task: Task, text: string, contextType: string = "task_status_notice", excludeOpenId?: string): Promise<void> {
    const creatorOpenId = task.creator_open_id || task.source_sender_open_id || "";
    await sendTaskPrivateNotice(ctx, task, creatorOpenId, text, contextType, excludeOpenId);
}

export async function sendTaskPrivateNotice(
    ctx: HandlerContext,
    task: Task,
    openId: string,
    text: string,
    contextType: string = "task_status_notice",
    excludeOpenId?: string
): Promise<void> {
    if (!openId || openId === excludeOpenId) return;
    const res = await ctx.feishu.sendPrivateText(openId, text);
    if (res.chat_id && typeof ctx.store.updateChatId === "function") {
        await ctx.store.updateChatId(openId, res.chat_id);
    }
    if (res.message_id) {
        await ctx.store.saveBotMessageContext({
            message_id: res.message_id,
            context_type: contextType,
            created_at: utcNowIso(),
            chat_id: res.chat_id || "",
            chat_type: "p2p",
            target_open_id: openId,
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" }
        });
    }
}
