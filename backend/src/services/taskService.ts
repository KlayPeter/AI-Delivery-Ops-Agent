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

export class TaskService {
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

    static async syncProjectScope(ctx: any, options: ProjectSyncOptions = {}): Promise<ProjectTaskSyncResult> {
        return syncProjectTasks(ctx, options);
    }
}
