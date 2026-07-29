import type { Mention } from '@/models/types';
import dayjs from 'dayjs';

export const TASK_INTENT_KEYWORDS = [
    "创建任务", "创建需求", "新建任务", "新建需求", "建任务", "建个任务", "建一个任务",
    "创建子任务", "新建子任务", "建个子任务", "建一个子任务", "子任务：", "子任务:", "子任务",
    "安排一下", "麻烦处理", "请完成", "负责一下", "跟进一下", "做一下", "任务：", "任务:",
    "需求：", "需求:", "今天完成", "明天完成", "本周完成", "截止时间", "验收标准"
];

const TASK_OBJECT_KEYWORDS = ["任务", "需求", "事项", "问题", "Bug", "BUG", "bug", "缺陷", "工单", "TAPD", "Story", "story"];
const TASK_DELIVERY_ACTIONS = ["处理", "完成", "做完", "搞定", "推进", "跟进", "修复", "解决", "实现", "开发", "提测", "验收", "联调", "上线", "交付"];
const TASK_SCHEDULE_HINT = /(今天|今晚|明天|明晚|后天|本周|这周|下周|下下周|周[一二三四五六日天]|下周[一二三四五六日天]|截止|完成时间|交付时间|下班前|本月底|月底|本月)/;
const TASK_NEGATION = /(不要|不用|别|无需|先不).{0,8}(创建|新建|建|安排|处理|完成|跟进|任务|需求)|(创建|新建|建|安排|处理|完成|跟进|任务|需求).{0,8}(不要|不用|别|无需|先不)/;
const EXPLICIT_TASK_CREATION = /(创建|新建|建个|建一个|帮我建)\s*(?:一个)?\s*(任务|需求|子任务)/;

export const INDEPENDENT_KEYWORDS = ["每个人", "各自", "分别", "每人", "都要", "各写一份", "每个端", "各模块"];
export const WEEKDAY_NAMES: Record<string, number> = {
    "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6
};

export interface ParsedTaskCommand {
    should_create: boolean;
    reason: string;
    title: string;
    primary_owner: Mention | null;
    assignees: Mention[];
    priority: string;
    tapd_priority_label: string;
    due_date: string | null;
    acceptance_criteria: string[];
    description: string;
    is_independent: boolean;
    missing_primary_owner: boolean;
    is_subtask: boolean;
}

export function hasExplicitTaskCreationIntent(text: string): boolean {
    return !TASK_NEGATION.test(text) && EXPLICIT_TASK_CREATION.test(text);
}

export function hasTaskIntent(text: string): boolean {
    if (TASK_NEGATION.test(text)) return false;
    if (TASK_INTENT_KEYWORDS.some(keyword => text.includes(keyword))) return true;
    if (/(创建|新建|建|安排|帮我建).+(任务|需求|子任务)/.test(text)) return true;
    const hasObject = TASK_OBJECT_KEYWORDS.some(keyword => text.includes(keyword));
    const hasDeliveryAction = TASK_DELIVERY_ACTIONS.some(keyword => text.includes(keyword));
    const hasScheduleHint = TASK_SCHEDULE_HINT.test(text);
    if (hasDeliveryAction && (hasObject || hasScheduleHint)) return true;
    return false;
}

export function parseTaskCommand(
    text: string,
    mentions: Mention[],
    botOpenId: string,
    today: Date = new Date(),
    isPrivate: boolean = false
): ParsedTaskCommand {
    const botMentioned = mentions.some(m => m.open_id === botOpenId);
    const assignees = Array.from(new Map(
        mentions
            .filter(m => m.open_id !== botOpenId)
            .map(m => [m.open_id || `${m.name}:${m.key || ""}`, m] as const)
    ).values());

    if (!isPrivate && !botMentioned) {
        return { should_create: false, reason: "bot_not_mentioned", title: "", primary_owner: null, assignees: [], priority: "P2", tapd_priority_label: "Low", due_date: null, acceptance_criteria: [], description: "", is_independent: false, missing_primary_owner: false, is_subtask: false };
    }
    if (assignees.length === 0) {
        return { should_create: false, reason: "no_assignee_mentioned", title: "", primary_owner: null, assignees: [], priority: "P2", tapd_priority_label: "Low", due_date: null, acceptance_criteria: [], description: "", is_independent: false, missing_primary_owner: false, is_subtask: false };
    }
    if (!hasTaskIntent(text)) {
        return { should_create: false, reason: "no_task_intent", title: "", primary_owner: null, assignees, priority: "P2", tapd_priority_label: "Low", due_date: null, acceptance_criteria: [], description: "", is_independent: false, missing_primary_owner: false, is_subtask: false };
    }

    const title = extractTitle(text);
    if (!title) {
        return { should_create: false, reason: "missing_title", title: "", primary_owner: null, assignees, priority: "P2", tapd_priority_label: "Low", due_date: null, acceptance_criteria: [], description: "", is_independent: false, missing_primary_owner: false, is_subtask: false };
    }

    const { priority, tapdPriority } = extractPriority(text);
    const due = extractDueDate(text, today) || defaultDueDate(today);
    const acceptance = extractAcceptanceCriteria(text);
    const isIndependent = INDEPENDENT_KEYWORDS.some(k => text.includes(k));

    const primary = extractPrimaryOwner(text, assignees) || assignees[0];
    const missingPrimaryOwner = false;

    const descriptionParts: string[] = [];
    if (acceptance.length > 0) {
        descriptionParts.push("验收标准：" + acceptance.join("；"));
    }
    if (due) {
        descriptionParts.push(`截止时间：${due}`);
    }
    const description = descriptionParts.join("\n");

    return {
        should_create: true,
        reason: "ok",
        title,
        primary_owner: primary,
        assignees,
        priority,
        tapd_priority_label: tapdPriority,
        due_date: due,
        acceptance_criteria: acceptance,
        description,
        is_independent: isIndependent,
        missing_primary_owner: missingPrimaryOwner,
        is_subtask: text.includes("子任务")
    };
}

function extractTitle(text: string): string {
    const patterns = [
        /(?:创建任务|创建需求|新建任务|新建需求|任务|需求|创建子任务|新建子任务|子任务)\s*[:：]\s*(.+)/s,
        /(?:创建|新建|帮我建|建)[一个些]*.*?(?:测试任务|子任务|任务|需求)[，。,\s]+(.+)/s,
        /(?:创建|新建|帮我建|建)[一个些]*.*?(?:测试任务|子任务|任务|需求)\s*(.+)/s,
        /(?:安排一下|麻烦处理|请完成|负责一下|跟进一下|做一下)\s*(.+)/s,
        /(?:请|麻烦|辛苦|帮忙)?\s*(?:@\S+\s*)*(?:(?:今天|今晚|明天|明晚|后天|本周|这周|下周|下下周|周[一二三四五六日天]|下周[一二三四五六日天])(?:前|内)?\s*)?(?:把|将)?(.+?)(?:处理完|处理一下|处理|完成|做完|搞定|推进|跟进|修复|解决|实现|开发|提测|验收|联调|上线|交付)(?:[，。,；;\n]|$)/s,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match) {
            const value = cleanTitleValue(match[1]);
            if (value) return value;
        }
    }
    return "";
}

function cleanTitleValue(raw: string): string {
    let value = raw.trim();
    value = value.split(/(?:主责|主负责人|owner|截止时间|截止|交付时间|交付|优先级|验收标准|标准|要求)\s*[:：]?/i)[0].trim();
    value = value.replace(/^(?:@\S+\s*)+/, "");
    value = value.replace(/^(?:请|麻烦|辛苦|帮忙)\s*/, "");
    value = value.replace(/^(?:(?:今天|今晚|明天|明晚|后天|本周|这周|下周|下下周|周[一二三四五六日天]|下周[一二三四五六日天])(?:前|内)?\s*)+/, "");
    value = value.replace(/^(?:把|将)\s*/, "");
    value = value.replace(/(?:\s*@\S+)+$/, "");
    return value.replace(/^[ ，,。\n]+/, "").replace(/[ ，,。\n]+$/, "");
}

function extractPriority(text: string): { priority: string, tapdPriority: string } {
    const upper = text.toUpperCase();
    if (["P0", "紧急", "马上", "立刻", "高"].some(t => upper.includes(t))) return { priority: "P0", tapdPriority: "High" };
    if (["P1", "中", "一般"].some(t => upper.includes(t))) return { priority: "P1", tapdPriority: "Middle" };
    if (["P2", "低", "不急"].some(t => upper.includes(t))) return { priority: "P2", tapdPriority: "Low" };
    return { priority: "P2", tapdPriority: "Low" };
}

export function parseDueDateText(text: string, today: Date = new Date()): string | null {
    const dToday = dayjs(today);

    if (text.includes("今天") || text.includes("今晚")) return dToday.format('YYYY-MM-DD');
    if (text.includes("明天") || text.includes("明晚")) return dToday.add(1, 'day').format('YYYY-MM-DD');
    if (text.includes("后天")) return dToday.add(2, 'day').format('YYYY-MM-DD');

    const durationDays = extractDurationDays(text);
    if (durationDays !== null) return dToday.add(durationDays, 'day').format('YYYY-MM-DD');

    let match = text.match(/(?:(\d{4})[-年/])?(?:(1[0-2]|0?[1-9])[-月/])?(3[01]|[12][0-9]|0?[1-9])(?:日|号)/);
    if (match) {
        const yStr = match[1];
        const mStr = match[2];
        const dStr = match[3];
        const y = yStr ? parseInt(yStr) : dToday.year();
        const m = mStr ? parseInt(mStr) : dToday.month() + 1;
        const d = parseInt(dStr);
        const parsedDate = dayjs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        if (parsedDate.isValid()) return parsedDate.format('YYYY-MM-DD');
    }

    match = text.match(/(\d{4}-\d{1,2}-\d{1,2})/);
    if (match) {
        const parsedDate = dayjs(match[1]);
        if (parsedDate.isValid()) return parsedDate.format('YYYY-MM-DD');
    }

    const weekdayMatch = text.match(/(下下周|下周|本周|这周|周)([一二三四五六日天])/);
    if (weekdayMatch) {
        const prefix = weekdayMatch[1];
        const targetWeekday = WEEKDAY_NAMES[weekdayMatch[2]];
        let currentWeekday = dToday.day() - 1; // dayjs uses 0=Sun, 1=Mon
        if (currentWeekday === -1) currentWeekday = 6;

        let weeksAdd = 0;
        if (prefix === "下周") weeksAdd = 1;
        else if (prefix === "下下周") weeksAdd = 2;

        let days = targetWeekday - currentWeekday + 7 * weeksAdd;
        if (days < 0 && weeksAdd === 0) days += 7;

        return dToday.add(days, 'day').format('YYYY-MM-DD');
    }
    return null;
}

function extractDueDate(text: string, today: Date): string | null {
    return parseDueDateText(text, today);
}

function defaultDueDate(today: Date): string {
    return dayjs(today).add(1, 'day').format('YYYY-MM-DD');
}

function extractDurationDays(text: string): number | null {
    const normalized = normalizeChineseNumerals(text);
    const explicitMatch = normalized.match(/(?:耗时|工期|周期|时长|需要|预计|大概|大约)?\s*(\d+)\s*(?:个)?\s*(工作日|天|日|周|星期|礼拜)/);
    if (explicitMatch) {
        const amount = parseInt(explicitMatch[1], 10);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        const unit = explicitMatch[2];
        if (["周", "星期", "礼拜"].includes(unit)) return amount * 7;
        return amount;
    }

    if (/(?:半天|半日)/.test(text)) return 1;
    return null;
}

function normalizeChineseNumerals(text: string): string {
    return text
        .replace(/两/g, "2")
        .replace(/一/g, "1")
        .replace(/二/g, "2")
        .replace(/三/g, "3")
        .replace(/四/g, "4")
        .replace(/五/g, "5")
        .replace(/六/g, "6")
        .replace(/七/g, "7")
        .replace(/八/g, "8")
        .replace(/九/g, "9")
        .replace(/十/g, "10");
}

export function extractAcceptanceCriteria(text: string): string[] {
    const match = /(?:验收标准|验收|标准|要求)\s*(?:[:：]|是)\s*(.+)/s.exec(text);
    if (!match) return [];

    let raw = match[1].trim();
    raw = raw.split(/(?:优先级|截止时间|截止)\s*[:：]?/)[0];
    const values = raw.split(/[；;\n]/).map(i => i.trim().replace(/^[ ，,。；;]+/, "").replace(/[ ，,。；;]+$/, "")).filter(i => i);
    return values.slice(0, 5);
}

function extractPrimaryOwner(text: string, assignees: Mention[]): Mention | null {
    for (const assignee of assignees) {
        if (assignee.name) {
            const regex = new RegExp(`${escapeRegExp(assignee.name)}[^\\s]*\\s*(?:主责|主负责人|owner|来?负责|来?跟进)`, 'i');
            if (regex.test(text)) return assignee;
        }
    }
    const match = /主负责人\s*@?([^\s，,。]+)/.exec(text);
    if (match) {
        const name = match[1];
        for (const assignee of assignees) {
            if (assignee.name === name) return assignee;
        }
    }
    return null;
}

function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
