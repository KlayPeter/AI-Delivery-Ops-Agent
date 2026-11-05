import { teamMessageRoutes } from "./helpers/messageRoutes";
import { describe, expect, test } from "bun:test";
import { MessageHandler } from "@/services/messageHandler";
import { MessageRouter } from "@/services/messageHandler/MessageRouter";
import { ContextResolver } from "@/services/messageHandler/ContextResolver";
import { DashboardHandler } from "@/services/messageHandler/handlers/DashboardHandler";
import { MeetingSummaryHandler } from "@/services/messageHandler/handlers/MeetingSummaryHandler";
import { SummaryHandler } from "@/services/messageHandler/handlers/SummaryHandler";
import { TaskCommandHandler } from "@/services/messageHandler/handlers/TaskCommandHandler";
import { TaskService } from "@/services/taskService";
import { createSingleTask, taskDescription } from "@/services/messageHandler/taskCommands";

function makeHandler() {
    return new MessageHandler({
        messageRoutes: teamMessageRoutes(),
        config: {
            feishu: { bot_open_id: "", bot_name: "AI 交付助理" },
            email: { enabled: false },
        },
        store: {},
        feishu: {},
    } as any);
}

describe("MessageRouter policy", () => {
    test("declares deterministic route priority for group and private messages", () => {
        const registry = teamMessageRoutes();
        const orderFor = (source: "group" | "private") => registry.list(source, 'message').map(route => route.id);
        expect(orderFor("group")).toEqual([
            'builtin.standup', 'builtin.weekly-report', 'builtin.daily-summary', 'builtin.dashboard',
            'builtin.meeting-summary', 'builtin.task.status', 'builtin.task.command', 'builtin.orchestrator',
        ]);
        expect(orderFor("private")).toEqual([
            'builtin.standup', 'builtin.meeting-summary', 'builtin.task.status', 'builtin.task.command', 'builtin.orchestrator',
        ]);
        expect(registry.list('group', 'context').map(route => route.id)).toEqual([
            'builtin.orchestrator.context', 'builtin.standup.context', 'builtin.task.context',
        ]);
        for (const phase of ['message', 'context'] as const) {
            const routes = registry.list(undefined, phase);
            expect(new Set(routes.map(route => route.priority)).size).toBe(routes.length);
        }
    });
});

describe("MessageHandler bot mention detection", () => {
    test("should detect bot mention by configured bot name", () => {
        const handler = makeHandler() as any;

        expect(handler.isBotMentioned({
            text: "@AI 交付助理 你好",
            mentions: [],
        })).toBe(true);
        expect(handler.isBotMentioned({
            text: "你好",
            mentions: [{ open_id: "ou_bot", name: "AI 交付助理" }],
        })).toBe(true);
        expect(handler.isBotMentioned({
            text: "@AI 交付助理 你好",
            mentions: [{ open_id: "", name: "AI 交付助理", key: "@_user_1" }],
        })).toBe(true);
        expect(handler.isBotMentioned({
            text: "普通群消息",
            mentions: [],
        })).toBe(false);
    });

    test("should audit an AI rate-limit failure with its real category", async () => {
        const auditLogs: any[] = [];
        const replies: string[] = [];
        const message = {
            id: "om_ai_limit",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_sender",
            sender_name: "发送人",
            text: "@AI 交付助理 测试",
            mentions: [{ open_id: "ou_bot", name: "AI 交付助理" }],
        };
        const handler = new MessageHandler({
            messageRoutes: teamMessageRoutes(),
            config: { feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" }, email: { enabled: false } },
            store: {
                saveSourceMessage: async () => {},
                appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
            },
            feishu: {
                dryRun: true,
                parseEvent: () => message,
                addReaction: async (): Promise<undefined> => undefined,
                sendReplyText: async (_messageId: string, text: string) => replies.push(text),
            },
        } as any) as any;
        handler.resolver = { resolveReplyContext: async (): Promise<null> => null };
        handler.handleGroupMessage = async (): Promise<never> => {
            throw new Error("LLM API Error (Gemini): Retryable HTTP Error: Too Many Requests");
        };

        const result = await handler.handleEvent({});

        expect(result).toMatchObject({ handled: true, action: "error_fallback" });
        expect(auditLogs).toContainEqual({
            eventType: "message_processing_failed",
            payload: expect.objectContaining({ message_id: "om_ai_limit", category: "ai_rate_limited" }),
        });
        expect(replies[0]).toContain("AI 服务当前限流");
    });

    test("should allow a quoted task standup reply without mentioning the bot again", async () => {
        const message = {
            id: "om_task_template_reply",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_owner",
            sender_name: "负责人",
            text: "任务：接口联调\n负责人：@负责人\n交付时间：今天17点",
            mentions: [{ open_id: "ou_owner", name: "负责人" }],
            parent_id: "om_task_template",
            root_id: "om_task_template",
        };
        const handler = new MessageHandler({
            messageRoutes: teamMessageRoutes(),
            config: { feishu: { bot_open_id: "ou_bot", bot_name: "机器人" }, email: { enabled: false } },
            store: {
                saveSourceMessage: async () => {},
                appendAuditLog: async () => 1,
            },
            feishu: {
                dryRun: true,
                parseEvent: () => message,
                addReaction: async (): Promise<undefined> => undefined,
                removeReaction: async () => {},
            },
        } as any) as any;
        handler.resolver = {
            resolveReplyContext: async () => ({ context_type: "task_standup_template" }),
        };
        handler.handleGroupMessage = async () => ({ handled: true, action: "task_template_reply_allowed" });

        const result = await handler.handleEvent({});

        expect(result).toEqual({ handled: true, action: "task_template_reply_allowed" });
    });
});

describe("TaskCommandHandler", () => {
    test("should not create a task from structured standup content", async () => {
        const result = await TaskCommandHandler.maybeHandle({
            config: { feishu: { bot_open_id: "ou_bot" } },
            store: {
                hasIdempotencyKey: async () => {
                    throw new Error("standup content must not reach task creation");
                },
            },
        } as any, {} as any, {
            id: "om_standup",
            text: "【昨日完成】\n1. 修复登录问题\n\n【今日计划】\n1. 验证修复结果",
        } as any, "group", null);

        expect(result).toBeNull();
    });

    test("should fall back to the parsed task command when AI is rate limited", async () => {
        const auditLogs: any[] = [];
        const created: any[] = [];
        const replies: string[] = [];
        const originalCreateFromCommand = TaskService.createFromCommand;
        (TaskService as any).createFromCommand = async (...args: any[]) => {
            created.push(args);
            return { handled: true, action: "task_created", task_id: "task-rule-fallback" };
        };

        try {
            const result = await TaskCommandHandler.maybeHandle({
                config: {
                    feishu: { bot_open_id: "ou_bot" },
                    groups: [{ members: [{ open_id: "ou_owner", name: "张三" }] }],
                },
                intentParser: {
                    parse: async () => {
                        throw new Error("LLM API Error (Gemini): Retryable HTTP Error: Too Many Requests");
                    },
                },
                store: {
                    hasIdempotencyKey: async () => false,
                    appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
                    saveSourceMessage: async () => {},
                    setIdempotencyKey: async () => {},
                },
                feishu: {
                    sendReplyText: async (_messageId: string, text: string) => {
                        replies.push(text);
                        return { ok: true, message_id: "om_rule_fallback_reply" };
                    },
                },
            } as any, {
                shouldConsiderAi: () => true,
                taskFromReplyContext: async (): Promise<null> => null,
                contextualTask: async (): Promise<null> => null,
            } as any, {
                id: "om_rate_limited",
                chat_id: "oc_group",
                chat_type: "group",
                sender_name: "创建人",
                text: "@AI 交付助理 @张三 创建任务：验证限流降级",
                mentions: [
                    { open_id: "ou_bot", name: "AI 交付助理" },
                    { open_id: "ou_owner", name: "张三" },
                ],
            } as any, "group", null);

            expect(result).toMatchObject({ handled: true, action: "task_created", task_id: "task-rule-fallback" });
            expect(created).toHaveLength(1);
            expect(auditLogs).toContainEqual({
                eventType: "ai_intent_failed",
                payload: expect.objectContaining({
                    message_id: "om_rate_limited",
                    category: "rate_limited",
                    fallback: "deterministic_rule",
                }),
            });
            expect(auditLogs).toContainEqual({
                eventType: "task_command_rule_fallback",
                payload: expect.objectContaining({ message_id: "om_rate_limited", category: "rate_limited" }),
            });
            expect(replies[0]).toContain("AI 服务当前限流");
            expect(replies[0]).toContain("已按任务规则继续处理");
        } finally {
            (TaskService as any).createFromCommand = originalCreateFromCommand;
        }
    });
});

describe("MessageHandler context routing", () => {
    test("should route task reply context before group summary keywords", async () => {
        const task = {
            id: "task-1",
            title: "日报功能修复",
            status: "confirmed",
            source_group_id: "oc_group",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "陈项目",
            assignee_open_ids: ["ou_owner"],
            assignee_names: ["陈项目"],
        };
        const savedUpdates: any[] = [];
        const replies: string[] = [];
        const imageReplies: string[] = [];
        const privateReplies: string[] = [];
        const savedContexts: any[] = [];
        const ctx = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                email: { enabled: false },
                groups: [{ chat_id: "oc_group", name: "Demo 研发组", daily_summary_period: "00:00-23:59", members: [] }],
            },
            store: {
                getTask: async (taskId: string) => taskId === "task-1" ? task : null,
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (update: any) => savedUpdates.push(update),
                saveBotMessageContext: async (context: any) => savedContexts.push(context),
                appendAuditLog: async () => {},
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => {
                    replies.push(text);
                    return { ok: true, message_id: "om_reply", chat_id: "oc_group" };
                },
                sendPrivateText: async (_openId: string, text: string) => {
                    privateReplies.push(text);
                    return { ok: true, message_id: "om_private", chat_id: "oc_p2p" };
                },
            },
            tapd: {},
            dashboard: {},
        } as any;
        ctx.messageRoutes = teamMessageRoutes();
        const handler = new MessageHandler(ctx) as any;

        const result = await handler.handleGroupMessage({
            id: "om_progress",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_owner",
            sender_name: "陈项目",
            text: "@AI 交付助理 任务进度：日报功能已完成",
            mentions: [{ open_id: "ou_bot", name: "AI 交付助理" }],
        } as any, {
            context_type: "task_status_notice",
            task_id: "task-1",
            task_title: "日报功能修复",
        });

        expect(result).toMatchObject({ handled: true, action: "progress_saved", task_id: "task-1" });
        expect(savedUpdates[0]).toMatchObject({
            task_id: "task-1",
            update_type: "progress",
            content: "日报功能已完成",
        });
        expect(replies).toHaveLength(0);
        expect(privateReplies[0]).toContain("已记录任务进度");
        expect(savedContexts[0]).toMatchObject({ context_type: "task_status_notice", task_id: "task-1" });
    });
});

describe("ContextResolver", () => {
    test("should resolve task context through a replied human message", async () => {
        const resolver = new ContextResolver({
            store: {
                getBotMessageContext: async (messageId: string) => messageId === "om_bot_notice" ? {
                    message_id: "om_bot_notice",
                    context_type: "task_acceptance_prompt",
                    task_id: "task-1",
                    task_title: "ai中台部署到服务器上",
                    metadata: { tapd_story_id: "1112345678001001251" },
                } : null,
                listTasks: async (): Promise<any[]> => [],
                listTaskUpdates: async (): Promise<any[]> => [],
                getSourceMessage: async (messageId: string) => messageId === "om_human_reply" ? {
                    id: "om_human_reply",
                    parent_id: "om_bot_notice",
                    root_id: "om_bot_notice",
                    text: "该任务测试负责人是 @王开发",
                } : null,
            },
        } as any);

        const context = await resolver.resolveReplyContext({
            id: "om_current",
            parent_id: "om_human_reply",
            root_id: "om_human_reply",
            text: "验收完成，已实现",
        } as any);

        expect(context).toMatchObject({
            context_type: "task_acceptance_prompt",
            task_id: "task-1",
            task_title: "ai中台部署到服务器上",
        });
    });

    test("should infer the only active owner task for contextual progress wording", async () => {
        const task = {
            id: "task-1",
            title: "调整飞书机器人服务逻辑",
            status: "confirmed",
            primary_owner_open_id: "ou_primary",
            assignee_open_ids: ["ou_primary", "ou_owner"],
        };
        const resolver = new ContextResolver({
            store: {
                listTasks: async (): Promise<any[]> => [task],
            },
        } as any);

        const contextualTask = await resolver.contextualTask({
            id: "om_current",
            sender_open_id: "ou_owner",
            text: "更新该任务进度为50%",
        } as any, null, "更新该任务进度为50%");

        expect(contextualTask).toBe(task);
    });

    test("should resolve multiple images from the current message and its reply chain", async () => {
        const resolver = new ContextResolver({
            store: {
                getSourceMessage: async (messageId: string) => messageId === "om_parent" ? {
                    id: "om_parent",
                    raw_payload: {
                        event: { message: { content: JSON.stringify({ content: [[
                            { tag: "img", image_key: "img_parent" },
                        ]] }) } },
                    },
                } : null,
            },
            feishu: {
                getMessageImageKeys: async (messageId: string) => messageId === "om_root" ? ["img_root"] : [],
            },
        } as any);

        const files = await resolver.resolveRelatedFiles({
            id: "om_current",
            image_key: "img_current_first",
            parent_id: "om_parent",
            root_id: "om_root",
            raw_payload: {
                event: { message: { content: JSON.stringify({ content: [[
                    { tag: "img", image_key: "img_current_first" },
                    { tag: "img", image_key: "img_current_second" },
                ]] }) } },
            },
        } as any);

        expect(files).toEqual([
            { imageKey: "img_current_first", messageId: "om_current" },
            { imageKey: "img_current_second", messageId: "om_current" },
            { imageKey: "img_parent", messageId: "om_parent" },
            { imageKey: "img_root", messageId: "om_root" },
        ]);
    });
});

describe("SummaryHandler", () => {
    function makeSummaryContext() {
        const replies: string[] = [];
        const savedSummaries: any[] = [];
        const auditLogs: any[] = [];
        return {
            ctx: {
                config: {
                    runtime: { daily_summary_fetch_history: false },
                    groups: [{ chat_id: "oc_group", name: "研发群", daily_summary_period: "00:00-23:59" }],
                },
                store: {
                    listSourceMessages: async (): Promise<any[]> => [],
                    listTasks: async (): Promise<any[]> => [],
                    listTaskUpdates: async (): Promise<any[]> => [],
                    saveDailySummary: async (summary: any) => savedSummaries.push(summary),
                    appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
                },
                feishu: {
                    sendReplyText: async (_messageId: string, text: string) => replies.push(text),
                    sendReplyMarkdown: async (_messageId: string, text: string) => replies.push(text),
                },
                dashboard: {},
                tapd: {},
            } as any,
            replies,
            savedSummaries,
            auditLogs,
        };
    }

    test("should treat daily report wording as an intent without requiring a fixed action keyword", async () => {
        const { ctx, replies, savedSummaries, auditLogs } = makeSummaryContext();

        const result = await SummaryHandler.maybeHandle(ctx, {
            id: "om_summary",
            chat_id: "oc_group",
            text: "@AI 交付助理 昨天的日报有吗",
            sent_at: "2026-07-08T10:00:00+08:00",
        } as any, "group");

        expect(result).toMatchObject({ handled: true, action: "daily_summary", date: "2026-07-07" });
        expect(savedSummaries[0]).toMatchObject({ group_id: "oc_group", date: "2026-07-07" });
        expect(replies[0]).toContain("正在同步 2026-07-07 的群聊记录并生成日报");
        expect(replies.at(-1)).toContain("2026-07-07 群内无可总结的有效工作信息。");
        expect(auditLogs[0]).toMatchObject({
            eventType: "daily_summary_started",
            payload: { date: "2026-07-07", source_message_id: "om_summary", group_id: "oc_group" },
        });
        expect(auditLogs.at(-1)).toMatchObject({
            eventType: "daily_summary_generated",
            payload: { date: "2026-07-07", source_message_id: "om_summary", group_id: "oc_group" },
        });
        expect(auditLogs.at(-1)?.payload.duration_ms).toBeNumber();
    });

    test.each([
        ["总结一下7月10号的群聊日报", "2026-07-10"],
        ["总结一下7月10日的群聊日报", "2026-07-10"],
        ["总结一下7/10的群聊日报", "2026-07-10"],
        ["总结一下2026年7月10日的群聊日报", "2026-07-10"],
        ["总结一下2026-07-10的群聊日报", "2026-07-10"],
        ["总结一下昨天的群聊日报", "2026-07-15"],
        ["总结一下前天的群聊日报", "2026-07-14"],
        ["总结一下今天的群聊日报", "2026-07-16"],
    ])("should resolve requested report date from %s", async (text, expectedDate) => {
        const { ctx, savedSummaries } = makeSummaryContext();

        const result = await SummaryHandler.maybeHandle(ctx, {
            id: `om_summary_${expectedDate}`,
            chat_id: "oc_group",
            text: `@AI 交付助理 ${text}`,
            sent_at: "2026-07-16T18:53:00+08:00",
        } as any, "group");

        expect(result).toMatchObject({ handled: true, action: "daily_summary", date: expectedDate });
        expect(savedSummaries[0]).toMatchObject({ group_id: "oc_group", date: expectedDate });
    });

    test("should infer the previous year for a future month-day request", async () => {
        const { ctx, savedSummaries } = makeSummaryContext();

        const result = await SummaryHandler.maybeHandle(ctx, {
            id: "om_summary_previous_year",
            chat_id: "oc_group",
            text: "@AI 交付助理 总结一下12月31号的群聊日报",
            sent_at: "2026-01-02T10:00:00+08:00",
        } as any, "group");

        expect(result).toMatchObject({ handled: true, action: "daily_summary", date: "2025-12-31" });
        expect(savedSummaries[0]).toMatchObject({ group_id: "oc_group", date: "2025-12-31" });
    });

    test("should not generate a daily summary for negated wording", async () => {
        const { ctx, replies } = makeSummaryContext();

        const result = await SummaryHandler.maybeHandle(ctx, {
            id: "om_summary",
            chat_id: "oc_group",
            text: "@AI 交付助理 不要生成昨天的日报",
            sent_at: "2026-07-08T10:00:00+08:00",
        } as any, "group");

        expect(result).toBeNull();
        expect(replies).toHaveLength(0);
    });
});

describe("DashboardHandler", () => {
    function makeDashboardContext() {
        const replies: string[] = [];
        const imageReplies: string[] = [];
        const generatedDays: string[] = [];
        const historicalDays: string[] = [];
        return {
            ctx: {
                config: {
                    runtime: { public_base_url: "https://example.test/dashboard" },
                    groups: [{ chat_id: "oc_group", name: "研发群" }],
                },
                projectDashboard: {
                    generateFresh: async (day: Date) => {
                        const date = day.toISOString().slice(0, 10);
                        generatedDays.push(date);
                        return { artifact: {
                            id: `dashboard-${date}`,
                            date,
                            html_path: `/tmp/dashboard-${date}.html`,
                            stats_path: `/tmp/stats-${date}.json`,
                            created_at: `${date}T00:00:00Z`,
                            public_url: `https://example.test/dashboard-${date}.html`,
                            image_path: `/tmp/dashboard-${date}.png`,
                        }, sync: { ok: true }, subscribers: [] as any[] };
                    },
                    findHistoricalSnapshot: async (date: string) => {
                        historicalDays.push(date);
                        return {
                            id: `dashboard-${date}`,
                            date,
                            html_path: `/tmp/dashboard-${date}.html`,
                            stats_path: `/tmp/stats-${date}.json`,
                            created_at: `${date}T00:00:00Z`,
                            public_url: `https://example.test/dashboard-${date}.html`,
                        };
                    },
                },
                store: {
                    saveDashboardArtifact: async () => {},
                    appendAuditLog: async () => {},
                },
                feishu: {
                    sendReplyText: async (_messageId: string, text: string) => replies.push(text),
                    sendReplyMarkdown: async (_messageId: string, text: string) => replies.push(text),
                    uploadImage: async () => ({ ok: true, image_key: "img_dashboard" }),
                    sendReplyImageKey: async (imageKey: string) => { imageReplies.push(imageKey); return { ok: true }; },
                },
            } as any,
            replies,
            generatedDays,
            historicalDays,
            imageReplies,
        };
    }

    test("should return the saved historical snapshot without regenerating current data", async () => {
        const { ctx, replies, generatedDays, historicalDays } = makeDashboardContext();

        const result = await DashboardHandler.maybeHandle(ctx, {
            id: "om_dashboard",
            chat_id: "oc_group",
            text: "@AI 交付助理 2026-07-07 的项目看板有吗",
        } as any, "group");

        expect(result).toMatchObject({ handled: true, action: "dashboard" });
        expect(generatedDays).toHaveLength(0);
        expect(historicalDays).toEqual(["2026-07-07"]);
        expect(replies[0]).toContain("历史快照。");
        expect(replies[0]).toContain("[打开在线看板](https://example.test/dashboard/?groupId=oc_group&dashboardId=dashboard-2026-07-07)");
    });

    test("should refresh TAPD and create a new snapshot for a current dashboard request", async () => {
        const { ctx, replies, generatedDays, imageReplies } = makeDashboardContext();

        const result = await DashboardHandler.maybeHandle(ctx, {
            id: "om_dashboard",
            chat_id: "oc_group",
            text: "@AI 交付助理 生成最新项目看板",
        } as any, "group");

        expect(result).toMatchObject({ handled: true, action: "dashboard" });
        expect(generatedDays).toHaveLength(1);
        expect(imageReplies).toEqual(["img_dashboard"]);
        expect(replies[0]).toContain("已刷新 TAPD 并生成新快照。");
        expect(replies[0]).toContain("完整看板图片已发送。");
        expect(replies[0]).toContain(`[打开在线看板](https://example.test/dashboard/?groupId=oc_group&dashboardId=dashboard-${generatedDays[0]})`);
    });

    test("should hide the fallback dashboard URL behind a concise link label", async () => {
        const { ctx, replies } = makeDashboardContext();
        ctx.config.runtime.public_base_url = "http://localhost:8080/";
        ctx.projectDashboard.generateFresh = async () => ({ artifact: {
            id: "dashboard-fallback",
            date: "2026-07-13",
            html_path: "/tmp/dashboard-fallback.html",
            stats_path: "/tmp/stats-fallback.json",
            created_at: "2026-07-13T00:00:00Z",
            image_path: "/tmp/dashboard-fallback.png",
        }, sync: { ok: true }, subscribers: [] as any[] });

        await DashboardHandler.maybeHandle(ctx, {
            id: "om_dashboard",
            chat_id: "oc_group",
            text: "@AI 交付助理 生成最新项目看板",
        } as any, "group");

        expect(replies[0]).toContain("[打开在线看板](http://localhost:8080/?groupId=oc_group&dashboardId=dashboard-fallback)");
        expect(replies[0]).not.toContain("在线访问：http");
    });

    test("should not generate dashboard for negated wording", async () => {
        const { ctx, replies, generatedDays } = makeDashboardContext();

        const result = await DashboardHandler.maybeHandle(ctx, {
            id: "om_dashboard",
            chat_id: "oc_group",
            text: "@AI 交付助理 不要生成看板",
        } as any, "group");

        expect(result).toBeNull();
        expect(generatedDays).toHaveLength(0);
        expect(replies).toHaveLength(0);
    });

    test("should not generate dashboard for a design or rule discussion", async () => {
        const { ctx, replies, generatedDays } = makeDashboardContext();

        const result = await DashboardHandler.maybeHandle(ctx, {
            id: "om_dashboard",
            chat_id: "oc_group",
            text: "@AI 交付助理 看板样式怎么图形化",
        } as any, "group");

        expect(result).toBeNull();
        expect(generatedDays).toHaveLength(0);
        expect(replies).toHaveLength(0);
    });

    test("should not treat a dashboard logic bug report as a generation command", async () => {
        const { ctx, replies, generatedDays } = makeDashboardContext();

        const result = await DashboardHandler.maybeHandle(ctx, {
            id: "om_dashboard",
            chat_id: "oc_group",
            text: "@AI 交付助理 看板现在逻辑有问题，你检查一下",
        } as any, "group");

        expect(result).toBeNull();
        expect(generatedDays).toHaveLength(0);
        expect(replies).toHaveLength(0);
    });
});

describe("Task creation quality", () => {
    test("should send task creation receipt privately instead of replying in group", async () => {
        const groupReplies: string[] = [];
        const privateMessages: Array<{ openId: string; text: string }> = [];
        const savedContexts: any[] = [];
        const ctx = {
            config: {
                groups: [{ chat_id: "oc_group", name: "研发群", members: [] }],
            },
            tapd: {
                createStory: async () => ({
                    ok: true,
                    story_id: "1112345678001001287",
                    url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001287",
                }),
            },
            store: {
                saveTask: async () => {},
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async () => {},
                saveBotMessageContext: async (context: any) => savedContexts.push(context),
                appendAuditLog: async () => {},
                updateChatId: async () => {},
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => {
                    groupReplies.push(text);
                    return { ok: true, message_id: "om_group", chat_id: "oc_group" };
                },
                sendPrivateText: async (openId: string, text: string) => {
                    privateMessages.push({ openId, text });
                    return { ok: true, message_id: `om_private_${privateMessages.length}`, chat_id: `oc_p2p_${openId}` };
                },
            },
        } as any;

        await createSingleTask(ctx, {
            id: "om_create",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_creator",
            sender_name: "创建人",
            text: "@机器人 创建任务",
        } as any, {
            should_create: true,
            reason: "ok",
            title: "game牌桌资源回收机制方案设计",
            primary_owner: { open_id: "ou_owner", name: "负责人" },
            assignees: [{ open_id: "ou_owner", name: "负责人" }],
            priority: "P1",
            tapd_priority_label: "High",
            due_date: "2026-07-15",
            acceptance_criteria: [],
            description: "",
            is_independent: false,
            missing_primary_owner: false,
            is_subtask: false,
        } as any);

        expect(groupReplies).toHaveLength(0);
        expect(privateMessages.some(item => item.openId === "ou_owner" && item.text.includes("新任务待确认"))).toBe(true);
        expect(privateMessages.some(item => item.openId === "ou_creator" && item.text.includes("已创建任务"))).toBe(true);
        expect(savedContexts.some(item => item.context_type === "task_creation_receipt" && item.chat_type === "p2p")).toBe(true);
    });

    test("should format TAPD detail with body, people, and source sections", () => {
        const text = taskDescription({
            text: "@Bot @王开发 创建任务：调研 示例知识库 使用方式",
            chat_type: "group",
            sender_name: "吴经理",
        } as any, {
            description: "调研 示例知识库 使用原理，确认转换后的 md 文件是否都载入到提示词中。",
            due_date: "2026-07-10",
            acceptance_criteria: ["输出调研结论", "给出代码接入建议"],
            primary_owner: { open_id: "ou_owner", name: "王开发" },
            assignees: [{ open_id: "ou_owner", name: "王开发" }],
        } as any);

        expect(text).toContain("- 调研 示例知识库 使用原理");
        expect(text).toContain("- 验收标准：输出调研结论；给出代码接入建议");
        expect(text).toContain("- 截止时间：2026-07-10");
        expect(text).toContain("提出人：吴经理；创建人：吴经理；开发人员：王开发；参与人：王开发");
        expect(text).toContain("--- 来源：飞书群聊消息");
    });

    test("should let AI split a multi-task request before rule parsing", async () => {
        const tapdStories: any[] = [];
        const detailImageStories: string[] = [];
        const savedTasks: any[] = [];
        const idempotency = new Map<string, any>();
        const ctx = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                tapd: { attachment_custom_field: "custom_field_five" },
                groups: [{
                    chat_id: "oc_group",
                    name: "研发群",
                    members: [
                        { open_id: "ou_owner", name: "王开发", is_active: true },
                    ],
                }],
            },
            intentParser: {
                parse: async () => ({
                    intent: "create_task",
                    confidence: 0.96,
                    task_ref: { task_id: "", tapd_story_id: "", title: "" },
                    fields: { title: "", description: "", due_date: "", priority: "", owner_open_id: "", progress: "", status_action: "" },
                    tasks: [
                        {
                            title: "调研 示例知识库 原理调用",
                            description: "确认转换后的 md 文件是否都会载入到提示词中，并输出结论。",
                            due_date: "",
                            priority: "P1",
                            owner_open_id: "ou_owner",
                            acceptance_criteria: [] as string[],
                        },
                        {
                            title: "验证 示例知识库 代码接入方式",
                            description: "调研 示例知识库 如何在代码中使用，若存在困难及时反馈寻求支援。",
                            due_date: "",
                            priority: "P1",
                            owner_open_id: "ou_owner",
                            acceptance_criteria: [] as string[],
                        },
                    ],
                    needs_clarification: false,
                    clarification: "",
                    error: "",
                    available: true,
                }),
            },
            store: {
                hasIdempotencyKey: async (key: string) => idempotency.has(key),
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                saveSourceMessage: async () => {},
                saveTask: async (task: any) => savedTasks.push(task),
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async () => {},
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
                updateChatId: async () => {},
            },
            tapd: {
                createStory: async (title: string, owner: string, priority: string, due: string | undefined, description: string) => {
                    const storyId = `story-${tapdStories.length + 1}`;
                    tapdStories.push({ title, owner, priority, due, description });
                    return { ok: true, story_id: storyId, url: `https://tapd.test/${storyId}` };
                },
                getStory: async (storyId: string) => {
                    const index = Number(storyId.split("-")[1]) - 1;
                    return { ok: true, raw: { data: [{ Story: { description: tapdStories[index].description } }] } };
                },
                updateStoryDescription: async (storyId: string) => {
                    detailImageStories.push(storyId);
                    return { ok: true };
                },
            },
            feishu: {
                sendPrivateText: async () => ({ message_id: "om_private", chat_id: "oc_private" }),
                sendReplyText: async () => ({ message_id: "om_reply" }),
                downloadResourceWithMetadata: async (_messageId: string, _imageKey: string, _type: string, tempPath: string) => {
                    await Bun.write(tempPath, new Uint8Array([137, 80, 78, 71]));
                    return { ok: true, contentType: "image/png", fileName: "source.png" };
                },
            },
        } as any;
        const resolver = {
            shouldConsiderAi: () => true,
            taskFromReplyContext: async (): Promise<any> => null,
            contextualTask: async (): Promise<any> => null,
        } as any;

        ctx.messageRoutes = teamMessageRoutes();
        const result = await MessageRouter.handleGroup(ctx, resolver, {
            id: "om_create",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_creator",
            sender_name: "吴经理",
            image_key: "img_source",
            text: "@AI 交付助理 @王开发 创建任务\n1. 示例知识库使用原理调研\n2. 示例知识库如何在代码中使用",
            mentions: [
                { open_id: "ou_bot", name: "AI 交付助理" },
                { open_id: "ou_owner", name: "王开发" },
            ],
        } as any, null);

        expect(result).toMatchObject({ handled: true, action: "ai_tasks_created" });
        expect(tapdStories.map(story => story.title)).toEqual([
            "1. 示例知识库使用原理调研 2. 示例知识库如何在代码中使",
            "调研 示例知识库 原理调用",
            "验证 示例知识库 代码接入方式",
        ]);
        expect(tapdStories[1].description).toContain("- 确认转换后的 md 文件是否都会载入到提示词中");
        expect(tapdStories[1].description).toContain("提出人：吴经理；创建人：吴经理；开发人员：王开发；参与人：王开发");
        expect(tapdStories[1].description).toContain("--- 来源：飞书群聊消息");
        expect(savedTasks).toHaveLength(3);
        expect(detailImageStories).toEqual(["story-1"]);
        expect(idempotency.has("om_create:create_task")).toBe(true);
    });

    test("should keep explicit creation intent while AI summarizes the task title", async () => {
        const tapdStories: any[] = [];
        const savedTasks: any[] = [];
        const replies: string[] = [];
        let forcedIntent = "";
        const ctx = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{
                    chat_id: "oc_group",
                    name: "研发群",
                    members: [{ open_id: "ou_owner", name: "周设计", is_active: true }],
                }],
            },
            intentParser: {
                parse: async (...args: any[]) => {
                    forcedIntent = args[5];
                    return {
                        intent: "update_task",
                        confidence: 0.96,
                        task_ref: { task_id: "", tapd_story_id: "", title: "" },
                        fields: {
                            title: "制定演示组件分类方案",
                            description: "参考基础组件、组合组件和实验组件等类别，完成现有组件归类。",
                            due_date: "",
                            priority: "",
                            owner_open_id: "",
                            progress: "",
                            status_action: "",
                        },
                        tasks: [] as any[],
                        needs_clarification: false,
                        clarification: "",
                        error: "",
                        available: true,
                    };
                },
            },
            store: {
                hasIdempotencyKey: async () => false,
                setIdempotencyKey: async () => {},
                saveSourceMessage: async () => {},
                saveTask: async (task: any) => savedTasks.push(task),
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async () => {},
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
                updateChatId: async () => {},
            },
            tapd: {
                createStory: async (title: string, owner: string, priority: string, due: string | undefined, description: string) => {
                    tapdStories.push({ title, owner, priority, due, description });
                    return { ok: true, story_id: "story-1", url: "https://tapd.test/story-1" };
                },
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true, message_id: "om_private", chat_id: "oc_private" }),
                sendReplyText: async (_messageId: string, text: string) => {
                    replies.push(text);
                    return { ok: true, message_id: "om_reply" };
                },
            },
        } as any;
        const resolver = {
            shouldConsiderAi: () => true,
            taskFromReplyContext: async (): Promise<any> => null,
            contextualTask: async (): Promise<any> => null,
        } as any;

        ctx.messageRoutes = teamMessageRoutes();
        const result = await MessageRouter.handleGroup(ctx, resolver, {
            id: "om_card_categories",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_creator",
            sender_name: "吴经理",
            text: "@AI 交付助理 @周设计 创建任务：整理组件分类方案，例如基础组件、组合组件和实验组件，把现有组件归入对应类别。截止时间：本周五。",
            mentions: [
                { open_id: "ou_bot", name: "AI 交付助理" },
                { open_id: "ou_owner", name: "周设计" },
            ],
        } as any, null);

        expect(forcedIntent).toBe("create_task");
        expect(result).toMatchObject({ handled: true, action: "task_created" });
        expect(tapdStories[0]).toMatchObject({
            title: "制定演示组件分类方案",
            owner: "周设计;",
        });
        expect(tapdStories[0].description).toContain("完成现有组件归类");
        expect(savedTasks[0]).toMatchObject({
            title: "制定演示组件分类方案",
            primary_owner_open_id: "ou_owner",
        });
        expect(replies).toHaveLength(0);
    });

    test("should create one task for multiple AI owners and notify every owner", async () => {
        const tapdStories: any[] = [];
        const savedTasks: any[] = [];
        const privateMessages: Array<{ openId: string; text: string }> = [];
        const savedContexts: any[] = [];
        const ctx = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{
                    chat_id: "oc_group",
                    name: "研发群",
                    members: [
                        { open_id: "ou_owner_1", name: "张三", is_active: true },
                        { open_id: "ou_owner_2", name: "李四", is_active: true },
                    ],
                }],
            },
            intentParser: {
                parse: async () => ({
                    intent: "create_task",
                    confidence: 0.96,
                    task_ref: { task_id: "", tapd_story_id: "", title: "" },
                    fields: {
                        title: "联合输出交互方案",
                        description: "两位负责人共同完成交互方案。",
                        due_date: "2026-07-15",
                        priority: "P0",
                        owner_open_id: "ou_owner_1,ou_owner_2",
                        progress: "",
                        status_action: "",
                    },
                    tasks: [] as any[],
                    needs_clarification: false,
                    clarification: "",
                    error: "",
                    available: true,
                }),
            },
            store: {
                hasIdempotencyKey: async () => false,
                setIdempotencyKey: async () => {},
                saveSourceMessage: async () => {},
                saveTask: async (task: any) => savedTasks.push(task),
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async () => {},
                saveBotMessageContext: async (context: any) => savedContexts.push(context),
                appendAuditLog: async () => {},
                updateChatId: async () => {},
            },
            tapd: {
                createStory: async (title: string, owner: string) => {
                    tapdStories.push({ title, owner });
                    return { ok: true, story_id: "story-1", url: "https://tapd.test/story-1" };
                },
            },
            feishu: {
                sendPrivateText: async (openId: string, text: string) => {
                    privateMessages.push({ openId, text });
                    return { ok: true, message_id: `om_private_${privateMessages.length}`, chat_id: `oc_p2p_${openId}` };
                },
                sendReplyText: async () => ({ ok: true, message_id: "om_reply" }),
            },
        } as any;
        const resolver = {
            shouldConsiderAi: () => true,
            taskFromReplyContext: async (): Promise<any> => null,
            contextualTask: async (): Promise<any> => null,
        } as any;

        const result = await TaskCommandHandler.maybeHandle(ctx, resolver, {
            id: "om_multi_owner",
            chat_id: "oc_group",
            chat_type: "group",
            sender_open_id: "ou_creator",
            sender_name: "创建人",
            text: "@AI 交付助理 创建任务：联合输出交互方案，负责人 @张三 @李四",
            mentions: [
                { open_id: "ou_bot", name: "AI 交付助理" },
                { open_id: "ou_owner_1", name: "张三" },
                { open_id: "ou_owner_2", name: "李四" },
            ],
        } as any, "group", null);

        expect(result).toMatchObject({ handled: true, action: "task_created" });
        expect(tapdStories).toEqual([{ title: "联合输出交互方案", owner: "张三;李四;" }]);
        expect(savedTasks[0]).toMatchObject({
            primary_owner_open_id: "ou_owner_1",
            assignee_open_ids: ["ou_owner_1", "ou_owner_2"],
            assignee_names: ["张三", "李四"],
        });
        expect(privateMessages.filter(item => item.text.includes("新任务待确认")).map(item => item.openId)).toEqual([
            "ou_owner_1",
            "ou_owner_2",
        ]);
        expect(savedContexts.filter(item => item.context_type === "task_confirmation").map(item => item.target_open_id)).toEqual([
            "ou_owner_1",
            "ou_owner_2",
        ]);
    });
});

describe("MeetingSummaryHandler", () => {
    function makeMeetingSummaryContext() {
        const reactions: string[] = [];
        const replies: string[] = [];
        return {
            ctx: {
                config: { feishu: { bot_open_id: "ou_bot" } },
                store: {
                    getSourceMessage: async (): Promise<any> => null,
                    prisma: {
                        sourceMessage: {
                            findMany: async (): Promise<any[]> => [],
                        },
                    },
                },
                feishu: {
                    addReaction: async (_messageId: string, reaction: string) => reactions.push(reaction),
                    removeReaction: async (_messageId: string, reaction: string) => reactions.push(`remove:${reaction}`),
                    sendReplyText: async (_messageId: string, text: string) => replies.push(text),
                },
            } as any,
            reactions,
            replies,
        };
    }

    test("should not trigger meeting summaries while the feature is disabled", async () => {
        const { ctx, reactions, replies } = makeMeetingSummaryContext();

        const result = await MeetingSummaryHandler.maybeHandle(ctx, {
            id: "om_meeting",
            chat_id: "oc_group",
            sender_open_id: "ou_user",
            text: "@AI 交付助理 帮我处理下上面的会议材料，出两份文档",
            mentions: [{ open_id: "ou_bot", name: "AI 交付助理" }],
        } as any, "group");

        expect(result).toBeNull();
        expect(reactions).toHaveLength(0);
        expect(replies).toHaveLength(0);
    });

    test("should not generate meeting summary for negated wording", async () => {
        const { ctx, reactions, replies } = makeMeetingSummaryContext();

        const result = await MeetingSummaryHandler.maybeHandle(ctx, {
            id: "om_meeting",
            chat_id: "oc_group",
            sender_open_id: "ou_user",
            text: "@AI 交付助理 不要生成会议纪要",
            mentions: [{ open_id: "ou_bot", name: "AI 交付助理" }],
        } as any, "group");

        expect(result).toBeNull();
        expect(reactions).toHaveLength(0);
        expect(replies).toHaveLength(0);
    });
});
