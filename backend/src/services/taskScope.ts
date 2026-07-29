import type { Member, Task } from "@/models/types";

const INACTIVE_TASK_STATUSES = new Set(["deleted", "cancelled", "status_20"]);

export function isActiveTask(task: Pick<Task, "status" | "is_draft"> | any): boolean {
    return !!task && !task.is_draft && !INACTIVE_TASK_STATUSES.has(String(task.status || ""));
}

export function taskBelongsToMembers(task: Task | any, members: Member[] = []): boolean {
    if (!isActiveTask(task)) return false;

    const activeMembers = members.filter(member => member.is_active !== false);
    const memberOpenIds = new Set(activeMembers.map(member => member.open_id).filter(Boolean));
    const memberNames = new Set(activeMembers.map(member => member.name).filter(Boolean));
    const tapdNamesAreAuthoritative = task.trace?.tapd?.people_source === "tapd_names";
    const people = [
        { openId: task.creator_open_id, name: task.creator_name },
        { openId: task.primary_owner_open_id, name: task.primary_owner_name },
        ...(task.assignee_names || []).map((name: string, index: number) => ({
            openId: task.assignee_open_ids?.[index],
            name,
        })),
    ];

    return people.some(person =>
        (!!person.openId && memberOpenIds.has(person.openId)) ||
        (!!person.name && (!person.openId || tapdNamesAreAuthoritative) && memberNames.has(person.name))
    );
}

type TaskScopeGroup = { chat_id: string; members?: Member[] };

export function taskReminderGroupId(task: Task | any, groups: TaskScopeGroup[] = []): string | null {
    if (!isActiveTask(task)) return null;

    const sourceGroupId = String(task.source_group_id || "").trim();
    if (sourceGroupId && groups.some(group => group.chat_id === sourceGroupId)) return sourceGroupId;

    const candidates = groups.filter(group => taskBelongsToMembers(task, group.members || []));
    if (!candidates.length) return null;

    const ownerOpenId = String(task.primary_owner_open_id || "").trim();
    const ownerName = String(task.primary_owner_name || "").trim();
    const tapdNamesAreAuthoritative = task.trace?.tapd?.people_source === "tapd_names";
    const ownerGroups = candidates.filter(group => (group.members || []).some(member =>
        member.is_active !== false && (
            (!!ownerOpenId && member.open_id === ownerOpenId) ||
            ((!ownerOpenId || tapdNamesAreAuthoritative) && !!ownerName && member.name === ownerName)
        )
    ));
    const ranked = ownerGroups.length ? ownerGroups : candidates;
    return [...ranked].sort((left, right) => {
        const leftSize = (left.members || []).filter(member => member.is_active !== false).length;
        const rightSize = (right.members || []).filter(member => member.is_active !== false).length;
        return leftSize - rightSize || left.chat_id.localeCompare(right.chat_id);
    })[0]?.chat_id || null;
}
