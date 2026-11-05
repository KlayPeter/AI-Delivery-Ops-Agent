import { canonicalTapdStatus } from '@/domains/task/tapdPolicy';
import { TASK_STATUS_OWNER_MARKED_DONE, TASK_STATUS_TESTING } from '@/models/types';
import type { Task } from '@/models/types';

const INACTIVE_STATUSES = new Set(['deleted', 'cancelled', 'status_20']);
const COMPLETED_STATUSES = new Set([
    'accepted',
    'development_completed',
    'status_5',
    'resolved',
    'closed',
    'done',
    'completed',
    'implemented',
]);
const TRANSFER_TEST_PHASE = 'transfer_test' as const;
const TESTING_PHASE = 'testing' as const;
type InheritedWorkflowPhase = typeof TRANSFER_TEST_PHASE | typeof TESTING_PHASE;

export interface TaskHierarchyState {
    is_active: boolean;
    is_leaf: boolean;
    is_completed: boolean;
    completed_by_ancestor: boolean;
    completion_source_id: string | null;
    inherited_phase: InheritedWorkflowPhase | null;
    inherited_phase_source_id: string | null;
}

export interface TaskHierarchyProjection {
    get(taskOrId: Task | string): TaskHierarchyState;
    isActionableLeaf(taskOrId: Task | string): boolean;
}

export function isTaskDirectlyCompleted(task: Partial<Task>): boolean {
    const status = String(task.status || '').trim().toLowerCase();
    if (COMPLETED_STATUSES.has(status)) return true;

    const tapdStatus = String(task.trace?.tapd?.status || '').trim();
    return Boolean(tapdStatus && COMPLETED_STATUSES.has(canonicalTapdStatus(tapdStatus)));
}

export function projectTaskHierarchy(tasks: Task[]): TaskHierarchyProjection {
    const taskByExternalId = new Map<string, Task>();
    const activeById = new Map<string, boolean>();

    for (const task of tasks) {
        taskByExternalId.set(task.id, task);
        if (task.tapd_story_id) taskByExternalId.set(String(task.tapd_story_id), task);
        activeById.set(task.id, !task.is_draft && !INACTIVE_STATUSES.has(String(task.status || '').toLowerCase()));
    }

    const activeChildren = new Map<string, Task[]>();
    for (const task of tasks) {
        if (!activeById.get(task.id) || !task.parent_id) continue;
        const parent = taskByExternalId.get(String(task.parent_id));
        if (!parent || !activeById.get(parent.id)) continue;
        const children = activeChildren.get(parent.id) || [];
        children.push(task);
        activeChildren.set(parent.id, children);
    }

    const completionSourceById = new Map<string, Task | null>();
    const resolving = new Set<string>();
    const completionSource = (task: Task): Task | null => {
        if (completionSourceById.has(task.id)) return completionSourceById.get(task.id) || null;
        if (isTaskDirectlyCompleted(task)) {
            completionSourceById.set(task.id, task);
            return task;
        }
        if (!task.parent_id || resolving.has(task.id)) {
            completionSourceById.set(task.id, null);
            return null;
        }

        resolving.add(task.id);
        const parent = taskByExternalId.get(String(task.parent_id));
        const source = parent && activeById.get(parent.id) ? completionSource(parent) : null;
        resolving.delete(task.id);
        completionSourceById.set(task.id, source);
        return source;
    };

    const directWorkflowPhase = (task: Task): InheritedWorkflowPhase | null => {
        const status = String(task.status || '').trim().toLowerCase();
        if (status === TASK_STATUS_TESTING) return TESTING_PHASE;
        if (status === TASK_STATUS_OWNER_MARKED_DONE || status === TRANSFER_TEST_PHASE) return TRANSFER_TEST_PHASE;

        const tapdStatus = String(task.trace?.tapd?.status || '').trim();
        const canonicalStatus = tapdStatus ? canonicalTapdStatus(tapdStatus) : '';
        if (canonicalStatus === TASK_STATUS_TESTING) return TESTING_PHASE;
        if (canonicalStatus === TASK_STATUS_OWNER_MARKED_DONE) return TRANSFER_TEST_PHASE;
        return null;
    };

    const workflowPhaseRank = (phase: InheritedWorkflowPhase): number => phase === TESTING_PHASE ? 2 : 1;

    const inheritedPhaseById = new Map<string, { phase: InheritedWorkflowPhase; source: Task } | null>();
    const resolvingPhase = new Set<string>();
    const inheritedPhase = (task: Task): { phase: InheritedWorkflowPhase; source: Task } | null => {
        if (inheritedPhaseById.has(task.id)) return inheritedPhaseById.get(task.id) || null;

        if (!task.parent_id || resolvingPhase.has(task.id)) {
            inheritedPhaseById.set(task.id, null);
            return null;
        }

        resolvingPhase.add(task.id);
        const parent = taskByExternalId.get(String(task.parent_id));
        let result: { phase: InheritedWorkflowPhase; source: Task } | null = null;
        if (parent && activeById.get(parent.id)) {
            const parentPhase = directWorkflowPhase(parent);
            const ancestorPhase = parentPhase ? { phase: parentPhase, source: parent } : inheritedPhase(parent);
            const ownPhase = directWorkflowPhase(task);
            if (ancestorPhase && (!ownPhase || workflowPhaseRank(ancestorPhase.phase) > workflowPhaseRank(ownPhase))) {
                result = ancestorPhase;
            }
        }
        resolvingPhase.delete(task.id);
        inheritedPhaseById.set(task.id, result);
        return result;
    };

    const stateById = new Map<string, TaskHierarchyState>();
    for (const task of tasks) {
        const source = completionSource(task);
        const inherited = inheritedPhase(task);
        stateById.set(task.id, {
            is_active: Boolean(activeById.get(task.id)),
            is_leaf: !activeChildren.get(task.id)?.length,
            is_completed: Boolean(source),
            completed_by_ancestor: Boolean(source && source.id !== task.id),
            completion_source_id: source?.id || null,
            inherited_phase: inherited?.phase || null,
            inherited_phase_source_id: inherited?.source.id || null,
        });
    }

    const emptyState: TaskHierarchyState = {
        is_active: false,
        is_leaf: true,
        is_completed: false,
        completed_by_ancestor: false,
        completion_source_id: null,
        inherited_phase: null,
        inherited_phase_source_id: null,
    };
    const resolve = (taskOrId: Task | string) => stateById.get(typeof taskOrId === 'string' ? taskOrId : taskOrId.id) || emptyState;

    return {
        get: resolve,
        isActionableLeaf: taskOrId => {
            const state = resolve(taskOrId);
            return state.is_active && state.is_leaf && !state.is_completed;
        },
    };
}
