import {
    type Task,
    TASK_STATUS_ACCEPTED,
    TASK_STATUS_BLOCKED,
    TASK_STATUS_CANCELLED,
    TASK_STATUS_DEVELOPMENT_COMPLETED,
    TASK_STATUS_IN_PROGRESS,
    TASK_STATUS_OWNER_MARKED_DONE,
    TASK_STATUS_PENDING_CONFIRMATION,
    TASK_STATUS_REQUIREMENT,
    TASK_STATUS_TESTING,
} from '@/models/types';

export function canonicalTapdStatus(value: unknown): string {
    const status = String(value || '').trim().toLowerCase();
    if (['status_5', 'resolved', 'closed', 'done', 'completed', 'accepted', 'implemented'].includes(status)) return TASK_STATUS_ACCEPTED;
    if (['status_20', 'cancelled', 'canceled', 'rejected'].includes(status)) return TASK_STATUS_CANCELLED;
    if (['workflow_suspended', 'blocked', 'suspended'].includes(status)) return TASK_STATUS_BLOCKED;
    if (['status_21', 'development_completed', 'develop_completed', 'ready_for_testing'].includes(status)) return TASK_STATUS_DEVELOPMENT_COMPLETED;
    if (['status_6', 'testing', 'test'].includes(status)) return TASK_STATUS_TESTING;
    if (['status_3', 'ready_for_test'].includes(status)) return TASK_STATUS_OWNER_MARKED_DONE;
    if (['status_14', 'in_progress', 'developing', 'development'].includes(status)) return TASK_STATUS_IN_PROGRESS;
    if (['status_2', 'requirement', 'draft', 'planning'].includes(status)) return TASK_STATUS_REQUIREMENT;
    return TASK_STATUS_PENDING_CONFIRMATION;
}

export function canonicalTapdStatusForExisting(value: unknown, existing?: Task): string {
    const status = canonicalTapdStatus(value);
    if (status === TASK_STATUS_IN_PROGRESS && existing?.trace?.workflow?.phase === 'development_completed') {
        return TASK_STATUS_DEVELOPMENT_COMPLETED;
    }
    if (status === TASK_STATUS_OWNER_MARKED_DONE && existing?.trace?.workflow?.phase === 'testing') {
        return TASK_STATUS_TESTING;
    }
    return status;
}

export function canonicalTapdPriority(story: any, fallback: string = 'P2'): string {
    const raw = String(story?.priority_label || story?.priority || '').trim().toLowerCase();
    if (['p0', 'high', 'urgent', 'highest', '4'].includes(raw)) return 'P0';
    if (['p1', 'middle', 'medium', '3'].includes(raw)) return 'P1';
    if (['p2', 'low', '2'].includes(raw)) return 'P2';
    if (['p3', 'lowest', '1'].includes(raw)) return 'P3';
    return fallback || 'P2';
}
