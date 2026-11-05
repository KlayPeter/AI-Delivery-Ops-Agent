import { describe, expect, test } from "bun:test";
import { buildDefaultTeamFocus, buildStandupCard } from "@/domains/standup/cardRenderer";
import { buildTeamFocusWithLLM } from "@/services/standupLLM";
import { ScheduledJobs } from "@/services/jobs";

const group = {
    chat_id: "oc_team",
    members: [
        { open_id: "ou_a", name: "张三", is_active: true },
        { open_id: "ou_b", name: "李四", is_active: true },
        { open_id: "ou_c", name: "王五", is_active: true },
    ],
};

const task = (overrides: any = {}) => ({
    id: "task-1",
    title: "视频库接口联调",
    creator_open_id: "ou_a",
    creator_name: "张三",
    primary_owner_open_id: "ou_a",
    primary_owner_name: "张三",
    assignee_open_ids: ["ou_a"],
    assignee_names: ["张三"],
    status: "in_progress",
    priority: "P1",
    source_message_id: "message-1",
    source_group_id: "oc_team",
    created_at: "2026-08-27T01:00:00Z",
    updated_at: "2026-08-27T01:00:00Z",
    tapd_story_id: "1112345678001001",
    tapd_url: "https://www.tapd.cn/12345678/prong/stories/view/1112345678001001",
    due_date: "2026-08-28",
    ...overrides,
});

function cardText(card: any): string {
    return JSON.stringify(card);
}

describe("standup card renderer", () => {
    test("uses equal metric columns and keeps progress separate from the five-day schedule", () => {
        const card: any = buildStandupCard([
            { open_id: "ou_a", user_name: "张三", yesterday_done: ["完成接口"], today_plan: ["继续联调"], blockers: [], risks: [], decisions_needed: [] },
            { open_id: "ou_b", user_name: "李四", yesterday_done: [], today_plan: ["补测试"], blockers: ["等待环境"], risks: [], decisions_needed: [] },
        ], group, [task()], "2026-08-27");

        expect(card.elements[0].tag).toBe("column_set");
        expect(card.elements[0].columns).toHaveLength(4);
        expect(card.elements[0].columns.map((item: any) => item.weight)).toEqual([1, 1, 1, 1]);
        expect(card.elements.some((item: any) => item.tag === "markdown" && String(item.content).includes("**🎯 一、团队重点概览**\n1. "))).toBe(true);
        expect(card.elements.some((item: any) => item.tag === "markdown" && String(item.content).includes("个人进展"))).toBe(true);
        expect(card.elements.some((item: any) => item.tag === "markdown" && String(item.content).includes("五日排期（工作日）"))).toBe(true);
        expect(cardText(card)).toContain("[视频库接口联调](https://www.tapd.cn/12345678/prong/stories/view/1112345678001001)");
        expect(card.elements[card.elements.length - 1].content).toContain("<at user_id=\"ou_c\">王五</at>");
        expect(cardText(card)).not.toContain("已超期");
    });

    test("generates five workdays and does not infer a schedule without TAPD dates", () => {
        const card: any = buildStandupCard([
            { open_id: "ou_c", user_name: "王五", yesterday_done: [], today_plan: [], blockers: [], risks: [], decisions_needed: [] },
        ], group, [task({
            id: "task-2",
            title: "无排期任务",
            primary_owner_open_id: "ou_c",
            primary_owner_name: "王五",
            assignee_open_ids: ["ou_c"],
            assignee_names: ["王五"],
            due_date: null,
            trace: { tapd: {} },
        })], "2026-08-28");

        const scheduleHeader = card.elements.find((item: any) => item.tag === "column_set" && String(item.columns?.[0]?.elements?.[0]?.content || "").startsWith("**成员**"));
        expect(scheduleHeader.columns.map((item: any) => String(item.elements[0].content).split("\n")[0])).toEqual([
            "**成员**", "**8/28**", "**8/31**", "**9/1**", "**9/2**", "**9/3**",
        ]);
        expect(cardText(card)).toContain("未排期");
    });

    test("keeps only TAPD tasks that overlap the five-workday window", () => {
        const card: any = buildStandupCard([
            { open_id: "ou_a", user_name: "张三", yesterday_done: [], today_plan: [], blockers: [], risks: [], decisions_needed: [] },
        ], group, [
            task({ id: "old-task", title: "已结束的旧任务", due_date: "2026-07-30" }),
            task({ id: "current-task", title: "本周任务", due_date: "2026-09-02" }),
        ], "2026-08-31");

        expect(cardText(card)).not.toContain("已结束的旧任务");
        expect(cardText(card)).toContain("本周任务");
    });

    test("groups the fallback team focus into numbered themes", () => {
        const focus = buildDefaultTeamFocus([
            { open_id: "ou_a", user_name: "张三", yesterday_done: ["Learn 节点联调"], today_plan: ["视频库需求转测"] },
            { open_id: "ou_b", user_name: "李四", yesterday_done: ["完善站内信 PRD"], today_plan: ["牌桌样式升级"] },
        ]);
        expect(focus).toHaveLength(3);
        expect(focus[0]).toContain("Learn 体系与视频库推进：");
        expect(focus[1]).toContain("核心 PRD 密集产出：");
        expect(focus[2]).toContain("牌桌体验与功能优化：");
    });

    test("accepts the old-style detailed overview returned by the model", async () => {
        const result = await buildTeamFocusWithLLM({
            chat: async () => ({ ok: true, content: '{"focus":["Learn 体系与视频库推进：进入联调和提测阶段","核心 PRD 密集产出：站内信与牌谱需求持续完善"]}' }),
        } as any, [{ open_id: "ou_a", user_name: "张三", yesterday_done: ["Learn 联调"], today_plan: ["站内信 PRD"] }]);
        expect(result).toEqual({ ok: true, focus: ["Learn 体系与视频库推进：进入联调和提测阶段", "核心 PRD 密集产出：站内信与牌谱需求持续完善"] });
    });

    test("routes the main standup summary through the fixed card sender", async () => {
        const sent: any[] = [];
        const jobs = new ScheduledJobs(
            { groups: [group], runtime: {}, schedule: {} } as any,
            {
                listStandups: async () => [{
                    open_id: "ou_a", user_name: "张三", source_group_id: "oc_team",
                    yesterday_done: ["完成接口"], today_plan: ["继续联调"], blockers: [], risks: [], decisions_needed: [],
                } as any],
                listTasks: async () => [task()],
                appendAuditLog: async () => {},
            } as any,
            {
                sendGroupCard: async (card: any) => { sent.push(card); return { ok: true, message_id: "om_card" }; },
            } as any,
            {} as any,
            {} as any,
        );

        await expect(jobs.standupSummary("oc_team", new Date("2026-08-27T00:00:00Z"))).resolves.toEqual({ submitted: 1, missing: 2 });
        expect(sent).toHaveLength(1);
        expect(sent[0].elements[0].columns).toHaveLength(4);
    });
});
