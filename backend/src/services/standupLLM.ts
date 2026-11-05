import { LLMAdapter } from '@/adapters/llm';
import { StandupService } from '@/services/standupService';

export async function buildTeamFocusWithLLM(
    llm: LLMAdapter,
    standups: any[],
): Promise<{ ok: boolean; focus?: string[]; error?: string }> {
    const summary = StandupService.buildSummaryView(standups);
    const payload = JSON.stringify(summary.people.map((person: any) => ({
        name: person.name,
        yesterday_done: person.yesterday_done,
        today_plan: person.today_plan,
    })));
    const prompt = (
        `你是研发团队助理，请根据以下 JSON 汇总团队工作重点。\n` +
        `只输出严格 JSON，格式为 {"focus":["主题：结论","主题：结论"]}，focus 最多 3 条。\n` +
        `每条聚合多个成员的相关工作，优先提炼共同主题、当前阶段和下一步，不要罗列人名，不要编造 JSON 未提供的事实。\n` +
        `每条控制在 80 个汉字以内；没有足够信息时返回 {"focus":[]}。`
    );
    try {
        const result = await llm.chat(prompt, payload);
        if (!result.ok || !result.content?.trim()) return { ok: false, error: result.error || "empty_response" };
        let content = result.content.trim();
        if (content.startsWith("```")) {
            content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        }
        const parsed = JSON.parse(content);
        const focus = Array.isArray(parsed) ? parsed : parsed?.focus;
        if (!Array.isArray(focus)) return { ok: false, error: "invalid_focus_shape" };
        const cleaned = focus
            .map((item: unknown) => String(item || "").replace(/[\r\n]+/g, "；").trim())
            .filter(Boolean)
            .slice(0, 3);
        return { ok: true, focus: cleaned };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function buildStandupSummaryWithLLM(
    llm: LLMAdapter,
    standups: any[],
    dateText: string,
    missingText: string
): Promise<{ ok: boolean, text?: string, error?: string }> {
    const summary = StandupService.buildSummaryView(standups);
    const payload = JSON.stringify(summary.people.map((person: any) => ({
        name: person.name,
        yesterday_done: person.yesterday_done,
        today_plan: person.today_plan,
        blockers: person.blockers,
        risks: person.risks,
        decisions_needed: person.decisions_needed,
    })));

    const prompt = (
        `你是研发团队助理，请根据以下 JSON 格式的成员站会提交记录，生成站会汇总报告。\n` +
        `输出需严格按照以下 Markdown 格式（纯文本，不要带有代码块 \`\`\` 标记，不要输出大标题）：\n\n` +
        `**🎯 一、团队重点概览**\n` +
        `1. （根据各项提交提炼 1-3 条核心重点）\n\n` +
        `**✅ 二、昨日完成**\n` +
        `（请保留每个人原本详细的汇报内容，不要过度删减精简。严格按【人名】单独分点列出各自完成的事项，绝对不要把不同人的任务合并归类在一起，保持独立清晰）\n` +
        `- **张三**：xxx\n` +
        `- **李四**：xxx\n\n` +
        `**📅 三、当日计划**\n` +
        `（同样保留原汁原味的详细内容，按【人名】单独分点列出）\n` +
        `- **张三**：xxx\n\n` +
        `**🚧 四、阻塞/需要帮助**\n` +
        `1. **[发起人姓名]**：xxx\n` +
        `   - 相关人：xxx\n` +
        `   - 建议动作：xxx\n\n` +
        `**⚠️ 五、风险/可能延期**\n` +
        `1. **[发起人姓名]**：xxx\n` +
        `   - 风险等级：高 / 中 / 低\n` +
        `   - 建议动作：xxx\n\n` +
        `**🤔 六、需要决策**\n` +
        `1. **[发起人姓名]**：xxx\n` +
        `   - 建议决策人：xxx\n\n` +
        `请保持格式完全一致，不要输出多余的Markdown代码块符号（如\`\`\`）。`
    );

    try {
        const res = await llm.chat(prompt, payload);
        if (res.ok && res.content.trim()) {
            let text = res.content.trim();
            if (text.startsWith("```")) {
                const lines = text.split("\n");
                if (lines.length > 2) text = lines.slice(1, -1).join("\n").trim();
            }
            text += `\n\n**👻 七、未提交情况**\n${missingText}`;
            return { ok: true, text };
        }
        return { ok: false, error: res.error || "empty_response" };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function buildFallbackStandupSummary(standups: any[], dateText: string, missingText: string): string {
    const summary = StandupService.buildSummaryView(standups);
    const lines = ["**🎯 一、团队重点概览**"];
    if (summary.team_focus.length) summary.team_focus.forEach((entry: any, index: number) => lines.push(`${index + 1}. **${entry.name}**：${entry.text}`));
    else lines.push("1. 暂无");
    lines.push("", "**✅ 二、昨日完成**");
    summary.people.forEach((person: any) => {
        if (person.yesterday_done.length) lines.push(`- **${person.name}**：${person.yesterday_done.join("；")}`);
    });
    lines.push("", "**📅 三、当日计划**");
    for (const person of summary.people) {
        lines.push(`- **${person.name}**：${person.today_plan.join('；') || '暂无'}`);
    }
    lines.push("", "**🚧 四、阻塞/需要帮助**");
    if (summary.blocker_entries.length) {
        summary.blocker_entries.forEach((entry: any, idx: number) => {
            lines.push(`${idx + 1}. **${entry.name}**：${entry.text}`, "   - 相关人：待确认", "   - 建议动作：待确认");
        });
    } else {
        lines.push("暂无。");
    }
    lines.push("", "**⚠️ 五、风险/可能延期**");
    if (summary.risk_entries.length) summary.risk_entries.forEach((entry: any, index: number) => lines.push(`${index + 1}. **${entry.name}**：${entry.text}`));
    else lines.push("暂无。");
    lines.push("", "**🤔 六、需要决策**");
    if (summary.decision_entries.length) summary.decision_entries.forEach((entry: any, index: number) => lines.push(`${index + 1}. **${entry.name}**：${entry.text}`));
    else lines.push("暂无。");
    lines.push("", "**👻 七、未提交情况**", missingText);
    return lines.join("\n");
}
