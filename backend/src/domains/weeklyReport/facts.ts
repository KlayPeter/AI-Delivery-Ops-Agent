import { StandupService } from "@/services/standupService";
import { TaskService } from "@/services/taskService";
import { taskBelongsToMembers } from "@/services/taskScope";
import type { Task } from "@/models/types";
import type {
    WeeklyMemberFacts,
    WeeklyPeriod,
    WeeklyReportFacts,
    WeeklyStandupDay,
    WeeklyTapdStatusChange,
    WeeklyTaskChange,
} from "./types";

function datePart(value: unknown): string {
    const match = /^\d{4}-\d{2}-\d{2}/.exec(String(value || ""));
    return match?.[0] || "";
}

function inPeriod(value: unknown, period: WeeklyPeriod): boolean {
    const date = datePart(value);
    return Boolean(date && date >= period.start && date <= period.end);
}

function taskOwners(task: Task): Set<string> {
    return new Set([
        task.primary_owner_open_id,
        ...(task.assignee_open_ids || []),
    ].filter(Boolean));
}

function distinct(values: string[]): string[] {
    return Array.from(new Set(values.map(value => String(value || "").trim()).filter(Boolean)));
}

function taskCompletionAt(task: Task): string {
    return String(task.trace?.tapd?.completed_at || task.updated_at || "");
}

function changeSummary(metadata: any): string {
    const changes = metadata?.changes || {};
    const labels: Record<string, string> = {
        status: "状态",
        priority: "优先级",
        due_date: "截止日期",
        primary_owner_name: "主负责人",
        assignee_names: "负责人",
        title: "标题",
        tapd_status: "TAPD 状态",
        progress: "进度",
        iteration_id: "迭代",
        completed_at: "完成时间",
    };
    const parts = Object.entries(changes).map(([field, value]: [string, any]) =>
        `${labels[field] || field}：${String(value?.from ?? "空")} → ${String(value?.to ?? "空")}`
    );
    return parts.join("；") || String(metadata?.summary || "任务信息发生变化");
}

function reportableTapdChanges(changes: Record<string, any> | undefined): Record<string, any> {
    return Object.fromEntries(Object.entries(changes || {}).filter(([field]) => field !== "status" && field !== "tapd_status"));
}

export async function collectWeeklyReportFacts(input: {
    config: any;
    store: any;
    group: any;
    period: WeeklyPeriod;
    tapdSyncedAt: string;
    tapdStatusChanges?: WeeklyTapdStatusChange[];
    tapdStatusHistoryAvailable?: boolean;
}): Promise<WeeklyReportFacts> {
    const { config, store, group, period, tapdSyncedAt } = input;
    const members = (group.members || []).filter((member: any) => member?.open_id && member.is_active !== false);
    const standupDays: WeeklyStandupDay[] = [];
    const standupsByMember = new Map<string, any[]>();

    for (const date of period.business_days) {
        const submissions = await StandupService.listGroupSubmissions(config, store, date, group);
        const view = StandupService.buildSummaryView(submissions, members);
        standupDays.push({
            date,
            submitted: view.submitted,
            expected: view.total_members,
            missing_names: view.missing_names,
            blockers: view.blocker_entries.map((entry: any) => ({ member: entry.name, text: entry.text })),
            risks: view.risk_entries.map((entry: any) => ({ member: entry.name, text: entry.text })),
            decisions: view.decision_entries.map((entry: any) => ({ member: entry.name, text: entry.text })),
        });
        for (const submission of submissions) {
            const current = standupsByMember.get(submission.open_id) || [];
            current.push(submission);
            standupsByMember.set(submission.open_id, current);
        }
    }

    const allTasks: Task[] = await store.listTasks(true);
    const scopedTasks = allTasks.filter(task => taskBelongsToMembers(task, members));
    const hierarchy = TaskService.projectHierarchy(scopedTasks);
    const newTasks = scopedTasks.filter(task => inPeriod(task.created_at, period));
    const completedTasks = scopedTasks.filter(task =>
        TaskService.isDirectlyCompleted(task) && inPeriod(taskCompletionAt(task), period)
    );
    const activeTasks = scopedTasks.filter(task => hierarchy.isActionableLeaf(task));
    const blockedTasks = activeTasks.filter(task => String(task.status) === "blocked");
    const overdueTasks = activeTasks.filter(task => Boolean(task.due_date && datePart(task.due_date) < period.end));

    const taskById = new Map(scopedTasks.map(task => [task.id, task]));
    const updates = (await store.listTaskUpdates())
        .filter((update: any) => update.source === "tapd" && inPeriod(update.created_at, period) && taskById.has(update.task_id));
    const taskChanges: WeeklyTaskChange[] = updates
        .map((update: any) => {
            const task = taskById.get(update.task_id)!;
            const changes = reportableTapdChanges(update.metadata?.changes);
            return {
                task_id: task.id,
                title: task.title,
                at: update.created_at,
                summary: changeSummary({ ...update.metadata, changes }),
                changes,
            };
        })
        .filter((change: WeeklyTaskChange) => Object.keys(change.changes).length > 0);
    const localStatusChanges: WeeklyTaskChange[] = updates
        .map((update: any) => {
            const status = update.metadata?.changes?.tapd_status;
            if (!status) return null;
            const task = taskById.get(update.task_id)!;
            return {
                task_id: task.id,
                title: task.title,
                at: update.created_at,
                summary: "TAPD 状态流转",
                changes: { tapd_status: status },
            } satisfies WeeklyTaskChange;
        })
        .filter((change: WeeklyTaskChange | null): change is WeeklyTaskChange => Boolean(change));
    const taskByStoryId = new Map(scopedTasks
        .filter(task => task.tapd_story_id)
        .map(task => [String(task.tapd_story_id), task]));
    const directStatusChanges: WeeklyTaskChange[] = (input.tapdStatusChanges || [])
        .map(change => {
            const task = taskByStoryId.get(String(change.story_id));
            if (!task) return null;
            return {
                task_id: task.id,
                title: task.title,
                at: change.at,
                summary: "TAPD 状态流转",
                changes: { tapd_status: { from: change.from, to: change.to } },
            } satisfies WeeklyTaskChange;
        })
        .filter((change: WeeklyTaskChange | null): change is WeeklyTaskChange => Boolean(change));
    taskChanges.push(...(input.tapdStatusHistoryAvailable === true ? directStatusChanges : localStatusChanges));
    taskChanges.sort((left: WeeklyTaskChange, right: WeeklyTaskChange) => right.at.localeCompare(left.at));

    const memberFacts: WeeklyMemberFacts[] = members.map((member: any) => {
        const standups = standupsByMember.get(member.open_id) || [];
        const owns = (task: Task) => taskOwners(task).has(member.open_id)
            || (task.trace?.tapd?.people_source === "tapd_names"
                && [task.primary_owner_name, ...(task.assignee_names || [])].includes(member.name));
        return {
            open_id: member.open_id,
            name: member.name,
            standup_submitted: standups.length,
            standup_expected: period.business_days.length,
            yesterday_done: distinct(standups.flatMap(standup => standup.yesterday_done || [])),
            today_plan: distinct(standups.flatMap(standup => standup.today_plan || [])),
            blockers: distinct(standups.flatMap(standup => standup.blockers || [])),
            risks: distinct(standups.flatMap(standup => standup.risks || [])),
            decisions_needed: distinct(standups.flatMap(standup => standup.decisions_needed || [])),
            active_tasks: activeTasks.filter(owns),
            new_tasks: newTasks.filter(owns),
            completed_tasks: completedTasks.filter(owns),
        };
    });

    const standupExpected = members.length * period.business_days.length;
    const standupSubmitted = standupDays.reduce((sum, day) => sum + day.submitted, 0);
    const warnings: string[] = [];
    if (period.is_partial) warnings.push("本周尚未结束，本报告仅统计到生成时刻。");
    if (period.kind === "last_week") warnings.push("进行中、阻塞和逾期任务采用生成时的 TAPD 当前状态；新增和完成按历史字段统计。");
    if (members.length === 0) warnings.push("当前群组没有启用成员，站会提交率无法计算。");
    if (input.tapdStatusHistoryAvailable === false) warnings.push("TAPD 状态历史未能获取，无法确认本周期是否存在未留存的状态流转。");

    return {
        schema_version: 1,
        group: { id: group.chat_id, name: group.name || group.chat_id },
        period,
        generated_at: new Date().toISOString(),
        tapd_synced_at: tapdSyncedAt,
        metrics: {
            active_members: members.length,
            standup_expected: standupExpected,
            standup_submitted: standupSubmitted,
            standup_rate: standupExpected ? Number((standupSubmitted / standupExpected).toFixed(4)) : 0,
            new_tasks: newTasks.length,
            completed_tasks: completedTasks.length,
            active_tasks: activeTasks.length,
            blocked_tasks: blockedTasks.length,
            overdue_tasks: overdueTasks.length,
        },
        standup_days: standupDays,
        members: memberFacts,
        new_tasks: newTasks,
        completed_tasks: completedTasks,
        active_tasks: activeTasks,
        blocked_tasks: blockedTasks,
        overdue_tasks: overdueTasks,
        task_changes: taskChanges,
        tapd_status_history_available: input.tapdStatusHistoryAvailable !== false,
        warnings,
    };
}
