import type { Task } from '@/models/types';

function isAffirmativeCompletion(text: string): boolean {
    return /(已完成|完成了|已经完成)/.test(text) && !/(没|不|未)完成/.test(text);
}

export function isImplementedTaskAction(text: string, task: Pick<Task, 'status' | 'trace'>): boolean {
    if (/(已实现|已经实现|验收完成|验收通过|已结束|已经结束|结束)/.test(text)) return true;
    const legacyTransferTask = !task.trace?.workflow && task.status === 'owner_marked_done';
    return isAffirmativeCompletion(text) && legacyTransferTask;
}

export function isDevelopmentCompletedTaskAction(text: string, task: Pick<Task, 'status' | 'trace'>): boolean {
    if (/(开发完成|开发完毕|开发完了)/.test(text)) return true;
    const phase = task.trace?.workflow?.phase;
    const developmentPhase = ['development', 'development_completed'].includes(phase)
        || (!phase && ['confirmed', 'in_progress', 'development_completed'].includes(task.status));
    return isAffirmativeCompletion(text) && developmentPhase;
}

export function isTransferTestTaskAction(text: string): boolean {
    return /(转测试|提测)/.test(text);
}
