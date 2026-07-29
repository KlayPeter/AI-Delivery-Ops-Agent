import { Standup, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';

export const STANDUP_KEYWORDS = ["昨日完成", "昨天完成", "昨日进展", "今日计划", "今天计划", "阻塞", "风险", "卡点", "需要决策"];

export function looksLikeStandup(text: string): boolean {
    if (text.includes("昨天") && text.includes("今天")) return true;

    let count = 0;
    for (const keyword of STANDUP_KEYWORDS) {
        if (text.includes(keyword)) {
            count++;
        }
    }
    return count >= 2;
}

export function parseStandup(openId: string, userName: string, text: string, messageId: string, today: Date = new Date()): Standup {
    const dateStr = dayjs(today).format('YYYY-MM-DD');
    let sections = parseStructuredSections(text);

    if (!sections.yesterday_done.length && !sections.today_plan.length && !sections.blockers.length && !sections.risks.length && !sections.decisions_needed.length) {
        sections = parseNaturalLanguage(text);
    }

    return {
        id: `standup-${dateStr}-${openId}`,
        open_id: openId,
        user_name: userName,
        date: dateStr,
        yesterday_done: sections.yesterday_done,
        today_plan: sections.today_plan,
        blockers: sections.blockers,
        risks: sections.risks,
        decisions_needed: sections.decisions_needed,
        submitted_at: utcNowIso(),
        source_message_id: messageId,
        raw_text: text,
    };
}

function parseStructuredSections(text: string): { yesterday_done: string[]; today_plan: string[]; blockers: string[]; risks: string[]; decisions_needed: string[]; } {
    const result = {
        yesterday_done: [] as string[],
        today_plan: [] as string[],
        blockers: [] as string[],
        risks: [] as string[],
        decisions_needed: [] as string[],
    };

    let currentKey: keyof typeof result | null = null;
    let currentLines: string[] = [];

    const flush = () => {
        if (!currentKey) return;
        const items = splitItems(currentLines.join("\n"));
        if (items.length) result[currentKey] = items;
        currentLines = [];
    };

    for (const line of text.split(/\r?\n/)) {
        const header = sectionKeyFromLine(line);
        if (header) {
            flush();
            currentKey = header;
            currentLines = [];
            continue;
        }
        if (currentKey) currentLines.push(line);
    }
    flush();

    return result;
}

function sectionKeyFromLine(line: string): "yesterday_done" | "today_plan" | "blockers" | "risks" | "decisions_needed" | null {
    const normalized = line.trim().replace(/^【/, "").replace(/】$/, "").replace(/[：:]$/, "");
    if (["昨日完成", "昨天完成", "昨日进展"].includes(normalized)) return "yesterday_done";
    if (["今日计划", "今天计划"].includes(normalized)) return "today_plan";
    if (["阻塞/需要帮助", "阻塞", "需要帮助", "卡点"].includes(normalized)) return "blockers";
    if (["风险/可能延期", "风险", "可能延期", "卡点/风险"].includes(normalized)) return "risks";
    if (["需要决策", "决策"].includes(normalized)) return "decisions_needed";
    return null;
}

function splitItems(value: string): string[] {
    const cleaned = value.trim();
    if (!cleaned || ["无", "暂无", "没有"].includes(cleaned)) return [];

    const parts = cleaned.split(/(?:\n+|\d+[.、)])/);
    return parts.map(part => part.replace(/^[\s\-，,。；;]+/, "").replace(/[\s\-，,。；;]+$/, "").trim())
                .filter(part => part && !["无", "暂无", "没有"].includes(part));
}

function parseNaturalLanguage(text: string): { yesterday_done: string[]; today_plan: string[]; blockers: string[]; risks: string[]; decisions_needed: string[]; } {
    const result: { yesterday_done: string[]; today_plan: string[]; blockers: string[]; risks: string[]; decisions_needed: string[]; } = {
        yesterday_done: [],
        today_plan: [],
        blockers: [],
        risks: [],
        decisions_needed: [],
    };

    const yesterday = text.match(/(?:昨天|昨日)(?:完成|进展)?(.+?)(?=今天|今日|现在|目前|暂无(?:阻塞|风险)|没有(?:阻塞|风险)|无(?:阻塞|风险)|$)/);
    if (yesterday) result.yesterday_done = [yesterday[1].replace(/^[ ，,。]+/, "").replace(/[ ，,。]+$/, "").trim()];

    const today = text.match(/(?:今天|今日)(?:计划|工作)?(.+?)(?=现在|目前|暂无(?:阻塞|风险)|没有(?:阻塞|风险)|无(?:阻塞|风险)|$)/);
    if (today) result.today_plan = [today[1].replace(/^[ ，,。]+/, "").replace(/[ ，,。]+$/, "").trim()];

    const noBlockers = /(?:暂无|没有|无)\s*(?:任何)?\s*(?:阻塞|卡点|需要帮助|帮助)|(?:暂无|没有|无)\s*(?:任何)?\s*(?:风险|延期)\s*(?:和|及|、|，|,)?\s*(?:阻塞|卡点|需要帮助|帮助)/.test(text);
    const noRisks = /(?:暂无|没有|无)\s*(?:任何)?\s*(?:风险|延期)|(?:暂无|没有|无)\s*(?:任何)?\s*(?:阻塞|卡点)\s*(?:和|及|、|，|,)?\s*(?:风险|延期)/.test(text);

    if (!noBlockers && ["卡住", "阻塞", "需要帮", "无法", "等待"].some(k => text.includes(k))) {
        result.blockers = [text.trim()];
    }

    if (!noRisks && ["风险", "延期", "来不及"].some(k => text.includes(k))) {
        result.risks = [text.trim()];
    }

    return result;
}
