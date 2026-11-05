import type { WeeklyNarrative, WeeklyReportFacts } from "./types";
import { classifyAiFailure } from "@/platform/aiDegradation";

function textList(value: unknown, limit = 8): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => String(item || "").trim().slice(0, 240))
        .filter(Boolean)
        .slice(0, limit);
}

function fallbackNarrative(facts: WeeklyReportFacts): WeeklyNarrative {
    const { metrics } = facts;
    const highlights: string[] = [];
    if (metrics.completed_tasks) highlights.push(`本周完成 ${metrics.completed_tasks} 项任务。`);
    if (metrics.new_tasks) highlights.push(`本周新增 ${metrics.new_tasks} 项任务。`);
    if (!highlights.length) highlights.push("本周暂无可确认的新增或完成任务。");

    return {
        executive_summary: `本周共 ${metrics.active_members} 名成员参与，站会提交率 ${Math.round(metrics.standup_rate * 100)}%，当前有 ${metrics.active_tasks} 项进行中任务。`,
        highlights,
        risks: [
            ...facts.blocked_tasks.map(task => `阻塞：${task.title}`),
            ...facts.overdue_tasks.map(task => `逾期：${task.title}`),
            ...facts.members.flatMap(member => member.risks.map(risk => `${member.name}：${risk}`)),
        ].slice(0, 8),
        decisions_needed: facts.members
            .flatMap(member => member.decisions_needed.map(item => `${member.name}：${item}`))
            .slice(0, 8),
        next_week_focus: Array.from(new Set(
            facts.members.flatMap(member => member.today_plan.map(item => `${member.name}：${item}`))
        )).slice(0, 8),
        source: "deterministic",
    };
}

function parseJsonContent(content: string): any {
    const trimmed = content.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    return JSON.parse(trimmed);
}

export async function buildWeeklyNarrative(facts: WeeklyReportFacts, llm?: any): Promise<WeeklyNarrative> {
    const fallback = fallbackNarrative(facts);
    if (!llm || typeof llm.chat !== "function") return fallback;
    const degradedFallback = (error: unknown): WeeklyNarrative => {
        const failure = classifyAiFailure(error);
        return {
            ...fallback,
            ai_degraded: true,
            ai_failure_category: failure.category,
            ai_error: failure.error,
        };
    };

    const compactFacts = {
        group: facts.group,
        period: facts.period,
        metrics: facts.metrics,
        completed_tasks: facts.completed_tasks.slice(0, 30).map(task => ({ title: task.title, owner: task.primary_owner_name })),
        new_tasks: facts.new_tasks.slice(0, 30).map(task => ({ title: task.title, owner: task.primary_owner_name })),
        blocked_tasks: facts.blocked_tasks.slice(0, 20).map(task => ({ title: task.title, owner: task.primary_owner_name })),
        overdue_tasks: facts.overdue_tasks.slice(0, 20).map(task => ({ title: task.title, owner: task.primary_owner_name })),
        members: facts.members.map(member => ({
            name: member.name,
            done: member.yesterday_done.slice(0, 12),
            plan: member.today_plan.slice(0, 12),
            blockers: member.blockers.slice(0, 8),
            risks: member.risks.slice(0, 8),
            decisions: member.decisions_needed.slice(0, 8),
        })),
    };
    const system = `你是项目周报编辑。只能基于提供的事实进行归纳，不得新增数字、任务、人员或结论。
输出严格 JSON，不要 Markdown：
{"executive_summary":"不超过120字","highlights":["..."],"risks":["..."],"decisions_needed":["..."],"next_week_focus":["..."]}
每个数组最多8项；没有内容时返回空数组。`;

    try {
        const result = await llm.chat(system, JSON.stringify(compactFacts));
        if (!result?.ok || !result.content) return degradedFallback(result?.error || "empty_response");
        const parsed = parseJsonContent(result.content);
        const executiveSummary = String(parsed?.executive_summary || "").trim().slice(0, 400);
        if (!executiveSummary) return degradedFallback("invalid_response: missing executive_summary");
        return {
            executive_summary: executiveSummary,
            highlights: textList(parsed.highlights),
            risks: textList(parsed.risks),
            decisions_needed: textList(parsed.decisions_needed),
            next_week_focus: textList(parsed.next_week_focus),
            source: "llm",
        };
    } catch (error) {
        return degradedFallback(error);
    }
}
