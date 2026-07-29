import { describe, expect, test } from "bun:test";
import { buildDailySummary, renderDailySummary } from "@/services/summaries";

describe("daily summary task validity", () => {
    test("excludes deleted tasks and their progress updates", async () => {
        const store: any = {
            listSourceMessages: async (): Promise<any[]> => [],
            listTasks: async () => [
                {
                    id: "task-deleted",
                    title: "线上已删除任务",
                    status: "deleted",
                    source_group_id: "oc_target",
                    created_at: "2026-07-13T09:00:00+08:00",
                    updated_at: "2026-07-13T09:00:00+08:00",
                },
                {
                    id: "task-active",
                    title: "有效任务",
                    status: "in_progress",
                    source_group_id: "oc_target",
                    created_at: "2026-07-13T09:00:00+08:00",
                    updated_at: "2026-07-13T09:00:00+08:00",
                },
            ],
            listTaskUpdates: async () => [
                { id: "u-deleted", task_id: "task-deleted", update_type: "progress", content: "不应出现", created_at: "2026-07-13T10:00:00+08:00" },
                { id: "u-active", task_id: "task-active", update_type: "progress", content: "正常推进", created_at: "2026-07-13T10:00:00+08:00" },
            ],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-13T12:00:00+08:00"));

        expect(summary.tasks.map(item => item.title)).toEqual(["有效任务"]);
        expect(summary.progress_updates.map(item => item.content)).toEqual(["正常推进"]);
    });

    test("moves overdue task updates from progress into task risks", async () => {
        const store: any = {
            listSourceMessages: async (): Promise<any[]> => [],
            listTasks: async () => [{
                id: "task-overdue",
                title: "测试环境创建新手定段赛",
                status: "in_progress",
                source_group_id: "oc_target",
                created_at: "2026-07-14T09:00:00+08:00",
            }],
            listTaskUpdates: async () => [{
                id: "u-overdue",
                task_id: "task-overdue",
                update_type: "overdue_reminder",
                content: "任务已超期：2026-07-15",
                created_at: "2026-07-16T09:00:00+08:00",
            }],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"));
        const rendered = renderDailySummary(summary);

        expect(summary.progress_updates).toEqual([]);
        expect(summary.risks).toHaveLength(1);
        expect(summary.risks[0].title).toBe("测试环境创建新手定段赛");
        expect(rendered).toContain("任务风险");
        expect(rendered).toContain("测试环境创建新手定段赛");
        expect(rendered).not.toContain("任务进度与变更**\n1.");
    });
});

describe("daily summary message coverage", () => {
    test("groups parent and child tasks and excludes their creation command from group chat", async () => {
        const sourceMessage = {
            id: "m-task-command",
            chat_id: "oc_target",
            sender_name: "孙工程",
            text: "@AI 交付助理 创建一个任务，父任务为测试测试测试，子任务为测试1、测试2，负责人@赵产品",
            sent_at: "2026-07-15T10:00:00+08:00",
        };
        const store: any = {
            listSourceMessages: async () => [sourceMessage],
            listTasks: async () => [
                {
                    id: "task-parent",
                    tapd_story_id: "tapd-parent",
                    title: "测试测试测试",
                    primary_owner_name: "赵产品",
                    source_group_id: "oc_target",
                    source_message_id: sourceMessage.id,
                    created_at: "2026-07-15T10:01:00+08:00",
                },
                {
                    id: "task-child-1",
                    parent_id: "tapd-parent",
                    title: "测试1",
                    primary_owner_name: "赵产品",
                    source_group_id: "oc_target",
                    source_message_id: sourceMessage.id,
                    created_at: "2026-07-15T10:01:00+08:00",
                },
                {
                    id: "task-child-2",
                    parent_id: "tapd-parent",
                    title: "测试2",
                    primary_owner_name: "孙工程",
                    due_date: "2026-07-17",
                    source_group_id: "oc_target",
                    source_message_id: sourceMessage.id,
                    created_at: "2026-07-15T10:01:00+08:00",
                },
            ],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const rendered = renderDailySummary(await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00")));

        expect(rendered).toContain("**测试测试测试**（负责人：赵产品）");
        expect(rendered).toContain("- 测试1（负责人：赵产品）");
        expect(rendered).toContain("- 测试2（负责人：孙工程；截止：2026-07-17）");
        expect(rendered).not.toContain("【任务安排】");
        expect(rendered).not.toContain("@AI 交付助理");
    });

    test("filters casual chatter but keeps useful links in the chat section", async () => {
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-casual",
                    chat_id: "oc_target",
                    sender_open_id: "ou_a",
                    sender_name: "成员A",
                    text: "午饭大家准备吃什么",
                    sent_at: "2026-07-15T10:00:00+08:00",
                },
                {
                    id: "m-link",
                    chat_id: "oc_target",
                    sender_open_id: "ou_b",
                    sender_name: "成员B",
                    text: "Windows 使用 Codex 可以参考 https://learn.microsoft.com/powershell/install",
                    sent_at: "2026-07-15T11:00:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"));
        const rendered = renderDailySummary(summary);

        expect(summary.discusses).toEqual([]);
        expect(summary.shares.map(item => item.source_message_ids[0])).toEqual(["m-link"]);
        expect(summary.shares[0].urls).toEqual(["https://learn.microsoft.com/powershell/install"]);
        expect(rendered).toContain("第二部分：群聊天内容");
        expect(rendered).not.toContain("午饭大家准备吃什么");
        expect(rendered).toContain("https://learn.microsoft.com/powershell/install");
    });

    test("filters Feishu system placeholders before calling AI", async () => {
        const calls: any[] = [];
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-system-placeholder",
                    chat_id: "oc_target",
                    sender_open_id: "",
                    sender_name: "unknown",
                    text: '{"template":"{name} clipped content to top.","from_user":[],"to_chatters":[]}',
                    sent_at: "2026-07-15T09:00:00+08:00",
                },
                {
                    id: "m-system-invite",
                    chat_id: "oc_target",
                    sender_open_id: "",
                    sender_name: "unknown",
                    text: '{"template":"{from_user} invited {to_chatters} to the group. New members can view all chat history.","from_user":["陈项目"],"to_chatters":["测试机器人1"],"divider_text":{}}',
                    message_type: "text",
                    sent_at: "2026-07-15T09:05:00+08:00",
                },
                {
                    id: "m-summary-command",
                    chat_id: "oc_target",
                    sender_open_id: "ou_owner",
                    sender_name: "负责人",
                    text: "@AI 交付助理 今天的日报有吗",
                    message_type: "text",
                    sent_at: "2026-07-15T09:10:00+08:00",
                },
                {
                    id: "m-business",
                    chat_id: "oc_target",
                    sender_open_id: "ou_owner",
                    sender_name: "负责人",
                    text: "下周二统一评审并确认开发排期。",
                    sent_at: "2026-07-15T10:00:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };
        const llm: any = {
            chat: async (_system: string, user: string) => {
                calls.push(JSON.parse(user));
                return {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "下周二统一评审并确认开发排期。",
                        topics: [{ message_ids: ["m-business"], type: "meeting", title: "下周二统一评审并确认开发排期", confidence: 1 }],
                    }),
                };
            },
        };

        const rendered = renderDailySummary(await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm));

        expect(calls[0].messages.map((message: any) => message.id)).toEqual(["m-business"]);
        expect(rendered).not.toContain("clipped content to top");
        expect(rendered).not.toContain("invited");
        expect(rendered).not.toContain("测试机器人1");
        expect(rendered).not.toContain("unknown");
    });

    test("filters daily-summary AI runtime troubleshooting before calling AI", async () => {
        const calls: any[] = [];
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-ai-timeout",
                    chat_id: "oc_target",
                    sender_name: "成员A",
                    text: "@测试用户 应该是上下文限制有点短了，ai超时了，明天早上看一下，然后再重新总结一下",
                    sent_at: "2026-07-16T09:00:00+08:00",
                },
                {
                    id: "m-business-risk",
                    chat_id: "oc_target",
                    sender_name: "成员B",
                    text: "现有人力无法覆盖全部需求，需要确认优先级。",
                    sent_at: "2026-07-16T09:05:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };
        const llm: any = {
            chat: async (_system: string, user: string) => {
                calls.push(JSON.parse(user));
                return {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "当前需关注人力与需求优先级。",
                        topics: [{ message_ids: ["m-business-risk"], type: "risk", title: "人力不足，需确认需求优先级", confidence: 1 }],
                    }),
                };
            },
        };

        const rendered = renderDailySummary(await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"), llm));

        expect(calls[0].messages.map((message: any) => message.id)).toEqual(["m-business-risk"]);
        expect(rendered).toContain("人力不足，需确认需求优先级");
        expect(rendered).not.toContain("ai超时");
        expect(rendered).not.toContain("重新总结");
    });

    test("renders fallback discussions as group discussion instead of other group chat", async () => {
        const rendered = renderDailySummary({
            date: "2026-07-15",
            highlights: [],
            tasks: [],
            progress_updates: [],
            blockers: [],
            decisions: [],
            risks: [],
            helps: [],
            shares: [],
            meetings: [],
            discusses: [{ type: "discuss", sender_name: "负责人", title: "演示项目人力甘特图需求讨论" }],
        } as any);

        expect(rendered).toContain("【群内讨论】");
        expect(rendered).not.toContain("【其他群聊】");
    });

    test("does not expose internal status, risk, or sender values", () => {
        const rendered = renderDailySummary({
            date: "2026-07-15",
            highlights: [],
            tasks: [{ title: "日报展示修复", status: "development_completed", primary_owner_name: "" }],
            progress_updates: [{ title: "已处理展示问题", sender_name: "unknown" }],
            blockers: [],
            decisions: [],
            risks: [{ title: "测试风险", status: "testing", ai_result: { risk_level: "high" } }],
            helps: [],
            shares: [],
            meetings: [],
            discusses: [],
        } as any);

        expect(rendered).toContain("负责人：未指定");
        expect(rendered).toContain("当前状态：开发完成");
        expect(rendered).toContain("当前状态：测试中");
        expect(rendered).toContain("风险等级：高");
        expect(rendered).toContain("未知成员：已处理展示问题");
        expect(rendered).toContain("暂无资料或其他群内讨论");
        expect(rendered).not.toContain("development_completed");
        expect(rendered).not.toContain("unknown");
    });

    test("merges one standup's task progress and does not repeat its source chat message", async () => {
        const task = {
            id: "task-mail",
            title: "调研企业微信邮箱迁移至飞书",
            status: "in_progress",
            source_group_id: "oc_target",
            created_at: "2026-07-14T09:00:00+08:00",
        };
        const common = {
            task_id: task.id,
            user_open_id: "ou_owner",
            user_name: "陈项目",
            update_type: "progress",
            source: "standup",
            source_message_id: "m-standup",
            created_at: "2026-07-15T09:10:00+08:00",
            metadata: { standup_id: "standup-1" },
        };
        const store: any = {
            listSourceMessages: async () => [{
                id: "m-standup",
                chat_id: "oc_target",
                sender_open_id: "ou_owner",
                sender_name: "陈项目",
                text: "完成邮箱迁移调研，今天继续调研",
                sent_at: "2026-07-15T09:10:00+08:00",
            }],
            listTasks: async () => [task],
            listTaskUpdates: async () => [
                {
                    ...common,
                    id: "u-yesterday",
                    content: "任务：【调研企业微信邮箱迁移至飞书】昨日完成：进行企业微信邮箱迁移至飞书的调研",
                    metadata: { ...common.metadata, standup_section: "yesterday_done" },
                },
                {
                    ...common,
                    id: "u-today",
                    content: "任务：【调研企业微信邮箱迁移至飞书】今日计划：继续企业微信迁移至飞书的调研",
                    metadata: { ...common.metadata, standup_section: "today_plan" },
                },
            ],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"));
        const rendered = renderDailySummary(summary);

        expect(summary.progress_updates).toHaveLength(1);
        expect(summary.progress_updates[0].progress_details).toEqual([
            { label: "昨日完成", text: "进行企业微信邮箱迁移至飞书的调研" },
            { label: "今日计划", text: "继续企业微信迁移至飞书的调研" },
        ]);
        expect(summary.discusses).toEqual([]);
        expect(rendered.match(/陈项目｜/g)).toHaveLength(1);
        expect(rendered).toContain("昨日完成：进行企业微信邮箱迁移至飞书的调研");
        expect(rendered).toContain("今日计划：继续企业微信迁移至飞书的调研");
    });

    test("keeps relevant messages when AI omits one and preserves long multi-point content", async () => {
        const longText = "本期功能已经完成：1. 自动漏洞定位；2. session详情增加牌谱列表；3. 复式赛增加单手牌榜单；4. 自动漏洞定位优化；5. 三方牌谱上传并推送AI团队Kafka。";
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-release",
                    chat_id: "oc_target",
                    sender_open_id: "ou_a",
                    sender_name: "成员A",
                    text: longText,
                    sent_at: "2026-07-15T10:00:00+08:00",
                },
                {
                    id: "m-review",
                    chat_id: "oc_target",
                    sender_open_id: "ou_b",
                    sender_name: "成员B",
                    text: "各负责人先整理需求并输出简策划，下周二 review，再安排开发。",
                    sent_at: "2026-07-15T10:05:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            appendAuditLog: async (): Promise<void> => undefined,
        };
        const llm: any = {
            chat: async (system: string) => system.includes("群聊日报分类器")
                ? {
                    ok: true,
                    content: JSON.stringify({
                        items: [{
                            message_id: "m-release",
                            type: "progress",
                            title: longText,
                            confidence: 1,
                        }],
                    }),
                }
                : { ok: true, content: "本日完成版本功能并安排后续评审。" },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm);
        const rendered = renderDailySummary(summary);
        const coveredIds = [
            ...summary.discusses,
            ...summary.shares,
            ...summary.blockers,
            ...summary.decisions,
            ...summary.risks,
            ...summary.helps,
            ...summary.meetings,
        ].flatMap(item => item.source_message_ids || []);

        expect(coveredIds.sort()).toEqual(["m-release", "m-review"]);
        expect(rendered).toContain("5. 三方牌谱上传并推送AI团队Kafka");
        expect(rendered).toContain("下周二 review");
    });

    test("keeps non-blocker task changes in the task section", async () => {
        const store: any = {
            listSourceMessages: async () => [{
                id: "m-status",
                chat_id: "oc_target",
                sender_open_id: "ou_owner",
                sender_name: "负责人",
                text: "验收状态调整为待确认",
                sent_at: "2026-07-15T11:00:00+08:00",
            }],
            listTasks: async () => [{
                id: "task-1",
                title: "验收功能",
                status: "pending_confirmation",
                source_group_id: "oc_target",
                created_at: "2026-07-14T09:00:00+08:00",
            }],
            listTaskUpdates: async () => [{
                id: "u-status",
                task_id: "task-1",
                user_open_id: "ou_owner",
                user_name: "负责人",
                update_type: "status",
                content: "验收状态调整为待确认",
                source_message_id: "m-status",
                created_at: "2026-07-15T11:00:00+08:00",
            }],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"));

        expect(summary.progress_updates.map(item => item.content)).toEqual(["验收状态调整为待确认"]);
        expect(summary.discusses).toEqual([]);
    });

    test("groups chat into four sections and restores manager attention", async () => {
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-plan",
                    chat_id: "oc_target",
                    sender_open_id: "ou_a",
                    sender_name: "负责人A",
                    text: "接下来研发启动如下功能，负责人刘禹",
                    sent_at: "2026-07-15T10:00:00+08:00",
                },
                {
                    id: "m-collaboration",
                    chat_id: "oc_target",
                    sender_open_id: "ou_b",
                    sender_name: "负责人B",
                    text: "产品同学需要配合研发保持需求和方案对齐",
                    sent_at: "2026-07-15T10:05:00+08:00",
                },
                {
                    id: "m-capacity",
                    chat_id: "oc_target",
                    sender_open_id: "ou_b",
                    sender_name: "负责人B",
                    text: "现有人力及产能无法全部覆盖，需提前确认优先级",
                    sent_at: "2026-07-15T10:10:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"));
        const rendered = renderDailySummary(summary);

        expect(summary.discusses.map(item => item.type)).toContain("task_plan");
        expect(summary.discusses.map(item => item.type)).toContain("collaboration");
        expect(rendered).toContain("一、工作动态");
        expect(rendered).toContain("二、决策与排期");
        expect(rendered).toContain("三、风险与协作");
        expect(rendered).toContain("四、资料与其他");
        expect(rendered).toContain("需要管理者特别关注");
        expect(rendered).toContain("现有人力及产能无法全部覆盖，需提前确认优先级");
        expect(rendered).not.toContain("五、会议与通知");
    });

    test("falls back to rule classification when daily summary AI fails", async () => {
        const auditLogs: any[] = [];
        const store: any = {
            listSourceMessages: async () => [{
                id: "m-fallback",
                chat_id: "oc_target",
                sender_open_id: "ou_owner",
                sender_name: "负责人",
                text: "接下来安排研发负责人完成联调，下周二评审。",
                sent_at: "2026-07-15T11:00:00+08:00",
            }],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            appendAuditLog: async (eventType: string, detail: any): Promise<void> => {
                auditLogs.push({ eventType, detail });
            },
        };
        const llm: any = {
            chat: async (): Promise<any> => {
                throw new Error("LLM API Error (Gemini): AI request timed out after 15000ms");
            },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm);
        const rendered = renderDailySummary(summary);

        expect(summary.meetings.map(item => item.source_message_ids[0])).toEqual(["m-fallback"]);
        expect(rendered).toContain("接下来安排研发负责人完成联调，下周二评审");
        expect(auditLogs.some(item => item.eventType === "ai_daily_summary_failed" && item.detail.stage === "classification")).toBe(true);
    });

    test("recognizes decision and schedule details while ignoring acknowledgements", async () => {
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-schedule-1",
                    chat_id: "oc_target",
                    sender_open_id: "ou_a",
                    sender_name: "负责人A",
                    text: "周一完成需求文档并确定宣讲时间，下周二评审，下周三开始开发。",
                    sent_at: "2026-07-15T10:00:00+08:00",
                },
                {
                    id: "m-schedule-2",
                    chat_id: "oc_target",
                    sender_open_id: "ou_b",
                    sender_name: "负责人B",
                    text: "课程需求确认在下周二统一宣讲，开发周期随后排定。",
                    sent_at: "2026-07-15T10:05:00+08:00",
                },
                {
                    id: "m-ack",
                    chat_id: "oc_target",
                    sender_open_id: "ou_c",
                    sender_name: "成员C",
                    text: "好的",
                    sent_at: "2026-07-15T10:06:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"));
        const rendered = renderDailySummary(summary);

        const scheduledIds = [...summary.decisions, ...summary.meetings]
            .flatMap(item => item.source_message_ids || [])
            .sort();
        expect(scheduledIds).toEqual(["m-schedule-1", "m-schedule-2"]);
        expect(rendered).toContain("下周二评审");
        expect(rendered).toContain("下周三开始开发");
        expect(rendered).not.toContain("好的");
    });

    test("uses one AI result to merge related messages into a topic and summary", async () => {
        const calls: Array<{ system: string; user: string; options: any }> = [];
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-topic-1",
                    chat_id: "oc_target",
                    sender_open_id: "ou_a",
                    sender_name: "负责人A",
                    text: "需求文档周一完成。",
                    sent_at: "2026-07-15T10:00:00+08:00",
                },
                {
                    id: "m-topic-2",
                    chat_id: "oc_target",
                    sender_open_id: "ou_b",
                    sender_name: "负责人B",
                    text: "文档完成后下周二统一评审。",
                    sent_at: "2026-07-15T10:05:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            appendAuditLog: async (): Promise<void> => undefined,
        };
        const llm: any = {
            chat: async (system: string, user: string, options: any) => {
                calls.push({ system, user, options });
                return {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "需求文档计划周一完成，并在下周二统一评审后进入开发排期。",
                        topics: [{
                            message_ids: ["m-topic-1", "m-topic-2"],
                            type: "meeting",
                            title: "需求文档周一完成，下周二统一评审后进入开发排期",
                            confidence: 1,
                        }],
                    }),
                };
            },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm);

        expect(calls).toHaveLength(1);
        expect(calls[0].options).toEqual({ requestTimeoutMs: 30000, retryCount: 0 });
        expect(summary.meetings).toHaveLength(1);
        expect(summary.meetings[0].source_message_ids).toEqual(["m-topic-1", "m-topic-2"]);
        expect(summary.ai_abstract).toContain("下周二统一评审");
    });

    test("attaches an omitted short schedule reply to the existing AI topic", async () => {
        const store: any = {
            listSourceMessages: async () => [
                {
                    id: "m-schedule-main",
                    chat_id: "oc_target",
                    sender_name: "负责人A",
                    text: "需求本周完成，下周统一评审后开始开发。",
                    sent_at: "2026-07-16T10:00:00+08:00",
                },
                {
                    id: "m-schedule-reply",
                    chat_id: "oc_target",
                    sender_name: "负责人B",
                    text: "下周二评审的时候看把",
                    sent_at: "2026-07-16T10:05:00+08:00",
                },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };
        const llm: any = {
            chat: async () => ({
                ok: true,
                content: JSON.stringify({
                    abstract: "需求将在下周评审后启动开发。",
                    topics: [{
                        message_ids: ["m-schedule-main"],
                        type: "meeting",
                        title: "需求下周统一评审后启动开发",
                        confidence: 1,
                    }],
                }),
            }),
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"), llm);
        const rendered = renderDailySummary(summary);

        expect(summary.meetings).toHaveLength(1);
        expect(summary.meetings[0].source_message_ids).toEqual(["m-schedule-main", "m-schedule-reply"]);
        expect(rendered.match(/【会议通知】/g)).toHaveLength(1);
        expect(rendered).not.toContain("下周二评审的时候看把");
    });

    test("merges related AI schedule topics and rewrites verbatim business opinions", async () => {
        const executionOpinion = "我这边不布置超纲或超量的任务，但执行千万不要打折扣。参与需求推进应明确调研方向和产出，必要时调研范围可以阶段性缩减。";
        const uiOpinion = "涉及到UI的功能，把AI跑出来的图发我看一眼，避免视觉不达标，同时如果有余量可以支持美化。";
        const store: any = {
            listSourceMessages: async () => [
                { id: "m-meeting-main", chat_id: "oc_target", sender_name: "负责人A", text: "周一完成文档，下周二统一评审。", sent_at: "2026-07-16T10:00:00+08:00" },
                { id: "m-meeting-support", chat_id: "oc_target", sender_name: "负责人B", text: "具体分工做好协调，我周一可以支持。", sent_at: "2026-07-16T10:05:00+08:00" },
                { id: "m-execution", chat_id: "oc_target", sender_name: "负责人C", text: executionOpinion, sent_at: "2026-07-16T10:10:00+08:00" },
                { id: "m-ui", chat_id: "oc_target", sender_name: "负责人D", text: uiOpinion, sent_at: "2026-07-16T10:15:00+08:00" },
            ],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };
        const llm: any = {
            chat: async () => ({
                ok: true,
                content: JSON.stringify({
                    abstract: "下周进入评审，团队同步明确执行和UI质量要求。",
                    topics: [
                        { message_ids: ["m-meeting-main"], type: "meeting", title: "下周二统一进行需求评审", confidence: 1 },
                        { message_ids: ["m-meeting-support"], type: "meeting", title: "具体分工协调，周一提供支持", confidence: 1 },
                        { message_ids: ["m-execution"], type: "progress", title: executionOpinion, confidence: 1 },
                        { message_ids: ["m-ui"], type: "task_plan", title: uiOpinion, confidence: 1 },
                    ],
                }),
            }),
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"), llm);
        const rendered = renderDailySummary(summary);

        expect(summary.meetings).toHaveLength(1);
        expect(summary.meetings[0].source_message_ids).toEqual(["m-meeting-main", "m-meeting-support"]);
        expect(rendered).toContain("调研范围可阶段性收缩，但执行质量不能打折");
        expect(rendered).toContain("涉及UI的功能需先提供AI设计图确认");
        expect(rendered).not.toContain(executionOpinion);
        expect(rendered).not.toContain(uiOpinion);
    });

    test("keeps the end of long business messages", async () => {
        const prefix = "研发计划包含需求梳理、接口设计、联调测试和验收准备。".repeat(18);
        const tail = "最终还要完成第五项三方牌谱上传，并推送到AI团队Kafka。";
        const store: any = {
            listSourceMessages: async () => [{
                id: "m-long",
                chat_id: "oc_target",
                sender_open_id: "ou_owner",
                sender_name: "负责人",
                text: `${prefix}${tail}`,
                sent_at: "2026-07-15T11:00:00+08:00",
            }],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"));
        const rendered = renderDailySummary(summary);

        expect(rendered).toContain("最终还要完成第五项三方牌谱上传，并推送到AI团队Kafka");
        expect(summary.discusses[0].raw_text).toContain(tail);
        expect(summary.discusses[0].title.length).toBeLessThanOrEqual(180);
        expect(rendered.length).toBeLessThan(prefix.length + tail.length);
    });

    test("shows only the three most prominent manager concerns", async () => {
        const messages = [1, 2, 3, 4].map(index => ({
            id: `m-risk-${index}`,
            chat_id: "oc_target",
            sender_open_id: `ou_${index}`,
            sender_name: `负责人${index}`,
            text: `突出风险${index}：关键交付存在严重延期风险，需要管理者协调。`,
            sent_at: `2026-07-15T1${index}:00:00+08:00`,
        }));
        const store: any = {
            listSourceMessages: async () => messages,
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
        };
        const llm: any = {
            chat: async () => ({
                ok: true,
                content: JSON.stringify({
                    abstract: "当日存在四项交付风险，日报仅上提最突出的三项供管理者关注。",
                    topics: messages.map((message, index) => ({
                        message_ids: [message.id],
                        type: "risk",
                        title: `突出风险${index + 1}`,
                        manager_attention: true,
                        attention_reason: "关键交付严重延期",
                        confidence: 1,
                    })),
                }),
            }),
        };

        const rendered = renderDailySummary(await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm));
        const managerSection = rendered.split("**👀 需要管理者特别关注**")[1];

        expect(managerSection).toContain("突出风险1");
        expect(managerSection).toContain("突出风险2");
        expect(managerSection).toContain("突出风险3");
        expect(managerSection).not.toContain("突出风险4");
    });
});
