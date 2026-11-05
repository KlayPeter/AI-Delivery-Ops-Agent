import dayjs from "dayjs";
import type { Task } from "@/models/types";
import { StandupService } from "@/services/standupService";
import { TaskService } from "@/services/taskService";
import { isActiveTask, taskReminderGroupId } from "@/services/taskScope";

type CardElement = Record<string, unknown>;

const STATUS_LABELS: Record<string, string> = {
    pending_primary_owner: "待负责人确认",
    pending_confirmation: "待确认",
    requirement: "需求阶段",
    confirmed: "已确认",
    in_progress: "开发中",
    blocked: "已阻塞",
    development_completed: "开发完成·待转测",
    owner_marked_done: "已转测试·待测试",
    testing: "测试中",
};

function markdown(content: string): CardElement {
    return { tag: "markdown", content };
}

function column(content: string, weight: number = 1): CardElement {
    return {
        tag: "column",
        width: "weighted",
        weight,
        elements: [markdown(content)],
    };
}

function columnSet(contents: string[], weights?: number[]): CardElement {
    return {
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "small",
        columns: contents.map((content, index) => column(content, weights?.[index] || 1)),
    };
}

function cleanText(value: unknown, fallback = "无"): string {
    const text = String(value ?? "").replace(/[\r\n]+/g, "；").trim();
    return text || fallback;
}

function listText(items: unknown[], fallback = "无"): string {
    const values = (items || []).map(item => cleanText(item)).filter(Boolean);
    return values.length ? values.map((item, index) => `${index + 1}. ${item}`).join("\n") : fallback;
}

function dateOnly(value: unknown): string {
    const raw = String(value || "").trim();
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
    if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const parsed = dayjs(raw);
    return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
}

function shortDate(value: string): string {
    const match = /^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/.exec(value);
    return match ? `${Number(match[1])}/${Number(match[2])}` : value;
}

function workdays(startDate: string, count: number): string[] {
    const start = dayjs(startDate);
    if (!start.isValid()) return [];
    const result: string[] = [];
    let cursor = start.startOf("day");
    while (result.length < count) {
        const day = cursor.day();
        if (day !== 0 && day !== 6) result.push(cursor.format("YYYY-MM-DD"));
        cursor = cursor.add(1, "day");
    }
    return result;
}

function taskDates(task: Task): { begin: string; due: string } {
    const tapd = task.trace?.tapd || {};
    return {
        begin: dateOnly(tapd.begin_date || tapd.start_date),
        due: dateOnly(task.due_date || tapd.due_date || tapd.end_date),
    };
}

function taskStatus(task: Task): string {
    const status = String(task.status || "").trim();
    if (status === "overdue") {
        const tapdStatus = String(task.trace?.tapd?.status || "").trim();
        return STATUS_LABELS[tapdStatus] || "开发中";
    }
    return STATUS_LABELS[status] || (status ? "状态未映射" : "状态未映射");
}

function taskSchedule(task: Task): string {
    const { begin, due } = taskDates(task);
    if (begin && due && begin !== due) return `排期 ${shortDate(begin)}–${shortDate(due)}`;
    if (due) return `截止 ${shortDate(due)}`;
    if (begin) return `开始 ${shortDate(begin)}`;
    return "未排期";
}

function taskInWindow(task: Task, firstDay: string, lastDay: string): boolean {
    const { begin, due } = taskDates(task);
    if (due && due < firstDay) return false;
    if (begin && begin > lastDay) return false;
    return true;
}

function taskMatchesPerson(task: Task, person: any): boolean {
    const ids = [task.primary_owner_open_id, ...(task.assignee_open_ids || [])].filter(Boolean);
    const names = [task.primary_owner_name, ...(task.assignee_names || [])].filter(Boolean);
    return (!!person.open_id && ids.includes(person.open_id)) || (!!person.name && names.includes(person.name));
}

function taskIsForGroup(task: Task, group: any): boolean {
    return task.source_group_id === group.chat_id
        || taskReminderGroupId(task, [group]) === group.chat_id;
}

function taskLine(task: Task): string {
    const title = cleanText(task.title, "未命名任务").replace(/\]/g, "\\]");
    const linkedTitle = task.tapd_url && /^https:\/\//i.test(task.tapd_url)
        ? `[${title}](${task.tapd_url})`
        : title;
    return `${linkedTitle}｜${taskStatus(task)}｜${taskSchedule(task)}`;
}

function missingMemberText(standups: any[], group: any): string {
    const submittedIds = new Set(standups.map(standup => standup.open_id).filter(Boolean));
    const missing = (group.members || []).filter((member: any) => member.is_active !== false && !submittedIds.has(member.open_id));
    if (!missing.length) return "无";
    return missing.map((member: any) => {
        const name = cleanText(member.name, "未命名成员");
        return member.open_id ? `<at user_id="${member.open_id}">${name}</at>` : name;
    }).join("、");
}

function personBlock(person: any, tasks: Task[]): string {
    const yesterday = listText(person.yesterday_done || []);
    const today = listText(person.today_plan || []);
    const taskLines = tasks.length
        ? tasks.map((task, index) => `${index + 1}. ${taskLine(task)}`).join("\n")
        : "无";
    return [
        `**${cleanText(person.name, "未知成员")}**`,
        "**昨日完成**",
        yesterday,
        "",
        "**今日计划**",
        today,
        "",
        "**还未完成 TAPD**",
        taskLines,
    ].join("\n");
}

function taskScheduledOn(task: Task, day: string, firstDay: string): boolean {
    const { begin, due } = taskDates(task);
    if (!begin && !due) return false;
    if (due && due < firstDay) return false;
    if (begin && day < begin) return false;
    if (due && day > due) return false;
    return true;
}

const FOCUS_THEMES = [
    { title: "Learn 体系与视频库推进", keywords: ["learn", "视频", "课程", "节点", "视频库"] },
    { title: "核心 PRD 密集产出", keywords: ["prd", "需求", "站内信", "drill", "牌谱", "新用户"] },
    { title: "牌桌体验与功能优化", keywords: ["牌桌", "hero", "底牌", "动画", "样式", "操作区域"] },
    { title: "系统优化与部署", keywords: ["部署", "登录", "晋级", "接口", "flutter", "app"] },
];

function clip(value: string, max = 90): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function buildDefaultTeamFocus(standups: any[], tasks: Task[] = []): string[] {
    const summary = StandupService.buildSummaryView(standups);
    const sources = Array.from(new Set([
        ...summary.people.flatMap((person: any) => [
            ...(person.yesterday_done || []),
            ...(person.today_plan || []),
        ]),
        ...tasks.map(task => task.title),
    ].map(item => cleanText(item, "")).filter(Boolean)));

    const ranked = FOCUS_THEMES.map((theme, index) => {
        const matched = sources.filter(source => theme.keywords.some(keyword => source.toLowerCase().includes(keyword)));
        return { theme, matched, index };
    })
        .filter(item => item.matched.length)
        .sort((left, right) => right.matched.length - left.matched.length || left.index - right.index)
        .slice(0, 3);

    if (ranked.length) {
        return ranked.map(item => `${item.theme.title}：${clip(item.matched.slice(0, 3).join("、"))}`);
    }
    return sources.length ? [`团队工作推进：${clip(sources.slice(0, 3).join("、"))}`] : ["暂无"];
}

function scheduleTable(people: any[], tasks: Task[], days: string[]): CardElement {
    const firstDay = days[0] || "";
    const names = ["**成员**", ...people.map(person => cleanText(person.name, "未知成员"))];
    const dateColumns = days.map(day => [
        `**${shortDate(day)}**`,
        ...people.map(person => {
            const personTasks = tasks.filter(task => taskMatchesPerson(task, person));
            return personTasks.some(task => taskScheduledOn(task, day, firstDay)) ? "■" : "·";
        }),
    ]);
    return columnSet(
        [names.join("\n"), ...dateColumns.map(lines => lines.join("\n"))],
        [2, 1, 1, 1, 1, 1],
    );
}

export function buildStandupCard(standups: any[], group: any, tasks: Task[], dateText: string, teamFocus: string[] = []): Record<string, unknown> {
    const summary = StandupService.buildSummaryView(standups, group.members || []);
    const days = workdays(dateText, 5);
    const firstDay = days[0] || dateText;
    const lastDay = days[days.length - 1] || firstDay;
    const hierarchy = TaskService.projectHierarchy(tasks || []);
    const groupTasks = (tasks || [])
        .filter(task => isActiveTask(task))
        .filter(task => task.tapd_story_id && taskIsForGroup(task, group))
        .filter(task => hierarchy.isActionableLeaf(task))
        .filter(task => taskInWindow(task, firstDay, lastDay))
        .sort((left, right) => String(left.due_date || "9999").localeCompare(String(right.due_date || "9999")) || left.title.localeCompare(right.title));
    const focus = teamFocus.length ? teamFocus : buildDefaultTeamFocus(standups, groupTasks);
    const elements: CardElement[] = [
        columnSet([
            `**${summary.submitted}**\n已提交`,
            `**${summary.missing}**\n未提交`,
            `**${summary.blocker_entries.length}**\n阻塞`,
            `**${summary.risk_entries.length}**\n风险`,
        ]),
        { tag: "hr" },
        markdown("**🎯 一、团队重点概览**\n" + focus.map((item, index) => `${index + 1}. ${item}`).join("\n")),
        { tag: "hr" },
        markdown("**📝 个人进展**"),
    ];

    const people = summary.people;
    for (let index = 0; index < people.length; index += 2) {
        const left = people[index];
        const right = people[index + 1];
        elements.push(columnSet([
            personBlock(left, groupTasks.filter(task => taskMatchesPerson(task, left))),
            right ? personBlock(right, groupTasks.filter(task => taskMatchesPerson(task, right))) : "",
        ], [1, 1]));
    }

    elements.push({ tag: "hr" }, markdown("**📅 五日排期（工作日）**\n■ = 当天有排期或仍未完成　· = 无明确排期"));
    if (days.length) {
        elements.push(scheduleTable(people, groupTasks, days));
    } else {
        elements.push(markdown("暂无排期"));
    }
    elements.push({ tag: "hr" }, markdown(`**👻 未提交（${summary.missing}）**\n${missingMemberText(standups, group)}`));

    return {
        config: { wide_screen_mode: true },
        elements,
    };
}
