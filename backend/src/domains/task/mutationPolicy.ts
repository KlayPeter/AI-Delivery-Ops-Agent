import type { Task } from '@/models/types';

export interface TaskSupplementResult {
    updated: boolean;
    messages: string[];
}

export function applyTaskDueDate(task: Task, dueDate: string, updatedAt: string): void {
    task.due_date = dueDate;
    task.updated_at = updatedAt;
}

export function applyTaskSupplement(
    task: Task,
    input: { dueDate: string | null; criteria: string[] },
    updatedAt: string,
): TaskSupplementResult {
    const messages: string[] = [];

    if (input.dueDate && task.due_date !== input.dueDate) {
        task.due_date = input.dueDate;
        messages.push(`截止时间更新为：${input.dueDate}`);
    }

    if (input.criteria.length > 0) {
        task.acceptance_criteria = Array.from(new Set([...(task.acceptance_criteria || []), ...input.criteria]));
        messages.push(`验收标准补充为：${task.acceptance_criteria.join('；')}`);
    }

    if (messages.length > 0) task.updated_at = updatedAt;
    return { updated: messages.length > 0, messages };
}
