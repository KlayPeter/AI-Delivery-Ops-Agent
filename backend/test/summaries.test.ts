import { describe, expect, test } from "bun:test";
import { buildDailySummary, renderDailySummary } from "@/services/summaries";

describe("daily summary task validity", () => {
    test("renders an unreported task standup commitment as incomplete", () => {
        const rendered = renderDailySummary({
            date: "2026-08-13",
            highlights: ["有待跟进事项"],
            tasks: [],
            progress_updates: [{
                update_type: "standup_unreported",
                task_title: "公众号文章初稿",
                title: "等待负责人汇报",
                content: "等待负责人汇报",
                sender_name: "机器人",
            }],
            blockers: [],
            decisions: [],
            risks: [],
            helps: [],
            shares: [],
            meetings: [],
            discusses: [],
        } as any);

        expect(rendered).toContain("未完成（未汇报）");
        expect(rendered).toContain("公众号文章初稿");
    });

    test("keeps only the latest task standup report for each commitment", async () => {
        const store: any = {
            listSourceMessages: async (): Promise<any[]> => [],
            listTasks: async () => [{
                id: "standup-commitment-1",
                title: "公众号文章初稿",
                status: "owner_marked_done",
                tags: ["standup_commitment"],
                source_group_id: "oc_target",
                created_at: "2026-08-12T08:00:00+08:00",
            }],
            listTaskUpdates: async () => [
                { id: "u-waiting", task_id: "standup-commitment-1", update_type: "standup_unreported", content: "等待负责人汇报", created_at: "2026-08-12T17:00:00+08:00", metadata: { standup_commitment: true } },
                { id: "u-done", task_id: "standup-commitment-1", update_type: "standup_completed", content: "已完成并交给设计排版", created_at: "2026-08-12T17:05:00+08:00", metadata: { standup_commitment: true } },
            ],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-08-12T18:30:00+08:00"));

        expect(summary.progress_updates.map(item => item.content)).toEqual(["已完成并交给设计排版"]);
    });

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
        expect(rendered).toContain("第二部分：群聊讨论归纳");
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
            chat: async (system: string, user: string) => {
                calls.push(JSON.parse(user));
                return system.includes("逐条语义分析器")
                    ? {
                        ok: true,
                        content: JSON.stringify({
                            analyses: [{
                                message_id: "m-business",
                                disposition: "business",
                                semantic_note: "团队计划下周二完成统一评审，并据此确认开发排期。",
                                topic_hint: "需求评审排期",
                                type: "meeting",
                                related_message_ids: [],
                                confidence: 1,
                            }],
                        }),
                    }
                    : {
                        ok: true,
                        content: JSON.stringify({
                            abstract: "团队将在下周二统一评审，并据此确认后续开发排期。",
                            topics: [{
                                message_ids: ["m-business"],
                                type: "meeting",
                                topic_title: "需求评审排期",
                                summary: "团队计划下周二完成统一评审，并在评审后确认开发排期。",
                                status: "in_progress",
                                confidence: 1,
                            }],
                        }),
                    };
            },
        };

        const rendered = renderDailySummary(await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm));

        expect(calls[0].target_messages.map((message: any) => message.id)).toEqual(["m-business"]);
        expect(rendered).not.toContain("clipped content to top");
        expect(rendered).not.toContain("invited");
        expect(rendered).not.toContain("测试机器人1");
        expect(rendered).not.toContain("unknown");
    });

    test("lets AI inspect human messages and excludes daily-summary runtime troubleshooting from the report", async () => {
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
            chat: async (system: string, user: string) => {
                calls.push(JSON.parse(user));
                return system.includes("逐条语义分析器")
                    ? {
                        ok: true,
                        content: JSON.stringify({
                            analyses: [
                                {
                                    message_id: "m-ai-timeout",
                                    disposition: "noise",
                                    semantic_note: "讨论日报机器人的上下文与超时问题，不属于项目业务进展。",
                                    topic_hint: "",
                                    type: "",
                                    related_message_ids: [],
                                    confidence: 1,
                                },
                                {
                                    message_id: "m-business-risk",
                                    disposition: "business",
                                    semantic_note: "现有人力无法覆盖全部需求，需要先明确优先级。",
                                    topic_hint: "人力与需求优先级",
                                    type: "risk",
                                    related_message_ids: [],
                                    confidence: 1,
                                },
                            ],
                        }),
                    }
                    : {
                        ok: true,
                        content: JSON.stringify({
                            abstract: "当前需优先处理人力覆盖与需求优先级问题。",
                            topics: [{
                                message_ids: ["m-business-risk"],
                                type: "risk",
                                topic_title: "人力与优先级",
                                summary: "现有产能无法同时覆盖全部需求，团队需要先确认交付优先级。",
                                status: "pending",
                                confidence: 1,
                            }],
                        }),
                    };
            },
        };

        const rendered = renderDailySummary(await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"), llm));

        expect(calls[0].target_messages.map((message: any) => message.id)).toEqual(["m-ai-timeout", "m-business-risk"]);
        expect(rendered).toContain("现有产能无法同时覆盖全部需求");
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

    test("recovers a business message omitted by synthesis without exposing raw chat text", async () => {
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
            chat: async (system: string) => system.includes("逐条语义分析器")
                ? {
                    ok: true,
                    content: JSON.stringify({
                        analyses: [
                            {
                                message_id: "m-release",
                                disposition: "business",
                                semantic_note: "本期交付覆盖漏洞定位、牌谱列表、榜单优化及三方牌谱推送等五项能力。",
                                topic_hint: "版本功能交付",
                                type: "progress",
                                related_message_ids: [],
                                confidence: 1,
                            },
                            {
                                message_id: "m-review",
                                disposition: "business",
                                semantic_note: "各负责人需先完成需求梳理和简版策划，并在下周二评审后安排开发。",
                                topic_hint: "需求评审与开发安排",
                                type: "meeting",
                                related_message_ids: [],
                                confidence: 1,
                            },
                        ],
                    }),
                }
                : {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "本日完成版本能力交付，并开始准备下一轮需求评审。",
                        topics: [{
                            message_ids: ["m-release"],
                            type: "progress",
                            topic_title: "版本功能交付",
                            summary: "本期已完成漏洞定位、牌谱列表、榜单优化及三方牌谱推送等五项能力。",
                            status: "resolved",
                            confidence: 1,
                        }],
                    }),
                },
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
        expect(rendered).toContain("漏洞定位、牌谱列表、榜单优化及三方牌谱推送");
        expect(rendered).toContain("各负责人需先完成需求梳理和简版策划");
        expect(rendered).not.toContain(longText);
        expect(rendered).not.toContain("各负责人先整理需求并输出简策划，下周二 review，再安排开发");
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
        expect(summary.ai_degraded).toBe(true);
        expect(rendered).toContain("内容未经过 AI 归纳");
        expect(rendered).toContain("规则归纳（AI 降级）");
        expect(rendered).not.toContain("**AI 总结：**");
        expect(rendered).toContain("接下来安排研发负责人完成联调，下周二评审");
        expect(auditLogs.some(item =>
            item.eventType === "ai_daily_summary_failed"
            && item.detail.stage === "message_analysis"
            && item.detail.category === "timeout"
            && item.detail.fallback === "deterministic_rule"
        )).toBe(true);
    });

    test("repairs missing JSON array closures without degrading the AI summary", async () => {
        const auditLogs: any[] = [];
        const store: any = {
            listSourceMessages: async () => [{
                id: "m-json-repair",
                chat_id: "oc_target",
                sender_open_id: "ou_owner",
                sender_name: "负责人",
                text: "团队下周二完成需求评审并确认开发排期。",
                sent_at: "2026-08-04T19:00:00+08:00",
            }],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            appendAuditLog: async (eventType: string, detail: any): Promise<void> => {
                auditLogs.push({ eventType, detail });
            },
        };
        const removeLastArrayClosure = (value: any): string => {
            const content = JSON.stringify(value);
            const index = content.lastIndexOf("]");
            return `${content.slice(0, index)}${content.slice(index + 1)}`;
        };
        const llm: any = {
            chat: async (system: string) => system.includes("逐条语义分析器")
                ? {
                    ok: true,
                    content: removeLastArrayClosure({
                        analyses: [{
                            message_id: "m-json-repair",
                            disposition: "business",
                            semantic_note: "团队计划下周二完成需求评审，并据此确认开发排期。",
                            topic_hint: "需求评审排期",
                            type: "meeting",
                            related_message_ids: [],
                            confidence: 1,
                        }],
                    }),
                }
                : {
                    ok: true,
                    content: removeLastArrayClosure({
                        abstract: "团队将在下周二完成需求评审，并确认后续开发排期。",
                        topics: [{
                            message_ids: ["m-json-repair"],
                            type: "meeting",
                            topic_title: "需求评审排期",
                            summary: "团队计划下周二完成需求评审，并在评审后确认开发排期。",
                            status: "in_progress",
                            confidence: 1,
                        }],
                    }),
                },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-08-04T20:00:00+08:00"), llm);

        expect(summary.ai_degraded).toBeUndefined();
        expect(summary.ai_abstract).toContain("下周二完成需求评审");
        expect(summary.meetings).toHaveLength(1);
        expect(auditLogs.filter(item => item.eventType === "ai_daily_summary_recovered")).toEqual([
            expect.objectContaining({ detail: expect.objectContaining({ stage: "message_analysis", recovery: "balanced_closures", retry_attempted: false }) }),
            expect.objectContaining({ detail: expect.objectContaining({ stage: "synthesis", recovery: "balanced_closures", retry_attempted: false }) }),
        ]);
        expect(auditLogs.some(item => item.eventType === "ai_daily_summary_failed")).toBe(false);
    });

    test("retries the same AI step when malformed JSON cannot be repaired locally", async () => {
        const auditLogs: any[] = [];
        let analysisCalls = 0;
        const store: any = {
            listSourceMessages: async () => [{
                id: "m-json-retry",
                chat_id: "oc_target",
                sender_name: "负责人",
                text: "本周完成接口联调。",
                sent_at: "2026-08-04T18:00:00+08:00",
            }],
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            appendAuditLog: async (eventType: string, detail: any): Promise<void> => {
                auditLogs.push({ eventType, detail });
            },
        };
        const llm: any = {
            chat: async (system: string) => {
                if (system.includes("逐条语义分析器")) {
                    analysisCalls++;
                    if (analysisCalls === 1) return { ok: true, content: '{"analyses":[{"message_id":"m-json-retry' };
                    return {
                        ok: true,
                        content: JSON.stringify({
                            analyses: [{
                                message_id: "m-json-retry",
                                disposition: "business",
                                semantic_note: "接口联调计划在本周完成。",
                                topic_hint: "接口联调",
                                type: "progress",
                                related_message_ids: [],
                                confidence: 1,
                            }],
                        }),
                    };
                }
                return {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "接口联调计划在本周完成。",
                        topics: [{
                            message_ids: ["m-json-retry"],
                            type: "progress",
                            topic_title: "接口联调",
                            summary: "团队计划在本周内完成接口联调。",
                            status: "in_progress",
                            confidence: 1,
                        }],
                    }),
                };
            },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-08-04T20:00:00+08:00"), llm);

        expect(analysisCalls).toBe(2);
        expect(summary.ai_degraded).toBeUndefined();
        expect(summary.discusses).toHaveLength(1);
        expect(auditLogs).toContainEqual(expect.objectContaining({
            eventType: "ai_daily_summary_recovered",
            detail: expect.objectContaining({ stage: "message_analysis", recovery: "model_retry", retry_attempted: true }),
        }));
        expect(auditLogs.some(item => item.eventType === "ai_daily_summary_failed")).toBe(false);
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

    test("uses message analysis and synthesis to merge related messages into one topic", async () => {
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
                return system.includes("逐条语义分析器")
                    ? {
                        ok: true,
                        content: JSON.stringify({
                            analyses: [
                                {
                                    message_id: "m-topic-1",
                                    disposition: "business",
                                    semantic_note: "需求文档计划在周一完成。",
                                    topic_hint: "需求评审安排",
                                    type: "task_plan",
                                    related_message_ids: ["m-topic-2"],
                                    confidence: 1,
                                },
                                {
                                    message_id: "m-topic-2",
                                    disposition: "business",
                                    semantic_note: "文档完成后将在下周二统一评审。",
                                    topic_hint: "需求评审安排",
                                    type: "meeting",
                                    related_message_ids: ["m-topic-1"],
                                    confidence: 1,
                                },
                            ],
                        }),
                    }
                    : {
                        ok: true,
                        content: JSON.stringify({
                            abstract: "需求文档计划周一完成，并在下周二统一评审后进入开发排期。",
                            topics: [{
                                message_ids: ["m-topic-1", "m-topic-2"],
                                type: "meeting",
                                topic_title: "需求评审安排",
                                summary: "团队计划周一完成需求文档，并在下周二统一评审后确定开发排期。",
                                status: "in_progress",
                                confidence: 1,
                            }],
                        }),
                    };
            },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-15T18:30:00+08:00"), llm);

        expect(calls).toHaveLength(2);
        expect(calls[0].options).toEqual({ requestTimeoutMs: 30000, retryCount: 0 });
        expect(calls[1].options).toEqual({ requestTimeoutMs: 30000, retryCount: 0 });
        expect(summary.meetings).toHaveLength(1);
        expect(summary.meetings[0].source_message_ids).toEqual(["m-topic-1", "m-topic-2"]);
        expect(summary.ai_abstract).toContain("下周二统一评审");
    });

    test("uses the reply context to attach a short schedule message to the existing topic", async () => {
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
            chat: async (system: string) => system.includes("逐条语义分析器")
                ? {
                    ok: true,
                    content: JSON.stringify({
                        analyses: [
                            {
                                message_id: "m-schedule-main",
                                disposition: "business",
                                semantic_note: "需求计划在下周统一评审后启动开发。",
                                topic_hint: "需求评审",
                                type: "meeting",
                                related_message_ids: ["m-schedule-reply"],
                                confidence: 1,
                            },
                            {
                                message_id: "m-schedule-reply",
                                disposition: "context",
                                semantic_note: "补充建议将评审时间明确为下周二。",
                                topic_hint: "需求评审",
                                type: "meeting",
                                related_message_ids: ["m-schedule-main"],
                                confidence: 1,
                            },
                        ],
                    }),
                }
                : {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "需求将在下周二评审后启动开发。",
                        topics: [{
                            message_ids: ["m-schedule-main", "m-schedule-reply"],
                            type: "meeting",
                            topic_title: "需求评审安排",
                            summary: "团队拟于下周二统一评审需求，并在评审通过后启动开发。",
                            status: "in_progress",
                            confidence: 1,
                        }],
                    }),
                },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"), llm);
        const rendered = renderDailySummary(summary);

        expect(summary.meetings).toHaveLength(1);
        expect(summary.meetings[0].source_message_ids).toEqual(["m-schedule-main", "m-schedule-reply"]);
        expect(rendered.match(/【会议通知｜推进中】/g)).toHaveLength(1);
        expect(rendered).not.toContain("下周二评审的时候看把");
    });

    test("reads every message in a reply chain and renders a rewritten discussion outcome", async () => {
        const originalQuestion = "现在遇到了上传牌谱，大小盲注不是2倍关系的情况。前段时间是不是有人提过这个问题，我们第三方AI处理接口目前只有一个传入大盲字段？";
        const detailedContext = "背景：需要转dataService的牌谱数据给前端做复盘，希望在后端统一handType里面加个sb字段。如果小盲和大盲不是2倍关系，复盘里面如果调用ai solver就会出现不支持的情况。最终问题：是不是不用加sb字段，直接提前拦截不符合规则的牌谱去复盘？";
        const messages = [
            { id: "m-card-1", chat_id: "oc_target", sender_name: "曾得龙", text: originalQuestion, sent_at: "2026-07-16T10:00:00+08:00" },
            { id: "m-card-2", chat_id: "oc_target", sender_name: "吴经理", text: "@全育涛 之前的测试结论是啥？", parent_id: "m-card-1", root_id: "m-card-1", sent_at: "2026-07-16T10:01:00+08:00" },
            { id: "m-card-3", chat_id: "oc_target", sender_name: "全育涛", text: "ai solver接口只支持提供大盲参数，DataService是支持的。", parent_id: "m-card-2", root_id: "m-card-1", sent_at: "2026-07-16T10:02:00+08:00" },
            { id: "m-card-4", chat_id: "oc_target", sender_name: "吴经理", text: "所以龙哥的问题是啥？", parent_id: "m-card-3", root_id: "m-card-1", sent_at: "2026-07-16T10:03:00+08:00" },
            { id: "m-card-5", chat_id: "oc_target", sender_name: "曾得龙", text: detailedContext, parent_id: "m-card-4", root_id: "m-card-1", sent_at: "2026-07-16T10:04:00+08:00" },
            { id: "m-card-6", chat_id: "oc_target", sender_name: "吴经理", text: "问题明白了。牌谱格式要加小盲字段，AI Solver接口要推动他们改。", parent_id: "m-card-5", root_id: "m-card-1", sent_at: "2026-07-16T10:05:00+08:00" },
        ];
        const calls: Array<{ system: string; payload: any }> = [];
        const store: any = {
            listSourceMessages: async () => messages,
            listTasks: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            appendAuditLog: async (): Promise<void> => undefined,
        };
        const llm: any = {
            chat: async (system: string, user: string) => {
                const payload = JSON.parse(user);
                calls.push({ system, payload });
                if (system.includes("逐条语义分析器")) {
                    return {
                        ok: true,
                        content: JSON.stringify({
                            analyses: [
                                { message_id: "m-card-1", disposition: "business", semantic_note: "曾得龙提出非标准大小盲比例的牌谱兼容问题，并询问第三方求解接口是否仅接收大盲参数。", topic_hint: "非标准盲注牌谱兼容", type: "discuss", related_message_ids: ["m-card-2"], confidence: 1 },
                                { message_id: "m-card-2", disposition: "context", semantic_note: "吴经理向全育涛追问此前测试结论。", topic_hint: "非标准盲注牌谱兼容", type: "discuss", related_message_ids: ["m-card-1", "m-card-3"], confidence: 1 },
                                { message_id: "m-card-3", disposition: "business", semantic_note: "全育涛确认 AI Solver 仅支持大盲参数，而 DataService 已具备相应数据支持。", topic_hint: "非标准盲注牌谱兼容", type: "discuss", related_message_ids: ["m-card-2"], confidence: 1 },
                                { message_id: "m-card-4", disposition: "context", semantic_note: "吴经理继续确认需要解决的具体边界。", topic_hint: "非标准盲注牌谱兼容", type: "discuss", related_message_ids: ["m-card-3", "m-card-5"], confidence: 1 },
                                { message_id: "m-card-5", disposition: "business", semantic_note: "问题发生在 DataService 牌谱进入前端复盘时；非标准盲注比例会导致 AI Solver 不兼容，需要在新增小盲字段与拦截牌谱之间选择方案。", topic_hint: "非标准盲注牌谱兼容", type: "discuss", related_message_ids: ["m-card-4", "m-card-6"], confidence: 1 },
                                { message_id: "m-card-6", disposition: "business", semantic_note: "讨论最终明确牌谱格式补充小盲字段，并推动 AI Solver 接口同步支持。", topic_hint: "非标准盲注牌谱兼容", type: "decision", related_message_ids: ["m-card-5"], confidence: 1 },
                            ],
                        }),
                    };
                }
                return {
                    ok: true,
                    content: JSON.stringify({
                        abstract: "团队围绕非标准大小盲比例的牌谱复盘兼容问题完成了接口边界确认，并形成数据格式与外部接口两侧同步调整的处理方向。",
                        topics: [{
                            message_ids: messages.map(message => message.id),
                            type: "decision",
                            topic_title: "非标准盲注牌谱兼容",
                            summary: "DataService 已能提供盲注数据，但 AI Solver 仅接收大盲参数，非标准比例牌谱因此无法稳定复盘；团队决定补充小盲字段，并推动求解接口同步适配。",
                            status: "resolved",
                            related_users: ["曾得龙", "吴经理", "全育涛"],
                            conclusions: ["牌谱格式需要增加小盲字段"],
                            next_actions: ["推动 AI Solver 接口支持小盲参数"],
                            open_questions: [],
                            confidence: 1,
                        }],
                    }),
                };
            },
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-16T18:30:00+08:00"), llm);
        const rendered = renderDailySummary(summary);

        expect(calls).toHaveLength(2);
        expect(calls[0].payload.target_messages.map((message: any) => message.id)).toEqual(messages.map(message => message.id));
        expect(calls[0].payload.target_messages[1].parent_id).toBe("m-card-1");
        expect(JSON.stringify(calls[1].payload)).not.toContain(originalQuestion);
        expect(JSON.stringify(calls[1].payload)).not.toContain(detailedContext);
        expect(summary.decisions).toHaveLength(1);
        expect(summary.decisions[0].source_message_ids).toEqual(messages.map(message => message.id));
        expect(rendered).toContain("【决策｜已形成结论】非标准盲注牌谱兼容");
        expect(rendered).toContain("讨论归纳：DataService 已能提供盲注数据");
        expect(rendered).toContain("已明确：牌谱格式需要增加小盲字段");
        expect(rendered).toContain("下一步：推动 AI Solver 接口支持小盲参数");
        expect(rendered).not.toContain(originalQuestion);
        expect(rendered).not.toContain(detailedContext);
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
