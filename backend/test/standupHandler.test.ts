import { describe, expect, test } from "bun:test";
import { StandupHandler } from "@/services/messageHandler/handlers/StandupHandler";
import { ContextRouter } from "@/services/messageHandler/ContextRouter";
import { MessageRouter } from "@/services/messageHandler/MessageRouter";
import { parseStandup } from "@/services/standup";

describe("natural-language standup parsing", () => {
    test("should not treat no blockers and risks as actual issues", () => {
        const standup = parseStandup(
            "ou_user",
            "何钰如",
            "昨日完成产品和业务理解，今日计划做竞品调研，暂无阻塞和风险",
            "om_reply",
            new Date("2026-07-16T00:00:00Z"),
        );

        expect(standup.yesterday_done).toEqual(["产品和业务理解"]);
        expect(standup.today_plan).toEqual(["做竞品调研"]);
        expect(standup.blockers).toEqual([]);
        expect(standup.risks).toEqual([]);
    });
});

describe("StandupHandler", () => {
    test("should register a group task standup commitment without creating TAPD work", async () => {
        let savedTask: any = null;
        const updates: any[] = [];
        const replies: string[] = [];
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot" },
                groups: [{ chat_id: "oc_content", name: "内容组", members: [], schedule: { module_standup_enabled: true, task_standup_enabled: true } }],
            },
            store: {
                saveSourceMessage: async () => {},
                saveTask: async (task: any) => { savedTask = task; },
                listTaskUpdates: async (): Promise<any[]> => [],
                getSourceMessage: async (): Promise<any> => null,
                saveTaskUpdate: async (update: any) => updates.push(update),
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => { replies.push(text); return { ok: true, message_id: "om_receipt" }; },
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_commitment",
            chat_id: "oc_content",
            chat_type: "group",
            sender_open_id: "ou_owner",
            sender_name: "李康",
            text: "@机器人 今天17点交付任务 公众号文章初稿",
            sent_at: "2026-08-12T01:00:00Z",
            mentions: [{ open_id: "ou_bot", name: "机器人", key: "@_user_1" }],
        } as any, "group", null);

        expect(result.action).toBe("standup_commitment_created");
        expect(savedTask).toMatchObject({
            title: "公众号文章初稿",
            primary_owner_open_id: "ou_owner",
            status: "in_progress",
            tapd_story_id: null,
            tags: ["standup_commitment"],
        });
        expect(updates[0]).toMatchObject({ update_type: "standup_committed", metadata: { standup_commitment: true } });
        expect(replies[0]).toContain("到时间后我会在本群提醒负责人汇报");
    });

    test("should keep explicit TAPD creation outside task standup routing", async () => {
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot" },
                groups: [{ chat_id: "oc_content", schedule: { module_standup_enabled: true, task_standup_enabled: true } }],
            },
        };
        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_tapd",
            chat_id: "oc_content",
            sender_open_id: "ou_owner",
            sender_name: "李康",
            text: "@机器人 创建TAPD任务：今天17点完成公众号审核功能",
            sent_at: "2026-08-12T01:00:00Z",
            mentions: [{ open_id: "ou_bot", name: "机器人" }],
        } as any, "group", null);

        expect(result).toBe(null);
    });

    test("should update the quoted commitment from a natural-language owner report", async () => {
        let savedTask: any = null;
        const updates: any[] = [];
        const task = {
            id: "standup-commitment-1",
            title: "公众号文章初稿",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "李康",
            status: "in_progress",
            tags: ["standup_commitment"],
        };
        const ctx: any = {
            store: {
                getTask: async () => task,
                saveTask: async (value: any) => { savedTask = value; },
                listTaskUpdates: async (): Promise<any[]> => [],
                getSourceMessage: async (): Promise<any> => null,
                saveTaskUpdate: async (update: any) => updates.push(update),
                appendAuditLog: async () => 1,
            },
            feishu: { sendReplyText: async () => ({ ok: true }) },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_report",
            chat_id: "oc_content",
            sender_open_id: "ou_owner",
            sender_name: "李康",
            text: "已经完成了，发给设计排版了",
            sent_at: "2026-08-12T09:05:00Z",
        } as any, "group", { context_type: "standup_commitment_prompt", task_id: task.id });

        expect(result).toMatchObject({ action: "standup_commitment_reported", status: "completed" });
        expect(savedTask.status).toBe("owner_marked_done");
        expect(updates[0]).toMatchObject({ update_type: "standup_completed", metadata: { standup_commitment: true, report_status: "completed" } });
    });

    test("should require mentioning the bot again when quoting the task standup template", async () => {
        let savedTask: any = null;
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot" },
                groups: [{ chat_id: "oc_content", schedule: { module_standup_enabled: true, task_standup_enabled: true } }],
            },
            store: {
                saveSourceMessage: async () => {},
                saveTask: async (task: any) => { savedTask = task; },
                listTaskUpdates: async (): Promise<any[]> => [],
                getSourceMessage: async (): Promise<any> => null,
                saveTaskUpdate: async () => {},
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendReplyText: async () => ({ ok: true, message_id: "om_receipt" }),
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_template_reply",
            chat_id: "oc_content",
            chat_type: "group",
            sender_open_id: "ou_creator",
            sender_name: "王五",
            text: "@机器人 任务：公众号文章初稿\n负责人：@李康\n交付时间：今天17点",
            sent_at: "2026-08-13T01:00:00Z",
            mentions: [{ open_id: "ou_bot", name: "机器人" }, { open_id: "ou_owner", name: "李康" }],
        } as any, "group", { context_type: "task_standup_template" });

        expect(result).toMatchObject({ action: "standup_commitment_created" });
        expect(savedTask).toMatchObject({
            title: "公众号文章初稿",
            primary_owner_open_id: "ou_owner",
        });
    });

    test("should remind the mentioned owner when the quoted report sender is different", async () => {
        const replies: string[] = [];
        const updates: any[] = [];
        const task = {
            id: "standup-commitment-mention-mismatch",
            title: "公众号文章初稿",
            source_group_id: "oc_content",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "李康",
            status: "in_progress",
            tags: ["standup_commitment"],
        };
        const ctx: any = {
            config: { feishu: { bot_open_id: "ou_bot" } },
            store: {
                getTask: async () => task,
                saveTask: async () => { throw new Error("should not update task"); },
                saveTaskUpdate: async (update: any) => updates.push(update),
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => { replies.push(text); return { ok: true }; },
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_report_mismatch",
            chat_id: "oc_content",
            sender_open_id: "ou_other",
            sender_name: "王五",
            text: "@李康 已完成",
            mentions: [{ open_id: "ou_owner", name: "李康" }],
            sent_at: "2026-08-13T09:05:00Z",
        } as any, "group", { context_type: "standup_commitment_prompt", task_id: task.id });

        expect(result).toMatchObject({ action: "standup_commitment_report_rejected", reason: "mentioned_owner_mismatch" });
        expect(replies[0]).toContain("李康");
        expect(replies[0]).toContain("本人");
        expect(updates).toHaveLength(0);
    });

    test("should save standup with prompt group id for group-scoped statistics", async () => {
        let savedStandup: any = null;
        const auditLogs: any[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listTasks: async (): Promise<any[]> => [],
                appendAuditLog: async (eventType: string, payload: any): Promise<number> => auditLogs.push({ eventType, payload }),
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true }),
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "陈项目",
            text: "昨天完成了需求1，今天要完成需求2",
            sent_at: "2026-07-07T01:37:25Z",
        } as any, "private", {
            context_type: "standup_prompt",
            metadata: { date: "2026-07-07", group_id: "oc_demo_dev" },
        });

        expect(result.handled).toBe(true);
        expect(savedStandup.date).toBe("2026-07-07");
        expect(savedStandup.source_group_id).toBe("oc_demo_dev");
        expect(savedStandup.id).toBe("standup-2026-07-07-oc_demo_dev-ou_user");
        expect(savedStandup.source_sender_open_id).toBe("ou_user");
        expect(auditLogs[0]).toMatchObject({
            eventType: "standup_saved",
            payload: { open_id: "ou_user", group_id: "oc_demo_dev" },
        });
    });

    test("should bind unquoted structured standup to latest prompt for that user and date", async () => {
        let savedStandup: any = null;
        const auditLogs: any[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listTasks: async (): Promise<any[]> => [],
                listBotMessageContexts: async () => [
                    {
                        message_id: "om_prompt",
                        context_type: "standup_prompt",
                        created_at: "2026-07-09T01:30:00Z",
                        target_open_id: "ou_user",
                        metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
                    },
                ],
                appendAuditLog: async (eventType: string, payload: any) => { auditLogs.push({ eventType, payload }); return 1; },
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true }),
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 完成飞书机器人测试\n\n【今日计划】\n1. 继续优化上下文\n\n【阻塞/需要帮助】\n无\n\n【风险/可能延期】\n无\n\n【需要决策】\n无",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", null);

        expect(result.handled).toBe(true);
        expect(savedStandup.date).toBe("2026-07-09");
        expect(savedStandup.source_group_id).toBe("oc_demo_dev");
        expect(savedStandup.id).toBe("standup-2026-07-09-oc_demo_dev-ou_user");
        expect(auditLogs).toContainEqual({
            eventType: "standup_saved",
            payload: expect.objectContaining({ user_name: "郑同学", date: "2026-07-09", context_resolution: "same_day_prompt" }),
        });
    });

    test("should record standup blockers without mutating task status", async () => {
        let savedTask: any = null;
        const updates: any[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async () => {},
                listTasks: async (): Promise<any[]> => [{
                    id: "task-1",
                    title: "飞书机器人上线测试",
                    status: "in_progress",
                    primary_owner_open_id: "ou_user",
                    primary_owner_name: "郑同学",
                    assignee_open_ids: ["ou_user"],
                }],
                listTaskUpdates: async (): Promise<any[]> => [],
                getSourceMessage: async (): Promise<any> => null,
                saveTaskUpdate: async (update: any) => { updates.push(update); },
                saveTask: async (task: any) => { savedTask = task; },
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true }),
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n无\n\n【今日计划】\n无\n\n【阻塞/需要帮助】\n飞书机器人上线测试需要产品确认\n\n【风险/可能延期】\n无\n\n【需要决策】\n无",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", {
            context_type: "standup_prompt",
            metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
        });

        expect(result.handled).toBe(true);
        expect(savedTask).toBe(null);
        expect(updates.some(update => update.update_type === "standup_blocker")).toBe(true);
    });

    test("should replace prior lightweight task updates when resubmitting a standup", async () => {
        const updates: any[] = [];
        const deletedStandupIds: string[] = [];
        const ctx: any = {
            config: { groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }] },
            store: {
                saveStandup: async () => {},
                deleteStandupTaskUpdates: async (standupId: string) => { deletedStandupIds.push(standupId); },
                listTasks: async (): Promise<any[]> => [{
                    id: "task-1",
                    title: "飞书机器人上线测试",
                    status: "in_progress",
                    primary_owner_open_id: "ou_user",
                    assignee_open_ids: ["ou_user"],
                }],
                listTaskUpdates: async (): Promise<any[]> => [],
                getSourceMessage: async (): Promise<any> => null,
                saveTaskUpdate: async (update: any) => { updates.push(update); },
                appendAuditLog: async () => 1,
            },
            feishu: { sendPrivateText: async () => ({ ok: true }) },
        };

        await StandupHandler.maybeHandle(ctx, {
            id: "om_resubmit",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 飞书机器人上线测试\n\n【今日计划】\n无",
            sent_at: "2026-07-09T01:50:00Z",
        } as any, "private", {
            context_type: "standup_receipt",
            metadata: { date: "2026-07-09", group_id: "oc_demo_dev", standup_id: "standup-2026-07-09-oc_demo_dev-ou_user" },
        });

        expect(deletedStandupIds).toEqual(["standup-2026-07-09-oc_demo_dev-ou_user"]);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            update_type: "progress",
            content: "任务：【飞书机器人上线测试】昨日完成：飞书机器人上线测试",
            metadata: {
                standup_id: "standup-2026-07-09-oc_demo_dev-ou_user",
                standup_section: "yesterday_done",
            },
        });
    });

    test("should reject empty prompt replies instead of overwriting standup", async () => {
        let savedStandup: any = null;
        const replies: string[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listTasks: async (): Promise<any[]> => [],
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true };
                },
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "我也提交了",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", {
            context_type: "standup_prompt",
            metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
        });

        expect(result.action).toBe("standup_empty_rejected");
        expect(savedStandup).toBe(null);
        expect(replies[0]).toContain("还没识别到站会内容");
    });

    test("should disclose and audit AI failure when natural-language standup parsing cannot fall back", async () => {
        const replies: string[] = [];
        const auditLogs: any[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_devcraft", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async () => { throw new Error("should not save"); },
                listTasks: async (): Promise<any[]> => [],
                appendAuditLog: async (eventType: string, payload: any): Promise<number> => auditLogs.push({ eventType, payload }),
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true };
                },
            },
            intentParser: {
                llm: {
                    chat: async () => { throw new Error("429 quota exceeded"); },
                },
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_ai_failed",
            sender_open_id: "ou_user",
            sender_name: "陈项目",
            text: "我也提交了",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", {
            context_type: "standup_prompt",
            metadata: { date: "2026-07-09", group_id: "oc_devcraft" },
        });

        expect(result.action).toBe("standup_empty_rejected");
        expect(replies[0]).toContain("AI 服务当前限流");
        expect(replies[0]).toContain("固定格式规则也没识别到");
        expect(auditLogs).toContainEqual(expect.objectContaining({
            eventType: "ai_standup_parse_failed",
            payload: expect.objectContaining({
                category: "rate_limited",
                fallback: "structured_rule",
            }),
        }));
    });

    test("should allow resubmitting full standup by replying to receipt", async () => {
        let savedStandup: any = null;
        const contexts: any[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listTasks: async (): Promise<any[]> => [],
                saveBotMessageContext: async (context: any) => { contexts.push(context); },
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true, message_id: "om_receipt_2", chat_id: "oc_private" }),
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 重新整理站会\n\n【今日计划】\n1. 继续测试\n\n【阻塞/需要帮助】\n无",
            sent_at: "2026-07-09T01:50:00Z",
        } as any, "private", {
            context_type: "standup_receipt",
            metadata: { date: "2026-07-09", group_id: "oc_demo_dev", standup_id: "standup-2026-07-09-oc_demo_dev-ou_user" },
        });

        expect(result.action).toBe("standup_saved");
        expect(savedStandup.id).toBe("standup-2026-07-09-oc_demo_dev-ou_user");
        expect(savedStandup.yesterday_done).toEqual(["重新整理站会"]);
        expect(contexts[0]).toMatchObject({
            context_type: "standup_receipt",
            metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
        });
    });

    test("should reject an unquoted standup when multiple prompt groups are available", async () => {
        let savedStandup: any = null;
        const ctx: any = {
            config: {
                groups: [
                    { chat_id: "oc_demo_dev", name: "Demo 研发组" },
                    { chat_id: "oc_ops", name: "OpsTeam" },
                ],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listTasks: async (): Promise<any[]> => [],
                listBotMessageContexts: async () => [
                    {
                        message_id: "om_prompt_1",
                        context_type: "standup_prompt",
                        created_at: "2026-07-09T01:30:00Z",
                        target_open_id: "ou_user",
                        metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
                    },
                    {
                        message_id: "om_prompt_2",
                        context_type: "standup_prompt",
                        created_at: "2026-07-09T01:35:00Z",
                        target_open_id: "ou_user",
                        metadata: { date: "2026-07-09", group_id: "oc_ops" },
                    },
                ],
                appendAuditLog: async () => 1,
            },
            intentParser: {
                llm: {
                    chat: async (system: string, user: string) => {
                        return { ok: true, content: "oc_demo_dev" };
                    }
                }
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true }),
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 完成飞书机器人测试\n\n【今日计划】\n1. 继续优化上下文\n\n【阻塞/需要帮助】\n无\n\n【风险/可能延期】\n无\n\n【需要决策】\n无",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", null);

        expect(result.action).toBe("standup_ambiguous");
        expect(savedStandup).toBe(null);
    });

    test("should prompt user to quote when AI cannot resolve ambiguous standup", async () => {
        let savedStandup: any = null;
        const replies: string[] = [];
        const ctx: any = {
            config: {
                groups: [
                    { chat_id: "oc_demo_dev", name: "Demo 研发组" },
                    { chat_id: "oc_ops", name: "OpsTeam" },
                ],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listTasks: async (): Promise<any[]> => [],
                listBotMessageContexts: async () => [
                    {
                        message_id: "om_prompt_1",
                        context_type: "standup_prompt",
                        created_at: "2026-07-09T01:30:00Z",
                        target_open_id: "ou_user",
                        metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
                    },
                    {
                        message_id: "om_prompt_2",
                        context_type: "standup_prompt",
                        created_at: "2026-07-09T01:35:00Z",
                        target_open_id: "ou_user",
                        metadata: { date: "2026-07-09", group_id: "oc_ops" },
                    },
                ],
                appendAuditLog: async () => 1,
            },
            intentParser: {
                llm: {
                    chat: async (system: string, user: string) => {
                        return { ok: true, content: "ambiguous" };
                    }
                }
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true };
                },
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_reply",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 写了代码\n\n【今日计划】\n1. 继续写代码",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", null);

        expect(result.action).toBe("standup_ambiguous");
        expect(savedStandup).toBe(null);
        expect(replies[0]).toContain("无法确定归属群组");
    });

    test("should reject a standup that has no resolvable group instead of saving it without a group id", async () => {
        let savedStandup: any = null;
        const replies: string[] = [];
        const ctx: any = {
            config: { groups: [] },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listBotMessageContexts: async (): Promise<any[]> => [],
                listTasks: async (): Promise<any[]> => [],
                appendAuditLog: async () => 1,
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true };
                },
            },
        };

        const result = await StandupHandler.maybeHandle(ctx, {
            id: "om_unresolved",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 修复登录问题\n\n【今日计划】\n1. 验证修复结果",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", null);

        expect(result.action).toBe("standup_group_unresolved");
        expect(savedStandup).toBe(null);
        expect(replies[0]).toContain("不会保存或计入提交");
    });

    test("should route a standup in a task reply context to standup handling", async () => {
        let savedStandup: any = null;
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                saveStandup: async (standup: any) => { savedStandup = standup; },
                listBotMessageContexts: async () => [{
                    message_id: "om_prompt",
                    context_type: "standup_prompt",
                    created_at: "2026-07-09T01:30:00Z",
                    target_open_id: "ou_user",
                    metadata: { date: "2026-07-09", group_id: "oc_demo_dev" },
                }],
                listTasks: async (): Promise<any[]> => [],
                appendAuditLog: async () => 1,
            },
            feishu: { sendPrivateText: async () => ({ ok: true }) },
        };

        const result = await ContextRouter.maybeHandle(ctx, {} as any, {
            id: "om_standup_in_task_thread",
            sender_open_id: "ou_user",
            sender_name: "郑同学",
            text: "【昨日完成】\n1. 修复登录问题\n\n【今日计划】\n1. 验证修复结果",
            sent_at: "2026-07-09T01:40:00Z",
        } as any, "private", { context_type: "task_status_notice", task_id: "task-1" });

        expect(result.action).toBe("standup_saved");
        expect(savedStandup.source_group_id).toBe("oc_demo_dev");
    });

    test("should reject a structured standup posted in a group instead of treating it as a task update", async () => {
        const replies: string[] = [];
        const result = await MessageRouter.handleGroup({
            store: { appendAuditLog: async () => 1 },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => {
                    replies.push(text);
                    return { ok: true };
                },
            },
        } as any, {} as any, {
            id: "om_group_standup",
            chat_id: "oc_demo_dev",
            sender_open_id: "ou_user",
            text: "【昨日完成】\n1. 修复登录问题\n\n【今日计划】\n1. 验证修复结果",
        } as any, null);

        expect(result.action).toBe("standup_group_submission_rejected");
        expect(replies[0]).toContain("不会作为任务状态更新");
    });
});
