import { HandlerContext, TAPD_STATUS_REQUIREMENT, TAPD_STATUS_IN_PROGRESS, TAPD_STATUS_CANCELLED, TAPD_STATUS_DONE, TAPD_STATUS_TESTING, TAPD_STATUS_BLOCKED } from './types';
import { Mention, SourceMessage, Task, utcNowIso } from '@/models/types';
import { saveUpdate, notifySourceGroup, notifyTaskCreatorPrivate, sendTaskPrivateNotice } from './taskCommands';
import { parseDueDateText } from '@/services/taskParser';
import { syncTaskFromTapd } from './utils';
import { isActiveTask } from '@/services/taskScope';
import {
    ensureWorkflow,
    legacyStatusForPhase,
    memberDiscipline,
    mentionedPeople,
    person,
    recordWorkflowEvent,
    setWorkflowPhase,
} from '@/domains/task/workflow';
import { applyTaskDueDate, applyTaskSupplement } from '@/domains/task/mutationPolicy';

type TaskRole = { open_id: string; name: string } | null;

export async function applyAction(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    action: string,
    text: string
): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    const workflow = ensureWorkflow(taskData as Task, ctx.config);
    const isAssignee = message.sender_open_id === taskData.primary_owner_open_id ||
        (taskData.assignee_open_ids || []).includes(message.sender_open_id);
    if (["接受", "拒绝", "需要澄清"].includes(action) && !isAssignee) {
        await reply(ctx, message, source, "只有任务负责人可以确认、拒绝或要求澄清该任务。");
        return { handled: true, action: "unauthorized" };
    }
    if (["验收通过", "已实现", "已经实现", "验收完成", "已经完成", "已结束", "已经结束", "结束", "打回", "删除", "取消", "测试通过", "恢复", "解除阻塞"].includes(action) && message.sender_open_id !== taskData.creator_open_id && !isAssignee) {
        await reply(ctx, message, source, "只有任务创建人或负责人可以执行该操作。");
        return { handled: true, action: "unauthorized" };
    }
    if (action === "接受") return acceptTaskByAssignee(ctx, message, source, taskData, text);
    if (action === "拒绝") return setTaskStatus(ctx, message, source, taskData, "cancelled", "rejected_by_owner", text, TAPD_STATUS_CANCELLED);
    if (action === "需要澄清") return requestClarification(ctx, message, source, taskData, text);
    if (action === "需求完成") return completeRequirement(ctx, message, source, taskData, text);
    if (["开发完成", "开发完毕", "开发完了"].includes(action)) return markDevelopmentCompleted(ctx, message, source, taskData, text);
    if (["转测试", "提测"].includes(action)) return transferToTest(ctx, message, source, taskData, text);
    if (action === "测试通过") return passTesting(ctx, message, source, taskData, text);
    if (["恢复", "解除阻塞"].includes(action)) return resumeBlockedTask(ctx, message, source, taskData, text);
    if (["验收通过", "已实现", "已经实现", "验收完成", "已完成", "完成了", "已经完成", "已结束", "已经结束", "结束"].includes(action)) {
        const productId = workflow.roles.product?.open_id || taskData.creator_open_id;
        const legacyTransferReady = workflow.phase === "transfer_test" && workflow.pending_acceptances.length === 0 && workflow.history.length === 0;
        const acceptanceReady = workflow.phase === "testing" && workflow.substate === "pending_product_acceptance";
        if (!legacyTransferReady && !acceptanceReady) {
            await reply(ctx, message, source, "任务尚未到产品验收阶段。请先完成开发、转测试和测试通过。", taskData);
            return { handled: true, action: "acceptance_not_ready", task_id: taskData.id, status: taskData.status };
        }
        if (!legacyTransferReady && productId && message.sender_open_id !== productId) {
            await reply(ctx, message, source, "只有产品负责人可以确认验收并将任务标记为已实现。", taskData);
            return { handled: true, action: "unauthorized", task_id: taskData.id, status: taskData.status };
        }
        setWorkflowPhase(workflow, "implemented", {
            type: "product_accepted",
            at: utcNowIso(),
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: text,
        });
        return setTaskStatus(ctx, message, source, taskData, "accepted", "accepted", text, TAPD_STATUS_DONE);
    }
    if (action === "打回") return setTaskStatus(ctx, message, source, taskData, "in_progress", "reopened", text, TAPD_STATUS_IN_PROGRESS);
    if (action === "删除") return setTaskStatus(ctx, message, source, taskData, "deleted", "deleted", text, undefined);
    if (action === "取消") return setTaskStatus(ctx, message, source, taskData, "cancelled", "cancelled", text, TAPD_STATUS_CANCELLED);
    return { handled: false, reason: "unknown_action" };
}

async function markDevelopmentCompleted(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    content: string,
): Promise<any> {
    const workflow = ensureWorkflow(taskData as Task, ctx.config);
    const developerId = workflow.roles.developer?.open_id || taskData.primary_owner_open_id;
    if (message.sender_open_id !== developerId) {
        await reply(ctx, message, source, "只有开发负责人可以标记开发完成。", taskData);
        return { handled: true, action: "unauthorized", task_id: taskData.id, status: taskData.status };
    }
    if (workflow.phase === "development_completed") {
        await reply(ctx, message, source, "该任务已是开发完成状态。请回复“转测试”并同时 @产品负责人、@测试负责人。", taskData);
        return { handled: true, action: "development_already_completed", task_id: taskData.id, status: taskData.status };
    }
    if (workflow.phase !== "development") {
        await reply(ctx, message, source, "只有开发进行中的任务可以标记为开发完成。", taskData);
        return { handled: true, action: "invalid_workflow_phase", task_id: taskData.id, status: taskData.status };
    }
    setWorkflowPhase(workflow, "development_completed", {
        type: "development_completed",
        at: utcNowIso(),
        actor_open_id: message.sender_open_id,
        actor_name: message.sender_name,
        detail: content,
    });
    workflow.pending_acceptances = [];
    return setTaskStatus(ctx, message, source, taskData, "development_completed", "development_completed", content);
}

async function transferToTest(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    content: string,
): Promise<any> {
    return setTaskStatus(ctx, message, source, taskData, "owner_marked_done", "owner_marked_done", content, TAPD_STATUS_TESTING);
}

async function acceptTaskByAssignee(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    content: string
): Promise<any> {
    const workflow = ensureWorkflow(taskData as Task, ctx.config);
    const phaseAcceptances = workflow.pending_acceptances.length
        ? workflow.pending_acceptances
        : (taskData.assignee_open_ids?.length ? taskData.assignee_open_ids : [taskData.primary_owner_open_id]);
    const assigneeOpenIds = Array.from(new Set(phaseAcceptances.filter(Boolean))) as string[];
    if (workflow.pending_acceptances.length === 0) workflow.pending_acceptances = [...assigneeOpenIds];
    const assigneeOpenIdSet = new Set(assigneeOpenIds);
    const people = [workflow.roles.product, workflow.roles.developer, workflow.roles.tester].filter(Boolean) as Array<{ open_id: string; name: string }>;
    const assigneeNames = taskData.assignee_names || [];
    const nameByOpenId = new Map<string, string>();
    assigneeOpenIds.forEach((openId, index) => {
        nameByOpenId.set(openId, people.find(item => item.open_id === openId)?.name || assigneeNames[index] || (openId === taskData.primary_owner_open_id ? taskData.primary_owner_name : openId));
    });

    const acceptsDraft = workflow.phase === "draft";
    const acceptsDevelopmentHandoff = workflow.phase === "requirement" && workflow.substate === "waiting_developer_acceptance";
    const acceptsTestHandoff = workflow.phase === "transfer_test";
    if (!acceptsDraft && !acceptsDevelopmentHandoff && !acceptsTestHandoff) {
        await reply(ctx, message, source, "该任务已完成负责人确认，无需重复接受。", taskData);
        return {
            handled: true,
            action: "acceptance_already_complete",
            task_id: taskData.id,
            status: taskData.status,
        };
    }
    if (!assigneeOpenIdSet.has(message.sender_open_id || "")) {
        await reply(ctx, message, source, "你不在本次交接的待确认名单中。", taskData);
        return { handled: true, action: "unauthorized", task_id: taskData.id, status: taskData.status };
    }

    const existingUpdates = await ctx.store.listTaskUpdates(taskData.id);
    const acceptanceUpdateType = acceptsDraft
        ? "accepted_by_assignee"
        : acceptsDevelopmentHandoff ? "developer_handoff_accepted" : "test_handoff_accepted";
    const acceptedOpenIds = new Set<string>(
        existingUpdates
            .filter((update: any) => update.update_type === acceptanceUpdateType && workflow.pending_acceptances.includes(update.user_open_id))
            .map((update: any) => update.user_open_id)
            .filter((openId: string) => assigneeOpenIdSet.has(openId))
    );

    if (acceptedOpenIds.has(message.sender_open_id || "")) {
        const pendingOpenIds = assigneeOpenIds.filter(openId => !acceptedOpenIds.has(openId));
        await reply(
            ctx,
            message,
            source,
            `已记录你接受该任务，无需重复确认。当前 ${acceptedOpenIds.size}/${assigneeOpenIds.length} 位负责人已接受，仍待接受：${pendingOpenIds.map(openId => nameByOpenId.get(openId)).join("、") || "无"}。`,
            taskData
        );
        return {
            handled: true,
            action: "acceptance_already_recorded",
            task_id: taskData.id,
            status: taskData.status,
            accepted_count: acceptedOpenIds.size,
            total_count: assigneeOpenIds.length,
            pending_open_ids: pendingOpenIds,
        };
    }

    await saveUpdate(
        ctx,
        taskData as Task,
        message.sender_open_id || "",
        message.sender_name || "",
        acceptanceUpdateType,
        content,
        source,
        message.id
    );

    const refreshedUpdates = await ctx.store.listTaskUpdates(taskData.id);
    const refreshedAcceptedOpenIds = new Set<string>(
        refreshedUpdates
            .filter((update: any) => update.update_type === acceptanceUpdateType && workflow.pending_acceptances.includes(update.user_open_id))
            .map((update: any) => update.user_open_id)
            .filter((openId: string) => assigneeOpenIdSet.has(openId))
    );
    const pendingOpenIds = assigneeOpenIds.filter(openId => !refreshedAcceptedOpenIds.has(openId));

    if (pendingOpenIds.length > 0) {
        const pendingNames = pendingOpenIds.map(openId => nameByOpenId.get(openId)).join("、");
        const progressText = `已记录你接受该任务。当前 ${refreshedAcceptedOpenIds.size}/${assigneeOpenIds.length} 位负责人已接受，仍待接受：${pendingNames}。全部负责人接受后任务才会流转。`;
        await reply(ctx, message, source, progressText, taskData);
        await notifyTaskCreatorPrivate(
            ctx,
            taskData as Task,
            `负责人 ${message.sender_name} 已接受任务：${taskData.title}\n当前 ${refreshedAcceptedOpenIds.size}/${assigneeOpenIds.length} 位负责人已接受，仍待接受：${pendingNames}。`,
            "task_status_notice",
            message.sender_open_id
        );
        await ctx.store.appendAuditLog("task_acceptance_recorded", {
            task_id: taskData.id,
            accepted_open_id: message.sender_open_id,
            accepted_count: refreshedAcceptedOpenIds.size,
            total_count: assigneeOpenIds.length,
            pending_open_ids: pendingOpenIds,
        });
        return {
            handled: true,
            action: "acceptance_recorded",
            task_id: taskData.id,
            status: taskData.status,
            accepted_count: refreshedAcceptedOpenIds.size,
            total_count: assigneeOpenIds.length,
            pending_open_ids: pendingOpenIds,
        };
    }
    workflow.accepted_open_ids = [...refreshedAcceptedOpenIds];
    const now = utcNowIso();
    if (acceptsDraft) {
        const phase = workflow.pending_role === "product" ? "requirement" : "development";
        const role = phase === "requirement" ? "product" : "developer";
        workflow.roles[role] = person(taskData.primary_owner_open_id, taskData.primary_owner_name);
        setWorkflowPhase(workflow, phase, {
            type: phase === "requirement" ? "product_accepted" : "developer_accepted",
            at: now,
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: content,
        });
        return setTaskStatus(
            ctx,
            message,
            source,
            taskData,
            legacyStatusForPhase(phase),
            phase === "requirement" ? "requirement_accepted" : "developer_accepted",
            content,
            phase === "requirement" ? TAPD_STATUS_REQUIREMENT : TAPD_STATUS_IN_PROGRESS,
        );
    }

    if (acceptsDevelopmentHandoff) {
        const developer = workflow.roles.developer;
        if (developer) await updateCurrentOwner(ctx, taskData, developer);
        setWorkflowPhase(workflow, "development", {
            type: "developer_accepted",
            at: now,
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: content,
        });
        return setTaskStatus(ctx, message, source, taskData, "in_progress", "developer_accepted", content, TAPD_STATUS_IN_PROGRESS);
    }

    const tester = workflow.roles.tester;
    if (tester) await updateCurrentOwner(ctx, taskData, tester);
    setWorkflowPhase(workflow, "testing", {
        type: "testing_started",
        at: now,
        actor_open_id: message.sender_open_id,
        actor_name: message.sender_name,
        detail: content,
    }, "in_progress");
    return setTaskStatus(ctx, message, source, taskData, "testing", "testing_started", content);
}

async function completeRequirement(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const task = taskData as Task;
    const workflow = ensureWorkflow(task, ctx.config);
    const productId = workflow.roles.product?.open_id || task.creator_open_id;
    if (workflow.phase !== "requirement" || message.sender_open_id !== productId) {
        await reply(ctx, message, source, "只有处于需求阶段的产品负责人可以发起开发交接。", task);
        return { handled: true, action: "unauthorized", task_id: task.id, status: task.status };
    }
    const mentions = mentionedPeople(message.mentions, ctx.config.feishu.bot_open_id, message.sender_open_id);
    const developers = mentions.filter(item => memberDiscipline(ctx.config, item.open_id) !== "product");
    if (developers.length === 0) {
        await reply(ctx, message, source, "需求完成后请@至少一位开发负责人，开发接受后任务才会进入开发进行中。", task);
        return { handled: true, action: "developer_required", task_id: task.id, status: task.status };
    }
    workflow.roles.developer = developers[0];
    workflow.substate = "waiting_developer_acceptance";
    workflow.pending_acceptances = developers.map(item => item.open_id);
    workflow.accepted_open_ids = [];
    recordWorkflowEvent(workflow, {
        type: "requirement_completed",
        at: utcNowIso(),
        actor_open_id: message.sender_open_id,
        actor_name: message.sender_name,
        detail: content,
    });
    addAssignees(task, developers);
    task.updated_at = utcNowIso();
    await ctx.store.saveTask(task);
    await saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "requirement_completed", content, source, message.id, { pending_open_ids: workflow.pending_acceptances });
    for (const developer of developers) {
        await ctx.feishu.sendPrivateText(developer.open_id, `产品需求已完成，等待你接受开发任务：${task.title}\n回复“接受”后进入开发进行中。`);
    }
    await reply(ctx, message, source, `需求已完成，等待开发接受：${developers.map(item => item.name).join("、")}。`, task);
    return { handled: true, action: "requirement_completed", task_id: task.id, status: task.status, pending_open_ids: workflow.pending_acceptances };
}

async function passTesting(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const task = taskData as Task;
    const workflow = ensureWorkflow(task, ctx.config);
    const testerId = workflow.roles.tester?.open_id;
    if (workflow.phase !== "testing" || !testerId || message.sender_open_id !== testerId) {
        await reply(ctx, message, source, "只有当前测试负责人可以确认测试通过。", task);
        return { handled: true, action: "unauthorized", task_id: task.id, status: task.status };
    }
    workflow.substate = "pending_product_acceptance";
    recordWorkflowEvent(workflow, {
        type: "test_passed",
        at: utcNowIso(),
        actor_open_id: message.sender_open_id,
        actor_name: message.sender_name,
        detail: content,
    });
    const product = workflow.roles.product || workflow.roles.creator;
    if (product) await updateCurrentOwner(ctx, task, product);
    task.status = "testing";
    task.updated_at = utcNowIso();
    await ctx.store.saveTask(task);
    await saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "test_passed", content, source, message.id);
    if (product?.open_id) await ctx.feishu.sendPrivateText(product.open_id, `测试已通过，等待产品验收：${task.title}\n请回复“验收通过”或“打回：原因”。`);
    await reply(ctx, message, source, "测试已通过，任务进入待产品验收。", task);
    return { handled: true, action: "test_passed", task_id: task.id, status: task.status };
}

async function resumeBlockedTask(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const task = taskData as Task;
    const workflow = ensureWorkflow(task, ctx.config);
    if (!workflow.blocked || !workflow.resume_status) {
        await reply(ctx, message, source, "该任务当前没有挂起，无需恢复。", task);
        return { handled: true, action: "not_blocked", task_id: task.id, status: task.status };
    }
    const resumeStatus = workflow.resume_status;
    workflow.blocked = false;
    workflow.resume_phase = null;
    workflow.resume_status = null;
    recordWorkflowEvent(workflow, {
        type: "unblocked",
        at: utcNowIso(),
        actor_open_id: message.sender_open_id,
        actor_name: message.sender_name,
        detail: content,
    });
    const tapdStatus = workflow.phase === "requirement" ? TAPD_STATUS_REQUIREMENT
        : workflow.phase === "development" ? TAPD_STATUS_IN_PROGRESS
        : workflow.phase === "implemented" ? TAPD_STATUS_DONE
        : TAPD_STATUS_TESTING;
    return setTaskStatus(ctx, message, source, task, resumeStatus, "unblocked", content, tapdStatus);
}

function addAssignees(task: Task, people: Array<{ open_id: string; name: string }>): void {
    task.assignee_open_ids = [...(task.assignee_open_ids || [])];
    task.assignee_names = [...(task.assignee_names || [])];
    for (const item of people) {
        if (task.assignee_open_ids.includes(item.open_id)) continue;
        task.assignee_open_ids.push(item.open_id);
        task.assignee_names.push(item.name);
    }
}

async function updateCurrentOwner(ctx: HandlerContext, task: Task, owner: { open_id: string; name: string }): Promise<void> {
    if (!owner.open_id || owner.open_id === task.primary_owner_open_id) return;
    if (task.tapd_story_id && owner.name) {
        const result = await ctx.tapd.updateStoryOwner(task.tapd_story_id, owner.name);
        if (!result.ok) await ctx.store.appendAuditLog("tapd_update_failed", { task_id: task.id, tapd_owner: owner.name, error: result.error });
    }
    task.primary_owner_open_id = owner.open_id;
    task.primary_owner_name = owner.name;
    addAssignees(task, [owner]);
}

export async function setTaskStatus(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    status: string,
    updateType: string,
    content: string,
    tapdStatus?: string
): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    let tapdErrorMsg = "";
    const workflow = ensureWorkflow(taskData as Task, ctx.config);
    const mentioned = mentionedPeople(message.mentions, ctx.config?.feishu?.bot_open_id, message.sender_open_id);
    const handoffOwner = status === "owner_marked_done"
        ? mentioned.find(item => memberDiscipline(ctx.config, item.open_id) === "development") || null
        : null;
    const previousOwner = personRole(taskData.primary_owner_open_id, taskData.primary_owner_name);
    const previousOwnerName = taskData.primary_owner_name || message.sender_name || "";

    if (updateType === "owner_marked_done") {
        workflow.roles.developer = workflow.roles.developer || person(taskData.primary_owner_open_id, taskData.primary_owner_name);
        const mentionedProduct = mentioned.find(item => memberDiscipline(ctx.config, item.open_id) === "product");
        const developerId = workflow.roles.developer?.open_id || taskData.primary_owner_open_id;
        if (message.sender_open_id !== developerId) {
            await reply(ctx, message, source, "只有开发负责人可以发起转测试。", taskData);
            return { handled: true, action: "unauthorized", task_id: taskData.id, status: taskData.status };
        }
        if (workflow.phase !== "development_completed") {
            await reply(ctx, message, source, "请先由开发负责人回复“开发完成”，然后再发起转测试。", taskData);
            return { handled: true, action: "development_completion_required", task_id: taskData.id, status: taskData.status };
        }
        if (!mentionedProduct || !handoffOwner) {
            const missing = [!mentionedProduct ? "产品负责人" : "", !handoffOwner ? "测试负责人" : ""].filter(Boolean).join("、");
            await reply(ctx, message, source, `转测试时请在同一条消息中同时 @产品负责人和 @测试负责人。当前缺少：${missing}。`, taskData);
            return { handled: true, action: "handoff_mentions_required", task_id: taskData.id, status: taskData.status };
        }
        workflow.roles.tester = handoffOwner;
        workflow.roles.product = mentionedProduct;
        setWorkflowPhase(workflow, "transfer_test", {
            type: "transferred_to_test",
            at: utcNowIso(),
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: content,
        }, "waiting_test_and_product_acceptance");
        workflow.pending_acceptances = [...new Set([
            workflow.roles.tester?.open_id,
            workflow.roles.product?.open_id,
        ].filter(Boolean) as string[])];
        taskData.trace.roles = workflow.roles;
    }

    if (tapdStatus && taskData.tapd_story_id) {
        const tapdResult = await ctx.tapd.updateStoryStatus(taskData.tapd_story_id, tapdStatus);
        if (!tapdResult.ok) {
            ctx.store.appendAuditLog("tapd_update_failed", {
                task_id: taskData.id,
                tapd_story_id: taskData.tapd_story_id,
                tapd_status: tapdStatus,
                local_status: status,
                error: tapdResult.error,
            });
            tapdErrorMsg = "\n(⚠️ 注：机器人已记录本次状态变更，但同步 TAPD 状态失败；请管理员检查 TAPD 工作区、权限或状态流转配置。)";
        }
    }

    if (handoffOwner) addAssignees(taskData as Task, [handoffOwner]);
    if (workflow.roles.product) addAssignees(taskData as Task, [workflow.roles.product]);

    if (updateType === "owner_marked_done" && taskData.tapd_story_id && typeof (ctx.tapd as any).addStoryComment === "function") {
        const roles = ensureTaskRoles(taskData, previousOwner);
        const comment = [
            "任务流转：转测试",
            `创建人：${roles.creator?.name || taskData.creator_name || "未设置"}`,
        ].join("<br>");
        const commentResult = await (ctx.tapd as any).addStoryComment(taskData.tapd_story_id, comment, message.sender_name);
        if (!commentResult.ok) {
            ctx.store.appendAuditLog("tapd_comment_failed", {
                task_id: taskData.id,
                tapd_story_id: taskData.tapd_story_id,
                error: commentResult.error,
                transition: "owner_marked_done",
            });
            tapdErrorMsg += "\n(⚠️ 注：机器人已记录转测试，但同步 TAPD 评论失败；请管理员检查 TAPD 权限或评论接口配置。)";
        }
    }

    if (updateType === "reopened") {
        const roles = ensureTaskRoles(taskData);
        const developer = resolveDeveloperRole(taskData, roles);
        const reason = extractReopenReason(content);

        if (taskData.tapd_story_id && typeof (ctx.tapd as any).addStoryComment === "function") {
            const comment = [
                `打回原因：${reason}`,
                `创建人：${roles.creator?.name || taskData.creator_name || "未设置"}`,
            ].join("<br>");
            const commentResult = await (ctx.tapd as any).addStoryComment(taskData.tapd_story_id, comment, message.sender_name);
            if (!commentResult.ok) {
                ctx.store.appendAuditLog("tapd_comment_failed", {
                    task_id: taskData.id,
                    tapd_story_id: taskData.tapd_story_id,
                    error: commentResult.error,
                    reason,
                });
                tapdErrorMsg += "\n(⚠️ 注：机器人已记录打回原因，但同步 TAPD 评论失败；请管理员检查 TAPD 权限或评论接口配置。)";
            }
        }

        if (developer?.open_id) {
            if (taskData.tapd_story_id && developer.name) {
                const ownerResult = await ctx.tapd.updateStoryOwner(taskData.tapd_story_id, developer.name);
                if (!ownerResult.ok) {
                    ctx.store.appendAuditLog("tapd_update_failed", {
                        task_id: taskData.id,
                        tapd_story_id: taskData.tapd_story_id,
                        tapd_owner: developer.name,
                        error: ownerResult.error,
                    });
                    tapdErrorMsg += "\n(⚠️ 注：机器人已记录处理人变更，但同步 TAPD 处理人失败；请管理员检查 TAPD 权限或成员映射。)";
                }
            }
            taskData.primary_owner_open_id = developer.open_id;
            taskData.primary_owner_name = developer.name;
            if (!(taskData.assignee_open_ids || []).includes(developer.open_id)) {
                taskData.assignee_open_ids = [...(taskData.assignee_open_ids || []), developer.open_id];
                taskData.assignee_names = [...(taskData.assignee_names || []), developer.name];
            }
        }
        setWorkflowPhase(workflow, "development", {
            type: "reopened",
            at: utcNowIso(),
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: content,
        });
    }

    if (status === "blocked") {
        const blockedAt = taskData.blocked_at || utcNowIso();
        workflow.blocked = true;
        workflow.resume_phase = workflow.phase;
        workflow.resume_status = taskData.status === "blocked" ? workflow.resume_status : taskData.status;
        recordWorkflowEvent(workflow, {
            type: "blocked",
            at: blockedAt,
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: content,
        });
        taskData.blocked_at = blockedAt;
        taskData.blocker_info = parseBlockerInfo(ctx, content, message, blockedAt);
    } else {
        taskData.blocked_at = null;
        taskData.blocker_info = {};
    }

    if (updateType === "accepted" && workflow.phase !== "implemented") {
        setWorkflowPhase(workflow, "implemented", {
            type: "product_accepted",
            at: utcNowIso(),
            actor_open_id: message.sender_open_id,
            actor_name: message.sender_name,
            detail: content,
        });
    }
    taskData.status = status;
    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    await ctx.store.saveTask(task);

    const metadata = updateType === "blocked" ? task.blocker_info : undefined;
    await saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", updateType, content, source, message.id, metadata);

    const cleanTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    const displayStatus = statusDisplayLabel(status, updateType, tapdStatus);

    if (["accepted_by_owner", "developer_accepted"].includes(updateType)) {
        const groupName = ctx.config.groups.find(g => g.chat_id === task.source_group_id)?.name || "未知来源";
        const targetOpenIds = (task.assignee_open_ids && task.assignee_open_ids.length > 0)
            ? task.assignee_open_ids
            : [task.primary_owner_open_id];

        for (const targetOpenId of targetOpenIds) {
            if (!targetOpenId) continue;
            const res = await ctx.feishu.sendPrivateText(
                targetOpenId,
                `已确认接受【${groupName}】的任务：${cleanTitle}${tapdErrorMsg}\n请补充任务计划：\n\n预计完成时间：\n拆分步骤：\n依赖对象：\n风险点：\n是否需要协助：`
            );
            if (res.message_id) {
                ctx.store.saveBotMessageContext({
                    message_id: res.message_id,
                    context_type: "task_plan_request",
                    created_at: utcNowIso(),
                    chat_id: res.chat_id || "",
                    chat_type: "p2p",
                    target_open_id: targetOpenId,
                    task_id: task.id,
                    task_title: task.title,
                    metadata: { tapd_story_id: task.tapd_story_id || "" }
                });
            }
        }
        await notifyTaskCreatorPrivate(ctx, task, `负责人 ${message.sender_name} 已接受任务：${cleanTitle}${tapdErrorMsg}`, "task_status_notice", message.sender_open_id);
    } else if (updateType === "owner_marked_done") {
        const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
        const ownerText = handoffOwner ? `\n测试负责人：${handoffOwner.name}` : "";
        const pendingText = workflow.pending_acceptances.length ? `\n等待测试与产品接受（0/${workflow.pending_acceptances.length}）` : "";
        const text = `${previousOwnerName || message.sender_name} 已完成开发，任务已转测试：${cleanTitle}${link}${ownerText}${pendingText}${tapdErrorMsg}\n测试与产品请分别引用本消息回复“接受”；两方都接受后进入测试进行中。`;
        const targetChatId = source === "group" ? message.chat_id : task.source_group_id;
        const roles = ensureTaskRoles(task, previousOwner);
        const acceptanceOwner = roles.tester || roles.creator;

        let res: any;
        if (source === "group") res = await ctx.feishu.sendReplyText(message.id, text);
        else res = await ctx.feishu.sendGroupText(text, targetChatId || "");

        if (res.message_id) {
            ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "task_acceptance_prompt",
                created_at: utcNowIso(),
                chat_id: targetChatId || "",
                chat_type: "group",
                target_open_id: acceptanceOwner?.open_id || task.creator_open_id,
                task_id: task.id,
                task_title: task.title,
                metadata: { tapd_story_id: task.tapd_story_id || "" }
            });
        }
        if (acceptanceOwner?.open_id) {
            const privateText = `任务已转测试，等待你确认接收：${cleanTitle}${link}${tapdErrorMsg}\n请回复“接受”；测试与产品都接受后进入测试进行中。`;
            const privateRes = await ctx.feishu.sendPrivateText(acceptanceOwner.open_id, privateText);
            if (privateRes.message_id) {
                ctx.store.saveBotMessageContext({
                    message_id: privateRes.message_id,
                    context_type: "task_acceptance_prompt",
                    created_at: utcNowIso(),
                    chat_id: privateRes.chat_id || "",
                    chat_type: "p2p",
                    target_open_id: acceptanceOwner.open_id,
                    task_id: task.id,
                    task_title: task.title,
                    metadata: { tapd_story_id: task.tapd_story_id || "" }
                });
            }
        }
    } else {
        const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";

        if (status === "blocked") {
            const helper = (message.mentions || []).find(m => m.open_id !== ctx.config?.feishu?.bot_open_id && m.open_id !== message.sender_open_id);
            if (helper && helper.open_id && source === "group") {
                const blockedReply = `任务阻塞需要协助：${cleanTitle}${link}\n负责人：${message.sender_name}\n协助人：<at user_id="${helper.open_id}">${helper.name}</at>\n说明：${content.trim() || "未填写"}`;
                await replyInGroup(ctx, message, blockedReply, task);
            } else if (helper && helper.open_id) {
                let replyText = `任务状态已更新：${cleanTitle}${link} -> ${displayStatus}${tapdErrorMsg}`;
                replyText += `\n已通知 <at user_id="${helper.open_id}">${helper.name}</at> 协助排查；任务负责人保持不变。`;
                await reply(ctx, message, source, replyText, task);
            } else {
                let replyText = `任务状态已更新：${cleanTitle}${link} -> ${displayStatus}${tapdErrorMsg}`;
                await reply(ctx, message, source, replyText, task);
            }
        } else {
            let replyText = `任务状态已更新：${cleanTitle}${link} -> ${displayStatus}${tapdErrorMsg}`;
            await reply(ctx, message, source, replyText, task);
        }
        if (updateType === "reopened" && task.primary_owner_open_id) {
            const reason = extractReopenReason(content);
            const privateRes = await ctx.feishu.sendPrivateText(
                task.primary_owner_open_id,
                `任务被打回，已转回开发：${cleanTitle}${link}\n打回原因：${reason}${tapdErrorMsg}`
            );
            if (privateRes.message_id) {
                ctx.store.saveBotMessageContext({
                    message_id: privateRes.message_id,
                    context_type: "task_status_notice",
                    created_at: utcNowIso(),
                    chat_id: privateRes.chat_id || "",
                    chat_type: "p2p",
                    target_open_id: task.primary_owner_open_id,
                    task_id: task.id,
                    task_title: task.title,
                    metadata: { tapd_story_id: task.tapd_story_id || "" }
                });
            }
        }
        const actionText = content.trim() || displayStatus;
        await notifyTaskCreatorPrivate(ctx, task, `负责人 ${message.sender_name} 更新了任务状态：${displayStatus}${tapdErrorMsg}\n回复内容：${actionText}`, "task_status_notice", message.sender_open_id);
    }

    ctx.store.appendAuditLog("task_status_updated", { task_id: task.id, status, tapd_status: tapdStatus, update_type: updateType, owner_open_id: task.primary_owner_open_id, owner_name: task.primary_owner_name });
    return { handled: true, action: updateType, task_id: task.id, status };
}

function statusDisplayLabel(status: string, updateType: string, tapdStatus?: string): string {
    const updateLabels: Record<string, string> = {
        accepted_by_owner: "已接受，开发进行中",
        requirement_accepted: "已接受，进入需求阶段",
        developer_accepted: "已接受，开发进行中",
        development_completed: "开发完成",
        testing_started: "测试进行中",
        rejected_by_owner: "已拒绝",
        owner_marked_done: "已转测试",
        accepted: "已验收",
        reopened: "已打回，转回开发",
        cancelled: "已取消",
        deleted: "已删除",
        blocked: "已阻塞",
        unblocked: "已解除阻塞，继续开发",
    };
    if (updateLabels[updateType]) return updateLabels[updateType];

    const localLabels: Record<string, string> = {
        pending_confirmation: "待确认",
        requirement: "需求",
        confirmed: "开发进行中",
        in_progress: "开发进行中",
        development_completed: "开发完成",
        owner_marked_done: "转测试",
        testing: "测试进行中",
        accepted: "已实现",
        cancelled: "已取消",
        deleted: "已删除",
        blocked: "已阻塞",
    };
    if (localLabels[status]) return localLabels[status];

    const tapdLabels: Record<string, string> = {
        [TAPD_STATUS_REQUIREMENT]: "需求",
        [TAPD_STATUS_IN_PROGRESS]: "开发进行中",
        [TAPD_STATUS_TESTING]: "测试进行中",
        [TAPD_STATUS_DONE]: "已实现",
        [TAPD_STATUS_CANCELLED]: "已取消",
        [TAPD_STATUS_BLOCKED]: "已阻塞",
    };
    return tapdStatus && tapdLabels[tapdStatus] ? tapdLabels[tapdStatus] : status;
}

function personRole(open_id?: string, name?: string): TaskRole {
    if (!open_id && !name) return null;
    return { open_id: open_id || "", name: name || "" };
}

function ensureTaskRoles(taskData: any, developerFallback?: TaskRole): any {
    if (!taskData.trace || typeof taskData.trace !== "object") taskData.trace = {};
    if (!taskData.trace.roles || typeof taskData.trace.roles !== "object") taskData.trace.roles = {};
    const roles = taskData.trace.roles;
    if (!roles.creator) roles.creator = personRole(taskData.creator_open_id, taskData.creator_name);
    if (!roles.developer && developerFallback) roles.developer = developerFallback;
    if (!("tester" in roles)) roles.tester = null;
    return roles;
}

function resolveDeveloperRole(taskData: any, roles: any): TaskRole {
    if (roles.developer?.open_id || roles.developer?.name) return roles.developer;

    const ownerId = taskData.primary_owner_open_id || "";
    const assigneeIds = taskData.assignee_open_ids || [];
    const assigneeNames = taskData.assignee_names || [];
    const fallbackIndex = assigneeIds.findIndex((openId: string) => openId && openId !== ownerId);
    if (fallbackIndex >= 0) {
        const developer = personRole(assigneeIds[fallbackIndex], assigneeNames[fallbackIndex]);
        roles.developer = developer;
        return developer;
    }

    const creator = personRole(taskData.creator_open_id, taskData.creator_name);
    if (creator?.open_id || creator?.name) return creator;
    return personRole(taskData.primary_owner_open_id, taskData.primary_owner_name);
}

function extractReopenReason(content: string): string {
    const cleaned = content
        .replace(/@\S+\s*/g, "")
        .replace(/^\s*(?:已)?打回\s*(?:原因)?\s*[，,。:：-]?\s*/u, "")
        .trim();
    return cleaned || "未填写具体原因";
}

function mentionedAssignee(ctx: HandlerContext, message: SourceMessage): Mention | null {
    return (message.mentions || []).find(m =>
        !!m.open_id &&
        m.open_id !== ctx.config?.feishu?.bot_open_id &&
        m.open_id !== message.sender_open_id
    ) || null;
}

async function rejectInactiveTask(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
): Promise<any | null> {
    await syncTaskFromTapd(ctx, taskData);
    if (isActiveTask(taskData)) return null;

    await reply(ctx, message, source, `任务“${taskData.title || taskData.id}”已在 TAPD 删除或取消，不能继续更新。`, taskData);
    await ctx.store.appendAuditLog("inactive_task_update_rejected", {
        task_id: taskData.id,
        tapd_story_id: taskData.tapd_story_id || null,
        status: taskData.status,
        source_message_id: message.id,
    });
    return { handled: true, action: "task_inactive", task_id: taskData.id, status: taskData.status };
}

export async function requestClarification(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    const task = taskData as Task;
    const cleanTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "clarification_requested", content, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `已记录澄清请求：${cleanTitle}${link}`, task);

    const notice = `负责人 ${message.sender_name} 对任务提出澄清请求：${task.title}${link}\n回复内容：${content}`;
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, notice);
    } else if (source === "group") {
        const res = await ctx.feishu.sendReplyText(message.id, notice);
        if (res && res.message_id) {
            ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "task_clarification",
                created_at: utcNowIso(),
                chat_id: message.chat_id || "",
                task_id: task.id,
                task_title: task.title,
                metadata: { tapd_story_id: task.tapd_story_id || "" }
            });
        }
    }

    ctx.store.appendAuditLog("task_clarification_requested", { task_id: task.id, source_message_id: message.id });
    return { handled: true, action: "clarification_requested", task_id: task.id, status: task.status };
}

export async function saveProgress(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    const task = taskData as Task;
    const cleanTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "progress", content, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `已记录任务进度：${cleanTitle}${link}`, task);
    if (source === "private" && task.source_message_id) {
        await notifyTaskCreatorPrivate(ctx, task, `负责人 ${message.sender_name} 更新了任务进度：\n${content}`, "task_status_notice", message.sender_open_id);
    }
    return { handled: true, action: "progress_saved", task_id: task.id };
}

export async function saveTaskPlan(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    const taskPlan = parseTaskPlan(content);
    const dueDate = parseTaskPlanDueDate(taskPlan, content);
    taskData.task_plan = taskPlan;
    if (dueDate) {
        taskData.due_date = dueDate;
        if (taskData.tapd_story_id && typeof ctx.tapd.updateStoryDueDate === "function") {
            const tapdResult = await ctx.tapd.updateStoryDueDate(taskData.tapd_story_id, dueDate);
            if (!tapdResult.ok) {
                ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, tapd_story_id: taskData.tapd_story_id, due_date: dueDate, error: tapdResult.error });
            }
        }
    }
    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);

    const cleanTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "task_plan", content, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    const dueText = dueDate ? `\n截止时间已更新：${dueDate}` : "";
    await reply(ctx, message, source, `已保存任务计划：${cleanTitle}${link}${dueText}`, task);
    if (source === "private" && task.source_message_id) {
        const notifyIds = new Set<string>();
        (task.assignee_open_ids || []).forEach((id: string) => notifyIds.add(id));
        notifyIds.delete(message.sender_open_id || "");

        const creatorId = task.creator_open_id || task.source_sender_open_id;
        if (creatorId) notifyIds.add(creatorId);

        for (const targetId of notifyIds) {
            await sendTaskPrivateNotice(ctx, task, targetId, `负责人 ${message.sender_name} 补充了任务计划：\n${content}${dueText}`, "task_status_notice");
        }
    }
    ctx.store.appendAuditLog("task_plan_saved", { task_id: task.id, source_message_id: message.id, due_date: dueDate || task.due_date || null });
    return { handled: true, action: "task_plan_saved", task_id: task.id, due_date: dueDate || task.due_date || null };
}

function parseBlockerInfo(ctx: HandlerContext, text: string, message: SourceMessage, blockedAt: string): any {
    const reasonMatch = text.match(/(?:原因是|原因[:：]|因为)(.+?)(?:，?需要|。|$)/);
    const reason = reasonMatch ? reasonMatch[1].replace(/^[ ，,。；;]+/, "").replace(/[ ，,。；;]+$/, "") : "";

    const helperNames = (message.mentions || [])
        .filter(m => m.open_id !== ctx.config?.feishu?.bot_open_id && m.open_id !== message.sender_open_id)
        .map(m => m.name);

    const helperMatch = text.match(/需要(.+?)协助/);
    const helperText = helperMatch ? helperMatch[1].replace(/^[ ：:，,。；;]+/, "").replace(/[ ：:，,。；;]+$/, "") : "";
    if (helperText) {
        helperText.split(/[、,，\s]+/).filter(Boolean).forEach(n => helperNames.push(n));
    }

    const seenHelpers = Array.from(new Set(helperNames.filter(Boolean)));
    return {
        reason: reason || text,
        blocked_by_open_id: message.sender_open_id,
        blocked_by_name: message.sender_name,
        assistance_needed: seenHelpers,
        blocked_at: blockedAt,
        source_message_id: message.id,
        suggested_action: "确认协助人和下一步恢复动作",
    };
}

function parseTaskPlan(text: string): any {
    return {
        raw_text: text,
        estimated_time: extractPlanField(text, ["预计完成时间", "预计时间", "完成时间", "预计完成"]),
        steps: extractPlanItems(text, ["拆分步骤", "步骤", "计划"]),
        dependencies: extractPlanItems(text, ["依赖对象", "依赖"]),
        risks: extractPlanItems(text, ["风险点", "风险"]),
        need_help: parseNeedHelp(text)
    };
}

function parseTaskPlanDueDate(taskPlan: any, text: string): string | null {
    const estimatedTime = typeof taskPlan?.estimated_time === "string" ? taskPlan.estimated_time : "";
    return parseDueDateText(estimatedTime) || parseDueDateText(text);
}

function extractPlanField(text: string, labels: string[]): string {
    const pattern = labels.join("|");
    const regex = new RegExp(`(?:${pattern})\\s*[:：]\\s*([^\\n；;]+)`);
    const match = regex.exec(text);
    return match ? match[1].trim() : "";
}

function extractPlanItems(text: string, labels: string[]): string[] {
    const pattern = labels.join("|");
    const allHeaders = "预计完成时间|预计时间|完成时间|预计完成|拆分步骤|步骤|计划|依赖对象|依赖|风险点|风险|是否需要协助|需要协助";
    const regex = new RegExp(`(?:${pattern})\\s*[:：]\\s*(.+?)(?=(?:${allHeaders})\\s*[:：]|$)`, "s");
    const match = regex.exec(text);
    if (!match) return [];

    const raw = match[1].trim();
    if (["无", "暂无", "没有"].includes(raw)) return [];

    return raw.split(/(?:\n+|\d+[.、)]|[；;])/).map(i => i.replace(/^[ -，,。；;\n]+/, "").replace(/[ -，,。；;\n]+$/, "")).filter(Boolean);
}

function parseNeedHelp(text: string): boolean {
    const match = text.match(/(?:是否需要协助|需要协助)\s*[:：]\s*([^\n；;]+)/);
    if (!match) return text.includes("需要协助") && !text.includes("不需要协助");
    const val = match[1].trim();
    return val.startsWith("是") || val.startsWith("需要") || val.includes("需要");
}

export async function updateTaskDue(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string, text: string): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    const task = taskData as Task;
    applyTaskDueDate(task, dueDate, utcNowIso());

    if (task.tapd_story_id && typeof ctx.tapd.updateStoryDueDate === "function") {
        const tapdResult = await ctx.tapd.updateStoryDueDate(task.tapd_story_id, dueDate);
        if (!tapdResult.ok) {
            await ctx.store.appendAuditLog("tapd_update_failed", { task_id: task.id, tapd_story_id: task.tapd_story_id, due_date: dueDate, error: tapdResult.error });
        }
    }

    await ctx.store.saveTask(task);
    await saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "due_date_updated", `更新截止时间为：${dueDate}`, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    const cleanTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    await reply(ctx, message, source, `任务截止时间已更新：${cleanTitle}${link} -> ${dueDate}`, task);

    if (source === "private" && task.source_message_id) {
        await notifyTaskCreatorPrivate(ctx, task, `负责人 ${message.sender_name} 调整了任务截止时间：${dueDate}\n补充说明：${text}`, "task_status_notice", message.sender_open_id);
    }
    if (task.primary_owner_open_id && task.primary_owner_open_id !== message.sender_open_id) {
        await ctx.feishu.sendPrivateText(task.primary_owner_open_id, `您的任务截止时间已被 ${message.sender_name} 更新...\n任务：${cleanTitle}\n修改内容：更新截止时间为 ${dueDate}`);
    }
    await ctx.store.appendAuditLog("task_due_updated", { task_id: task.id, due_date: dueDate });
    return { handled: true, action: "due_date_updated", task_id: task.id, due_date: dueDate };
}

export async function reply(ctx: HandlerContext, message: SourceMessage, source: string, text: string, task?: any): Promise<any> {
    let res: any;
    if (source === "group" && !task) res = await ctx.feishu.sendReplyText(message.id, text);
    else res = await ctx.feishu.sendPrivateText(message.sender_open_id || "", text);

    if (task && res && res.message_id) {
        await ctx.store.saveBotMessageContext({
            message_id: res.message_id,
            context_type: "task_status_notice",
            created_at: utcNowIso(),
            chat_id: res.chat_id || "",
            chat_type: "p2p",
            target_open_id: message.sender_open_id,
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" }
        });
    }
    return res;
}

async function replyInGroup(ctx: HandlerContext, message: SourceMessage, text: string, task: Task): Promise<any> {
    const res = await ctx.feishu.sendReplyText(message.id, text);
    if (res && res.message_id) {
        await ctx.store.saveBotMessageContext({
            message_id: res.message_id,
            context_type: "task_status_notice",
            created_at: utcNowIso(),
            chat_id: res.chat_id || message.chat_id || "",
            chat_type: "group",
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" },
        });
    }
    return res;
}

export async function updateTaskSupplement(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string | null, criteria: string[], text: string): Promise<any> {
    const inactiveResult = await rejectInactiveTask(ctx, message, source, taskData);
    if (inactiveResult) return inactiveResult;
    const task = taskData as Task;
    const supplement = applyTaskSupplement(task, { dueDate, criteria }, utcNowIso());

    if (!supplement.updated) {
        await reply(ctx, message, source, "没有识别到需要补充的有效时间或验收标准。");
        return { handled: true, action: "supplement_ignored" };
    }

    await ctx.store.saveTask(task);
    const content = supplement.messages.join("\n");
    await saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "task_supplemented", content, source, message.id);

    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    const cleanTitle = task.title.replace(new RegExp(`^${task.primary_owner_name}[：:]\\s*`), '');
    await reply(ctx, message, source, `任务信息已补充：${cleanTitle}${link}\n${content}`, task);

    if (source === "private" && task.source_message_id) {
        await notifyTaskCreatorPrivate(ctx, task, `负责人 ${message.sender_name} 补充了任务信息：\n${content}`, "task_status_notice", message.sender_open_id);
    }
    if (task.primary_owner_open_id && task.primary_owner_open_id !== message.sender_open_id) {
        await ctx.feishu.sendPrivateText(task.primary_owner_open_id, `您的任务信息已被 ${message.sender_name} 补充...\n任务：${cleanTitle}\n修改内容：\n${content}`);
    }
    await ctx.store.appendAuditLog("task_supplemented", { task_id: task.id, due_date: task.due_date, acceptance_criteria: task.acceptance_criteria });
    return { handled: true, action: "task_supplemented", task_id: task.id };
}
