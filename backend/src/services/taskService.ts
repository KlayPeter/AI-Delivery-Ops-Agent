import { HandlerContext } from './messageHandler/types';
import {
    SourceMessage,
    Task,
    TaskUpdate,
    utcNowIso,
} from '@/models/types';
import { ParsedTaskCommand } from '@/services/taskParser';
import { createTaskFromCommand, saveUpdate } from './messageHandler/taskCommands';
import { applyAction, saveProgress, saveTaskPlan, setTaskStatus, updateTaskDue, updateTaskSupplement } from './messageHandler/statusUpdates';
import { syncTaskFromTapd } from './messageHandler/utils';
import { HumanGanttService, type GanttRole } from '@/domains/task/humanGantt';
import { isTaskDirectlyCompleted, projectTaskHierarchy } from '@/domains/task/tapdHierarchy';
import {
    syncProjectTasks,
    type ProjectSyncOptions,
    type ProjectTaskSyncResult,
} from '@/domains/task/projectSync';

export type { ProjectTaskSyncResult } from '@/domains/task/projectSync';

export interface ProjectRefreshOptions extends ProjectSyncOptions {
    cacheTtlMs?: number;
    force?: boolean;
}

interface ProjectSyncCacheEntry {
    completedAt: number;
    result?: ProjectTaskSyncResult;
    inFlight?: Promise<ProjectTaskSyncResult>;
}

const projectSyncCache = new WeakMap<object, ProjectSyncCacheEntry>();

export class TaskService {
    static isStandupCommitment(task: Partial<Task> | null | undefined): boolean {
        return Array.isArray(task?.tags) && task.tags.includes("standup_commitment");
    }

    static async createStandupCommitment(ctx: HandlerContext, message: SourceMessage, input: {
        title: string;
        ownerOpenId: string;
        ownerName: string;
        dueAt: string;
    }): Promise<Task> {
        const now = utcNowIso();
        const task: Task = {
            id: `standup-commitment-${message.id}`,
            title: input.title,
            creator_open_id: message.sender_open_id || "",
            creator_name: message.sender_name || "",
            primary_owner_open_id: input.ownerOpenId,
            primary_owner_name: input.ownerName,
            assignee_open_ids: [input.ownerOpenId],
            assignee_names: [input.ownerName],
            status: "in_progress",
            priority: "P2",
            source_message_id: message.id,
            source_group_id: message.chat_id,
            created_at: now,
            updated_at: now,
            source_sender_open_id: message.sender_open_id,
            source_sender_name: message.sender_name,
            source_sent_at: message.sent_at,
            raw_text: message.text,
            ai_result: { type: "standup_commitment", parser: "deterministic_rule", title: input.title, due_at: input.dueAt },
            confidence: 1,
            description: "任务型站会承诺，不同步 TAPD",
            due_date: input.dueAt,
            acceptance_criteria: [],
            tags: ["standup_commitment"],
            tapd_story_id: null,
            tapd_url: null,
            parent_id: null,
            is_draft: false,
        };
        await ctx.store.saveTask(task);
        await this.saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "standup_committed", `承诺在 ${input.dueAt} 前交付：${input.title}`, "standup", message.id, {
            standup_commitment: true,
            due_at: input.dueAt,
        });
        return task;
    }

    static async reportStandupCommitment(ctx: HandlerContext, task: Task, message: SourceMessage, input: {
        status: "completed" | "in_progress" | "blocked" | "delayed";
        content: string;
        nextDueAt?: string;
    }): Promise<Task> {
        const next = { ...task };
        if (input.status === "completed") next.status = "owner_marked_done";
        if (input.status === "in_progress") next.status = "in_progress";
        if (input.status === "blocked") {
            next.status = "blocked";
            next.blocked_at = utcNowIso();
            next.blocker_info = { content: input.content, source: "standup_commitment" };
        }
        if (input.status === "delayed") {
            next.status = "in_progress";
            if (input.nextDueAt) next.due_date = input.nextDueAt;
        }
        next.updated_at = utcNowIso();
        await ctx.store.saveTask(next);
        await this.saveUpdate(ctx, next, message.sender_open_id || "", message.sender_name || "", `standup_${input.status}`, input.content, "standup", message.id, {
            standup_commitment: true,
            report_status: input.status,
            next_due_at: input.nextDueAt,
        });
        return next;
    }

    static projectHierarchy(tasks: Task[]) {
        return projectTaskHierarchy(tasks);
    }

    static isDirectlyCompleted(task: Partial<Task>): boolean {
        return isTaskDirectlyCompleted(task);
    }

    static async markOverdue(store: any, taskData: any, reason: string): Promise<boolean> {
        if (taskData.status === "overdue") return false;

        taskData.status = "overdue";
        taskData.updated_at = utcNowIso();
        const task = taskData as Task;
        await store.saveTask(task);

        const update: TaskUpdate = {
            id: `update-${task.id}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            task_id: task.id || "",
            user_open_id: "system",
            user_name: "系统",
            update_type: "overdue",
            content: `任务已超期：${task.due_date}`,
            source: "system",
            source_message_id: null,
            source_group_id: "",
            source_sender_open_id: "",
            source_sender_name: "",
            source_sent_at: "",
            raw_text: "",
            ai_result: {},
            confidence: 1.0,
            trace: {},
            created_at: utcNowIso(),
            metadata: { reason, due_date: task.due_date },
        };
        await store.saveTaskUpdate(update);
        await store.appendAuditLog("task_status_updated", { task_id: task.id, status: "overdue", update_type: "overdue", reason });
        return true;
    }

    static async humanGantt(store: any, config: any, options: { from?: string; to?: string; includeImplemented?: boolean } = {}): Promise<any> {
        return HumanGanttService.build(store, config, options);
    }

    static async updateGanttPlan(store: any, taskId: string, input: { employee_open_id: string; role: GanttRole; start: string; end: string }): Promise<any> {
        return HumanGanttService.savePlan(store, taskId, input);
    }

    static async deleteGanttPlan(store: any, taskId: string, input: { employee_open_id: string; role: GanttRole }): Promise<any> {
        return HumanGanttService.deletePlan(store, taskId, input);
    }

    static async createFromCommand(ctx: HandlerContext, message: SourceMessage, command: ParsedTaskCommand, parentId?: string): Promise<any> {
        return createTaskFromCommand(ctx, message, command, parentId);
    }

    static async applyAction(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, action: string, text: string): Promise<any> {
        return applyAction(ctx, message, source, taskData, action, text);
    }

    static async setStatus(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, status: string, updateType: string, content: string, tapdStatus?: string): Promise<any> {
        return setTaskStatus(ctx, message, source, taskData, status, updateType, content, tapdStatus);
    }

    static async saveProgress(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
        return saveProgress(ctx, message, source, taskData, content);
    }

    static async savePlan(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
        return saveTaskPlan(ctx, message, source, taskData, content);
    }

    static async updateDue(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string, text: string): Promise<any> {
        return updateTaskDue(ctx, message, source, taskData, dueDate, text);
    }

    static async updateSupplement(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string | null, criteria: string[], text: string): Promise<any> {
        return updateTaskSupplement(ctx, message, source, taskData, dueDate, criteria, text);
    }

    static async saveUpdate(ctx: HandlerContext, task: Task, userOpenId: string, userName: string, updateType: string, content: string, source: string, sourceMessageId?: string, metadata?: Record<string, any>): Promise<void> {
        return saveUpdate(ctx, task, userOpenId, userName, updateType, content, source, sourceMessageId, metadata);
    }

    static async syncFromTapd(ctxOrTapd: any, taskData: any, explicitStore?: any): Promise<boolean> {
        return syncTaskFromTapd(ctxOrTapd, taskData, explicitStore);
    }

    static projectSyncError(prefix: string, result: ProjectTaskSyncResult): Error {
        return Object.assign(new Error(`${prefix}：${result.error || "未知错误"}`), {
            code: result.code || 'TAPD_PROJECT_SYNC_FAILED',
            retryable: result.retryable !== false,
        });
    }

    static async syncProjectScope(ctx: any, options: ProjectRefreshOptions = {}): Promise<ProjectTaskSyncResult> {
        const { cacheTtlMs = 30_000, force = false, ...syncOptions } = options;
        const cacheKey = ctx?.store && typeof ctx.store === 'object' ? ctx.store as object : null;
        const cached = cacheKey ? projectSyncCache.get(cacheKey) : undefined;
        const now = Date.now();
        if (cached?.inFlight) return cached.inFlight;
        if (!force && cached?.result?.ok && now - cached.completedAt < Math.max(0, cacheTtlMs)) return cached.result;

        const inFlight = syncProjectTasks(ctx, syncOptions).then(result => {
            if (cacheKey) {
                if (result.ok) projectSyncCache.set(cacheKey, { completedAt: Date.now(), result });
                else projectSyncCache.delete(cacheKey);
            }
            return result;
        }, error => {
            if (cacheKey) projectSyncCache.delete(cacheKey);
            throw error;
        });
        if (cacheKey) projectSyncCache.set(cacheKey, { completedAt: 0, inFlight });
        return inFlight;
    }
}
