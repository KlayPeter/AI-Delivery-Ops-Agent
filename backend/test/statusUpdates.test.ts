import { describe, expect, test } from "bun:test";
import { applyAction, saveProgress, setTaskStatus, updateTaskDue, updateTaskSupplement } from "@/services/messageHandler/statusUpdates";
import { StatusUpdateHandler } from "@/services/messageHandler/handlers/StatusUpdateHandler";
import { maybeHandleAiIntent } from "@/services/messageHandler/aiActions";
import { TAPD_STATUS_BLOCKED, TAPD_STATUS_DONE, TAPD_STATUS_IN_PROGRESS, TAPD_STATUS_REQUIREMENT, TAPD_STATUS_TESTING } from "@/services/messageHandler/types";
import dayjs from "dayjs";

describe("statusUpdates", () => {
    test("should refuse progress updates when TAPD reports that the task was deleted", async () => {
        let savedTask: any = null;
        const savedUpdates: any[] = [];
        const replies: string[] = [];
        const task: any = {
            id: "task-deleted-remotely",
            title: "线上已删除任务",
            status: "in_progress",
            tapd_story_id: "1112345678001001999",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "负责人",
        };
        const ctx: any = {
            tapd: {
                getStory: async () => ({ ok: true, raw: { data: [] as any[] } }),
            },
            store: {
                saveTask: async (updatedTask: any) => { savedTask = { ...updatedTask }; },
                saveTaskUpdate: async (update: any) => { savedUpdates.push(update); },
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true, message_id: "om_reply", chat_id: "oc_p2p" };
                },
            },
        };

        const result = await saveProgress(ctx, {
            id: "om_progress",
            sender_open_id: "ou_owner",
            sender_name: "负责人",
        } as any, "private", task, "完成 50%");

        expect(result).toMatchObject({ handled: true, action: "task_inactive", task_id: task.id });
        expect(savedTask.status).toBe("deleted");
        expect(savedUpdates).toHaveLength(0);
        expect(replies[0]).toContain("已在 TAPD 删除或取消");
    });

    test("should transition a multi-owner task only after every assignee accepts", async () => {
        let savedTask: any = null;
        const taskUpdates: any[] = [];
        const tapdStatuses: string[] = [];
        const privateMessages: Array<{ openId: string; text: string }> = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                appendAuditLog: async (): Promise<void> => {},
                saveTask: async (task: any): Promise<void> => { savedTask = { ...task }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (taskId?: string): Promise<any[]> => taskId
                    ? taskUpdates.filter(update => update.task_id === taskId)
                    : taskUpdates,
                saveTaskUpdate: async (update: any): Promise<void> => { taskUpdates.push(update); },
                saveBotMessageContext: async (): Promise<void> => {},
            },
            feishu: {
                sendPrivateText: async (openId: string, text: string) => {
                    privateMessages.push({ openId, text });
                    return { ok: true, message_id: `om_private_${privateMessages.length}`, chat_id: `oc_p2p_${openId}` };
                },
            },
        };
        const task = {
            id: "task-1",
            title: "联合输出交互方案",
            status: "pending_confirmation",
            tapd_story_id: "story-1",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_owner_1",
            primary_owner_name: "张三",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_owner_1", "ou_owner_2", "ou_owner_3"],
            assignee_names: ["张三", "李四", "王五"],
        };

        const first = await applyAction(ctx, {
            id: "om_accept_1",
            sender_open_id: "ou_owner_1",
            sender_name: "张三",
        } as any, "private", task, "接受", "接受");
        expect(first).toMatchObject({
            handled: true,
            action: "acceptance_recorded",
            status: "pending_confirmation",
            accepted_count: 1,
            total_count: 3,
            pending_open_ids: ["ou_owner_2", "ou_owner_3"],
        });
        expect(task.status).toBe("pending_confirmation");
        expect(tapdStatuses).toEqual([]);

        const duplicate = await applyAction(ctx, {
            id: "om_accept_1_again",
            sender_open_id: "ou_owner_1",
            sender_name: "张三",
        } as any, "private", task, "接受", "接受");
        expect(duplicate).toMatchObject({ action: "acceptance_already_recorded", accepted_count: 1, total_count: 3 });

        const second = await applyAction(ctx, {
            id: "om_accept_2",
            sender_open_id: "ou_owner_2",
            sender_name: "李四",
        } as any, "private", task, "接受", "接受");
        expect(second).toMatchObject({
            action: "acceptance_recorded",
            status: "pending_confirmation",
            accepted_count: 2,
            total_count: 3,
            pending_open_ids: ["ou_owner_3"],
        });
        expect(tapdStatuses).toEqual([]);

        const third = await applyAction(ctx, {
            id: "om_accept_3",
            sender_open_id: "ou_owner_3",
            sender_name: "王五",
        } as any, "private", task, "接受", "接受");
        expect(third).toMatchObject({ handled: true, action: "developer_accepted", status: "in_progress" });
        expect(savedTask.status).toBe("in_progress");
        expect(savedTask.trace.workflow.phase).toBe("development");
        expect(tapdStatuses).toEqual([TAPD_STATUS_IN_PROGRESS]);
        expect(taskUpdates.filter(update => update.update_type === "accepted_by_assignee").map(update => update.user_open_id)).toEqual([
            "ou_owner_1",
            "ou_owner_2",
            "ou_owner_3",
        ]);
        expect(privateMessages.some(item => item.text.includes("仍待接受：李四、王五"))).toBe(true);
    });

    test("should not mark local task deleted when TAPD status sync fails", async () => {
        let savedTask: any = null;
        let privateText = "";
        const auditLogs: any[] = [];
        const ctx: any = {
            config: {
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryStatus: async () => ({ ok: false, error: "HTTP 404: Not Found", raw: {} }),
            },
            store: {
                appendAuditLog: async (eventType: string, payload: any): Promise<number> => auditLogs.push({ eventType, payload }),
                saveTask: async (task: any): Promise<void> => { savedTask = { ...task }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    privateText = text;
                    return { ok: true, message_id: "om_plan", chat_id: "oc_p2p" };
                },
            },
        };

        const result = await setTaskStatus(ctx, {
            id: "om_accept",
            sender_open_id: "ou_owner",
            sender_name: "负责人",
        } as any, "group", {
            id: "task-1",
            title: "将中台上线",
            status: "pending",
            tapd_story_id: "1001237",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "负责人",
        }, "confirmed", "accepted_by_owner", "接受", "开发进行中");

        expect(result.status).toBe("confirmed");
        expect(savedTask.status).toBe("confirmed");
        expect(privateText).toContain("同步 TAPD 状态失败");
        expect(privateText).not.toContain("任务已被删除");
        expect(auditLogs[0]).toMatchObject({
            eventType: "tapd_update_failed",
            payload: {
                task_id: "task-1",
                tapd_story_id: "1001237",
                tapd_status: "开发进行中",
                local_status: "confirmed",
            },
        });
    });

    test("should follow requirement to implemented TAPD status flow and hand off testing owner", async () => {
        let savedTask: any = null;
        const taskUpdates: any[] = [];
        const tapdStatuses: string[] = [];
        const tapdOwners: string[] = [];
        const tapdComments: string[] = [];
        const groupMessages: string[] = [];
        const privateMessages: Array<{ openId: string; text: string }> = [];
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot" },
                groups: [
                    { chat_id: "oc_demo_dev", name: "Demo 研发组", members: [{ open_id: "ou_dev", name: "开发" }, { open_id: "ou_tester", name: "测试同学" }] },
                    { chat_id: "oc_demo_product", name: "Demo 产品设计组", members: [{ open_id: "ou_product", name: "产品" }] },
                ],
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
                updateStoryOwner: async (_storyId: string, owner: string) => {
                    tapdOwners.push(owner);
                    return { ok: true, raw: {} };
                },
                addStoryComment: async (_storyId: string, description: string) => {
                    tapdComments.push(description);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                appendAuditLog: async (): Promise<void> => {},
                saveTask: async (task: any): Promise<void> => { savedTask = { ...task }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (taskId?: string): Promise<any[]> => taskId ? taskUpdates.filter(item => item.task_id === taskId) : taskUpdates,
                saveTaskUpdate: async (update: any): Promise<void> => { taskUpdates.push(update); },
                saveBotMessageContext: async (): Promise<void> => {},
            },
            feishu: {
                sendPrivateText: async (openId: string, text: string) => {
                    privateMessages.push({ openId, text });
                    return { ok: true, message_id: "om_plan", chat_id: "oc_p2p" };
                },
                sendReplyText: async (_messageId: string, text: string) => {
                    groupMessages.push(text);
                    return { ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" };
                },
                sendGroupText: async (text: string) => {
                    groupMessages.push(text);
                    return { ok: true, message_id: "om_group", chat_id: "oc_demo_dev" };
                },
            },
        };
        const task: any = {
            id: "task-1",
            title: "完成 harness 和 openclaw 调研",
            status: "pending_confirmation",
            tapd_story_id: "1112345678",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
            creator_open_id: "ou_product",
            creator_name: "产品",
            assignee_open_ids: ["ou_dev"],
            assignee_names: ["开发"],
            trace: {
                roles: {
                    creator: { open_id: "ou_product", name: "产品" },
                    product: { open_id: "ou_product", name: "产品" },
                    developer: { open_id: "ou_dev", name: "开发" },
                    tester: null,
                },
            },
        };

        const accepted = await applyAction(ctx, {
            id: "om_accept",
            sender_open_id: "ou_dev",
            sender_name: "开发",
        } as any, "private", task, "接受", "接受");
        expect(accepted).toMatchObject({ action: "developer_accepted", status: "in_progress" });

        const developmentCompleted = await applyAction(ctx, {
            id: "om_development_completed",
            sender_open_id: "ou_dev",
            sender_name: "开发",
        } as any, "private", savedTask, "开发完成", "开发完成");
        expect(developmentCompleted).toMatchObject({ action: "development_completed", status: "development_completed" });
        expect(savedTask.trace.workflow.phase).toBe("development_completed");
        expect(tapdStatuses).toEqual([TAPD_STATUS_IN_PROGRESS]);

        const missingProduct = await applyAction(ctx, {
            id: "om_testing_missing_product",
            chat_id: "oc_demo_dev",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            mentions: [{ open_id: "ou_tester", name: "测试同学" }],
        } as any, "private", savedTask, "转测试", "转测试 @测试同学");
        expect(missingProduct).toMatchObject({ action: "handoff_mentions_required", status: "development_completed" });
        expect(savedTask.trace.workflow.phase).toBe("development_completed");

        const transferred = await applyAction(ctx, {
            id: "om_testing",
            chat_id: "oc_demo_dev",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            mentions: [{ open_id: "ou_tester", name: "测试同学" }, { open_id: "ou_product", name: "产品" }],
        } as any, "private", savedTask, "转测试", "转测试 @测试同学 @产品");

        expect(transferred).toMatchObject({ action: "owner_marked_done", status: "owner_marked_done" });
        expect(savedTask.status).toBe("owner_marked_done");
        expect(savedTask.primary_owner_open_id).toBe("ou_dev");
        expect(tapdOwners).toEqual([]);
        expect(savedTask.trace.workflow.phase).toBe("transfer_test");
        expect(savedTask.trace.workflow.pending_acceptances).toEqual(["ou_tester", "ou_product"]);
        expect(groupMessages[0]).toContain("任务已转测试");
        expect(groupMessages[0]).toContain("等待测试与产品接受");
        expect(savedTask.trace.roles).toMatchObject({
            creator: { open_id: "ou_product", name: "产品" },
            product: { open_id: "ou_product", name: "产品" },
            developer: { open_id: "ou_dev", name: "开发" },
            tester: { open_id: "ou_tester", name: "测试同学" },
        });
        expect(tapdComments[0]).toBe("任务流转：转测试<br>创建人：产品");
        expect(tapdComments[0]).not.toContain("操作人");
        expect(tapdComments[0]).not.toContain("时间");
        expect(tapdComments[0]).not.toContain("\n");
        expect(privateMessages.some(item => item.openId === "ou_tester" && item.text.includes("任务已转测试"))).toBe(true);

        const testerAccepted = await applyAction(ctx, {
            id: "om_tester_accept",
            sender_open_id: "ou_tester",
            sender_name: "测试同学",
        } as any, "private", savedTask, "接受", "接受");
        expect(testerAccepted).toMatchObject({ action: "acceptance_recorded", accepted_count: 1, total_count: 2 });

        const productAccepted = await applyAction(ctx, {
            id: "om_product_accept",
            sender_open_id: "ou_product",
            sender_name: "产品",
        } as any, "private", savedTask, "接受", "接受");
        expect(productAccepted).toMatchObject({ action: "testing_started", status: "testing" });
        expect(savedTask.primary_owner_open_id).toBe("ou_tester");
        expect(tapdOwners).toEqual(["测试同学"]);

        const testPassed = await applyAction(ctx, {
            id: "om_test_passed",
            sender_open_id: "ou_tester",
            sender_name: "测试同学",
        } as any, "private", savedTask, "测试通过", "测试通过");
        expect(testPassed).toMatchObject({ action: "test_passed", status: "testing" });
        expect(savedTask.primary_owner_open_id).toBe("ou_product");

        await applyAction(ctx, {
            id: "om_done",
            sender_open_id: "ou_product",
            sender_name: "产品",
        } as any, "group", savedTask, "验收通过", "验收通过");

        expect(savedTask.status).toBe("accepted");
        expect(savedTask.trace.workflow.phase).toBe("implemented");
        expect(tapdStatuses).toEqual([TAPD_STATUS_IN_PROGRESS, TAPD_STATUS_TESTING, TAPD_STATUS_DONE]);
    });

    test("should treat completed wording as acceptance after task is marked done", async () => {
        let savedTask: any = null;
        const tapdStatuses: string[] = [];
        const replyTexts: string[] = [];
        const privateTexts: string[] = [];
        const task = {
            id: "task-1",
            title: "ai中台部署到服务器上",
            status: "owner_marked_done",
            tapd_story_id: "1112345678001001251",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001251",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_tester",
            primary_owner_name: "测试同学",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_dev", "ou_tester"],
            assignee_names: ["开发", "测试同学"],
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                findTask: async (identifier: string) => identifier === "task-1" ? task : null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => {
                    replyTexts.push(text);
                    return { ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" };
                },
                sendPrivateText: async (_openId: string, text: string) => {
                    privateTexts.push(text);
                    return { ok: true, message_id: "om_private", chat_id: "oc_p2p" };
                },
            },
        };

        const result = await StatusUpdateHandler.maybeHandle(ctx, {} as any, {
            id: "om_done",
            chat_id: "oc_demo_dev",
            chat_type: "group",
            sender_open_id: "ou_tester",
            sender_name: "测试同学",
            text: "已完成 task-1",
            mentions: [],
        } as any, "group", null);

        expect(result).toMatchObject({ handled: true, action: "accepted", task_id: "task-1", status: "accepted" });
        expect(savedTask.status).toBe("accepted");
        expect(tapdStatuses).toEqual([TAPD_STATUS_DONE]);
        expect(replyTexts).toHaveLength(0);
        expect(privateTexts[0]).toContain("已验收");
        expect(privateTexts[0]).not.toContain(TAPD_STATUS_DONE);
    });

    test("should prefer explicit task id over reply context when marking done", async () => {
        let savedTask: any = null;
        const tapdStatuses: string[] = [];
        const explicitTask = {
            id: "task-1284",
            title: "测试需求1",
            status: "in_progress",
            tapd_story_id: "1112345678001001284",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001284",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_dev"],
            assignee_names: ["开发"],
        };
        const replyContextTask = {
            id: "task-1256",
            title: "完成牌桌开发",
            status: "in_progress",
            tapd_story_id: "1112345678001001256",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                findTask: async (identifier: string) => identifier === "1112345678001001284" ? explicitTask : null,
                getTask: async (taskId: string) => taskId === "task-1256" ? replyContextTask : null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendReplyText: async () => ({ ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" }),
                sendPrivateText: async () => ({ ok: true, message_id: "om_private", chat_id: "oc_p2p" }),
                sendGroupText: async () => ({ ok: true, message_id: "om_group", chat_id: "oc_demo_dev" }),
            },
        };
        const resolver = {
            contextualTask: async () => {
                throw new Error("explicit task id should skip contextual task lookup");
            },
        };

        const result = await StatusUpdateHandler.maybeHandle(ctx, resolver as any, {
            id: "om_done",
            chat_id: "oc_demo_dev",
            chat_type: "group",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            text: "我说的是这个任务 1112345678001001284 开发完成了",
            mentions: [{ open_id: "ou_tester", name: "测试同学" }],
        } as any, "group", {
            context_type: "task_acceptance_prompt",
            task_id: "task-1256",
            task_title: "完成牌桌开发",
            metadata: { tapd_story_id: "1112345678001001256" },
        });

        expect(result).toMatchObject({ handled: true, action: "development_completed", task_id: "task-1284" });
        expect(savedTask.id).toBe("task-1284");
        expect(savedTask.tapd_story_id).toBe("1112345678001001284");
        expect(savedTask.trace.workflow.phase).toBe("development_completed");
        expect(tapdStatuses).toEqual([]);
    });

    test("should read task id from quoted TAPD link text", async () => {
        let savedTask: any = null;
        const tapdStatuses: string[] = [];
        const explicitTask = {
            id: "task-1284",
            title: "测试需求1",
            status: "in_progress",
            tapd_story_id: "1112345678001001284",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001284",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_dev"],
            assignee_names: ["开发"],
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                findTask: async (identifier: string) => identifier === "1112345678001001284" ? explicitTask : null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (messageId: string): Promise<any> => messageId === "om_quoted" ? {
                    id: "om_quoted",
                    text: "任务被打回，已转回开发：测试需求1\n🔗 详情：https://tapd.example.test/12345678/prong/stories/view/1112345678001001284\n打回原因：测试不通过",
                } : null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendReplyText: async () => ({ ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" }),
                sendPrivateText: async () => ({ ok: true, message_id: "om_private", chat_id: "oc_p2p" }),
                sendGroupText: async () => ({ ok: true, message_id: "om_group", chat_id: "oc_demo_dev" }),
            },
        };
        const resolver = {
            contextualTask: async (): Promise<any> => null,
        };

        const result = await StatusUpdateHandler.maybeHandle(ctx, resolver as any, {
            id: "om_done",
            parent_id: "om_quoted",
            root_id: "om_quoted",
            chat_id: "oc_demo_dev",
            chat_type: "group",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            text: "开发完成了",
            mentions: [{ open_id: "ou_tester", name: "测试同学" }],
        } as any, "group", null);

        expect(result).toMatchObject({ handled: true, action: "development_completed", task_id: "task-1284" });
        expect(savedTask.id).toBe("task-1284");
        expect(tapdStatuses).toEqual([]);
    });

    test("should report deleted explicit task instead of updating it", async () => {
        let replyText = "";
        let savedTask: any = null;
        const deletedTask = {
            id: "task-deleted",
            title: "已删除测试需求",
            status: "deleted",
            tapd_story_id: "1112345678001001299",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001299",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                findTask: async (identifier: string) => identifier === "1112345678001001299" ? deletedTask : null,
                getSourceMessage: async (): Promise<any> => null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = updatedTask; },
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => {
                    replyText = text;
                    return { ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" };
                },
            },
        };
        const resolver = {
            contextualTask: async (): Promise<any> => null,
        };

        const result = await StatusUpdateHandler.maybeHandle(ctx, resolver as any, {
            id: "om_deleted",
            chat_id: "oc_demo_dev",
            chat_type: "group",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            text: "1112345678001001299 开发完成了",
            mentions: [],
        } as any, "group", null);

        expect(result).toMatchObject({ handled: true, action: "task_deleted" });
        expect(replyText).toContain("该任务：已删除测试需求 1112345678001001299 已经被删除");
        expect(savedTask).toBe(null);
    });

    test("should comment reject reason in TAPD, return owner to developer, and avoid raw status codes", async () => {
        let savedTask: any = null;
        const tapdStatuses: string[] = [];
        const tapdOwners: string[] = [];
        const tapdComments: string[] = [];
        const replyTexts: string[] = [];
        const privateMessages: Array<{ openId: string; text: string }> = [];
        const task = {
            id: "task-1",
            title: "完成牌桌开发",
            status: "owner_marked_done",
            tapd_story_id: "1112345678001001256",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001256",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_tester",
            primary_owner_name: "测试同学",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_dev", "ou_tester"],
            assignee_names: ["开发", "测试同学"],
            trace: {
                roles: {
                    creator: { open_id: "ou_creator", name: "创建人" },
                    developer: { open_id: "ou_dev", name: "开发" },
                    tester: { open_id: "ou_tester", name: "测试同学" },
                },
            },
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
                updateStoryOwner: async (_storyId: string, owner: string) => {
                    tapdOwners.push(owner);
                    return { ok: true, raw: {} };
                },
                addStoryComment: async (_storyId: string, description: string) => {
                    tapdComments.push(description);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendReplyText: async (_messageId: string, text: string) => {
                    replyTexts.push(text);
                    return { ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" };
                },
                sendPrivateText: async (openId: string, text: string) => {
                    privateMessages.push({ openId, text });
                    return { ok: true, message_id: "om_private", chat_id: "oc_p2p" };
                },
            },
        };

        const result = await setTaskStatus(ctx, {
            id: "om_reopen",
            chat_id: "oc_demo_dev",
            sender_open_id: "ou_tester",
            sender_name: "测试同学",
        } as any, "group", task, "in_progress", "reopened", "打回，测试", TAPD_STATUS_IN_PROGRESS);

        expect(result).toMatchObject({ handled: true, action: "reopened", task_id: "task-1", status: "in_progress" });
        expect(savedTask.primary_owner_open_id).toBe("ou_dev");
        expect(savedTask.primary_owner_name).toBe("开发");
        expect(tapdStatuses).toEqual([TAPD_STATUS_IN_PROGRESS]);
        expect(tapdOwners).toEqual(["开发"]);
        expect(tapdComments[0]).toBe("打回原因：测试<br>创建人：创建人");
        expect(tapdComments[0]).not.toContain("操作人");
        expect(tapdComments[0]).not.toContain("时间");
        expect(tapdComments[0]).not.toContain("\n");
        expect(replyTexts).toHaveLength(0);
        expect(privateMessages.some(item => item.openId === "ou_tester" && item.text.includes("已打回，转回开发"))).toBe(true);
        expect(privateMessages.some(item => item.text.includes(TAPD_STATUS_IN_PROGRESS))).toBe(false);
        const developerNotice = privateMessages.find(item => item.openId === "ou_dev");
        expect(developerNotice?.text).toContain("任务被打回");
        expect(developerNotice?.text).toContain("测试");
    });

    test("should keep reject reason when AI classifies a reopen status", async () => {
        let savedTask: any = null;
        const tapdComments: string[] = [];
        const privateMessages: Array<{ openId: string; text: string }> = [];
        const task = {
            id: "task-1",
            title: "测试TAPD状态流转",
            status: "owner_marked_done",
            tapd_story_id: "1112345678001001281",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001281",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_tester",
            primary_owner_name: "测试同学",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_dev", "ou_tester"],
            assignee_names: ["开发", "测试同学"],
            trace: {
                roles: {
                    creator: { open_id: "ou_creator", name: "创建人" },
                    developer: { open_id: "ou_dev", name: "开发" },
                    tester: { open_id: "ou_tester", name: "测试同学" },
                },
            },
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            intentParser: {
                parse: async () => ({
                    intent: "change_status",
                    confidence: 0.96,
                    task_ref: { task_id: "task-1", tapd_story_id: "1112345678001001281", title: "测试TAPD状态流转" },
                    fields: { title: "", description: "", due_date: "", priority: "", owner_open_id: "", progress: "", status_action: "打回" },
                    tasks: [] as any[],
                    needs_clarification: false,
                    clarification: "",
                    error: "",
                    available: true,
                }),
            },
            tapd: {
                updateStoryStatus: async () => ({ ok: true, raw: {} }),
                updateStoryOwner: async () => ({ ok: true, raw: {} }),
                addStoryComment: async (_storyId: string, description: string) => {
                    tapdComments.push(description);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                saveSourceMessage: async () => {},
                findTask: async (identifier: string) => identifier === "task-1" ? task : null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendReplyText: async () => ({ ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" }),
                sendPrivateText: async (openId: string, text: string) => {
                    privateMessages.push({ openId, text });
                    return { ok: true, message_id: "om_private", chat_id: "oc_p2p" };
                },
            },
        };
        const resolver = {
            shouldConsiderAi: () => true,
            taskFromReplyContext: async () => task,
        };

        const result = await maybeHandleAiIntent(ctx, resolver as any, {
            id: "om_ai_reopen",
            chat_id: "oc_demo_dev",
            chat_type: "group",
            sender_open_id: "ou_tester",
            sender_name: "测试同学",
            text: "打回，测试",
            mentions: [],
        } as any, "group", {
            context_type: "task_acceptance_prompt",
            task_id: "task-1",
            task_title: "测试TAPD状态流转",
        });

        expect(result).toMatchObject({ handled: true, action: "reopened", task_id: "task-1" });
        expect(savedTask.status).toBe("in_progress");
        expect(tapdComments[0]).toBe("打回原因：测试<br>创建人：创建人");
        expect(privateMessages.some(item => item.text.includes("打回原因：测试"))).toBe(true);
    });

    test("should prefer AI task reference over reply context", async () => {
        let savedTask: any = null;
        const tapdStatuses: string[] = [];
        const explicitTask = {
            id: "task-1284",
            title: "测试需求1",
            status: "in_progress",
            tapd_story_id: "1112345678001001284",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001284",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_dev"],
            assignee_names: ["开发"],
        };
        const replyContextTask = {
            id: "task-1256",
            title: "完成牌桌开发",
            status: "in_progress",
            tapd_story_id: "1112345678001001256",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            intentParser: {
                parse: async () => ({
                    intent: "change_status",
                    confidence: 0.96,
                    task_ref: { task_id: "", tapd_story_id: "1112345678001001284", title: "" },
                    fields: { title: "", description: "", due_date: "", priority: "", owner_open_id: "", progress: "", status_action: "开发完成" },
                    tasks: [] as any[],
                    needs_clarification: false,
                    clarification: "",
                    error: "",
                    available: true,
                }),
            },
            tapd: {
                updateStoryStatus: async (_storyId: string, status: string) => {
                    tapdStatuses.push(status);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                saveSourceMessage: async () => {},
                findTask: async (identifier: string) => identifier === "1112345678001001284" ? explicitTask : null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendReplyText: async () => ({ ok: true, message_id: "om_reply", chat_id: "oc_demo_dev" }),
                sendPrivateText: async () => ({ ok: true, message_id: "om_private", chat_id: "oc_p2p" }),
                sendGroupText: async () => ({ ok: true, message_id: "om_group", chat_id: "oc_demo_dev" }),
            },
        };
        const resolver = {
            shouldConsiderAi: () => true,
            taskFromReplyContext: async () => replyContextTask,
        };

        const result = await maybeHandleAiIntent(ctx, resolver as any, {
            id: "om_ai_done",
            chat_id: "oc_demo_dev",
            chat_type: "group",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            text: "我说的是这个任务 1112345678001001284 开发完成了",
            mentions: [{ open_id: "ou_tester", name: "测试同学" }],
        } as any, "group", {
            context_type: "task_acceptance_prompt",
            task_id: "task-1256",
            task_title: "完成牌桌开发",
            metadata: { tapd_story_id: "1112345678001001256" },
        });

        expect(result).toMatchObject({ handled: true, action: "development_completed", task_id: "task-1284" });
        expect(savedTask.id).toBe("task-1284");
        expect(tapdStatuses).toEqual([]);
    });

    test("should save contextual progress before task plan prompts in private replies", async () => {
        let savedUpdate: any = null;
        let privateReply = "";
        const task = {
            id: "task-1",
            title: "调整飞书机器人服务逻辑",
            status: "confirmed",
            tapd_story_id: "1112345678001001252",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001252",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "钱同学",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_owner"],
            assignee_names: ["钱同学"],
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            store: {
                getTask: async (taskId: string) => taskId === "task-1" ? task : null,
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (update: any): Promise<void> => { savedUpdate = update; },
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    privateReply = text;
                    return { ok: true, message_id: "om_reply", chat_id: "oc_p2p" };
                },
            },
        };
        const resolver = {
            contextualTask: async () => task,
        };

        const result = await StatusUpdateHandler.maybeHandle(ctx, resolver as any, {
            id: "om_progress",
            chat_id: "oc_p2p",
            chat_type: "p2p",
            sender_open_id: "ou_owner",
            sender_name: "钱同学",
            text: "更新该任务进度为50%",
            mentions: [],
        } as any, "private", {
            context_type: "task_plan_request",
            task_id: "task-1",
            task_title: "调整飞书机器人服务逻辑",
        });

        expect(result).toMatchObject({ handled: true, action: "progress_saved", task_id: "task-1" });
        expect(savedUpdate).toMatchObject({
            task_id: "task-1",
            update_type: "progress",
            content: "50%",
        });
        expect(privateReply).toContain("已记录任务进度");
    });

    test("should update due date from estimated completion time in task plan replies", async () => {
        let savedTask: any = null;
        const tapdDues: string[] = [];
        const privateReplies: string[] = [];
        const task = {
            id: "task-1",
            title: "测试飞书机器人任务",
            status: "confirmed",
            tapd_story_id: "1112345678001001253",
            tapd_url: "https://tapd.example.test/12345678/prong/stories/view/1112345678001001253",
            source_group_id: "oc_demo_dev",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "赵产品",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            assignee_open_ids: ["ou_owner"],
            assignee_names: ["赵产品"],
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot", bot_name: "AI 交付助理" },
                groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }],
            },
            tapd: {
                updateStoryDueDate: async (_storyId: string, dueDate: string) => {
                    tapdDues.push(dueDate);
                    return { ok: true, raw: {} };
                },
            },
            store: {
                getTask: async (taskId: string) => taskId === "task-1" ? task : null,
                saveTask: async (updatedTask: any): Promise<void> => { savedTask = { ...updatedTask }; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async (): Promise<any[]> => [],
                saveTaskUpdate: async (): Promise<void> => {},
                saveBotMessageContext: async (): Promise<void> => {},
                appendAuditLog: async (): Promise<void> => {},
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    privateReplies.push(text);
                    return { ok: true, message_id: "om_reply", chat_id: "oc_p2p" };
                },
            },
        };
        const resolver = {
            contextualTask: async () => task,
        };
        const expectedDue = dayjs().add(1, "day").format("YYYY-MM-DD");

        const result = await StatusUpdateHandler.maybeHandle(ctx, resolver as any, {
            id: "om_plan",
            chat_id: "oc_p2p",
            chat_type: "p2p",
            sender_open_id: "ou_owner",
            sender_name: "赵产品",
            text: "预计完成时间：明天\n拆分步骤：无\n依赖对象：无\n风险点：无\n是否需要协助：无",
            mentions: [],
        } as any, "private", {
            context_type: "task_plan_request",
            task_id: "task-1",
            task_title: "测试飞书机器人任务",
        });

        expect(result).toMatchObject({ handled: true, action: "task_plan_saved", task_id: "task-1", due_date: expectedDue });
        expect(savedTask.due_date).toBe(expectedDue);
        expect(savedTask.task_plan.estimated_time).toBe("明天");
        expect(tapdDues).toEqual([expectedDue]);
        expect(privateReplies[0]).toContain(`截止时间已更新：${expectedDue}`);
    });

    test("should route a product-owned draft through requirement acceptance before development", async () => {
        const updates: any[] = [];
        const tapdStatuses: string[] = [];
        const tapdOwners: string[] = [];
        let savedTask: any = null;
        const task: any = {
            id: "task-product-flow",
            title: "优化支付流程",
            status: "pending_confirmation",
            tapd_story_id: "story-product-flow",
            source_group_id: "oc_demo_product",
            creator_open_id: "ou_creator",
            creator_name: "创建人",
            primary_owner_open_id: "ou_product",
            primary_owner_name: "产品",
            assignee_open_ids: ["ou_product"],
            assignee_names: ["产品"],
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
        };
        const ctx: any = {
            config: {
                feishu: { bot_open_id: "ou_bot" },
                groups: [
                    { chat_id: "oc_demo_product", name: "Demo 产品设计组", members: [{ open_id: "ou_product", name: "产品" }] },
                    { chat_id: "oc_demo_dev", name: "Demo 研发组", members: [{ open_id: "ou_dev", name: "开发" }] },
                ],
            },
            tapd: {
                updateStoryStatus: async (_id: string, status: string) => { tapdStatuses.push(status); return { ok: true }; },
                updateStoryOwner: async (_id: string, owner: string) => { tapdOwners.push(owner); return { ok: true }; },
            },
            store: {
                saveTask: async (value: any) => { savedTask = { ...value }; },
                listTaskUpdates: async (taskId?: string) => taskId ? updates.filter(item => item.task_id === taskId) : updates,
                saveTaskUpdate: async (value: any) => { updates.push(value); },
                getSourceMessage: async (): Promise<any> => null,
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
            },
            feishu: {
                sendPrivateText: async () => ({ ok: true, message_id: "om_private", chat_id: "oc_private" }),
            },
        };

        const productAccepted = await applyAction(ctx, {
            id: "om_product_accept",
            sender_open_id: "ou_product",
            sender_name: "产品",
        } as any, "private", task, "接受", "接受");
        expect(productAccepted).toMatchObject({ action: "requirement_accepted", status: "requirement" });
        expect(savedTask.trace.workflow.phase).toBe("requirement");
        expect(tapdStatuses).toEqual([TAPD_STATUS_REQUIREMENT]);

        const requirementCompleted = await applyAction(ctx, {
            id: "om_requirement_done",
            sender_open_id: "ou_product",
            sender_name: "产品",
            mentions: [{ open_id: "ou_dev", name: "开发" }],
        } as any, "group", savedTask, "需求完成", "需求完成 @开发");
        expect(requirementCompleted).toMatchObject({ action: "requirement_completed", pending_open_ids: ["ou_dev"] });
        expect(savedTask.status).toBe("requirement");
        expect(savedTask.trace.workflow.substate).toBe("waiting_developer_acceptance");

        const developerAccepted = await applyAction(ctx, {
            id: "om_dev_accept",
            sender_open_id: "ou_dev",
            sender_name: "开发",
        } as any, "private", savedTask, "接受", "接受");
        expect(developerAccepted).toMatchObject({ action: "developer_accepted", status: "in_progress" });
        expect(savedTask.trace.workflow.phase).toBe("development");
        expect(savedTask.primary_owner_open_id).toBe("ou_dev");
        expect(tapdOwners).toEqual(["开发"]);
        expect(tapdStatuses).toEqual([TAPD_STATUS_REQUIREMENT, TAPD_STATUS_IN_PROGRESS]);
    });

    test("should keep the developer owner when blocked with a helper and restore the previous phase", async () => {
        const statuses: string[] = [];
        const updates: any[] = [];
        let savedTask: any = null;
        const task: any = {
            id: "task-blocked",
            title: "修复同步问题",
            status: "in_progress",
            tapd_story_id: "story-blocked",
            source_group_id: "oc_demo_dev",
            creator_open_id: "ou_product",
            creator_name: "产品",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
            assignee_open_ids: ["ou_dev"],
            assignee_names: ["开发"],
            trace: { workflow: { phase: "development", roles: { creator: { open_id: "ou_product", name: "产品" }, product: { open_id: "ou_product", name: "产品" }, developer: { open_id: "ou_dev", name: "开发" }, tester: null }, history: [], pending_acceptances: [], accepted_open_ids: [], blocked: false, resume_phase: null, resume_status: null, pending_role: null, substate: null } },
        };
        const ctx: any = {
            config: { feishu: { bot_open_id: "ou_bot" }, groups: [{ chat_id: "oc_demo_dev", name: "Demo 研发组", members: [] }] },
            tapd: { updateStoryStatus: async (_id: string, status: string) => { statuses.push(status); return { ok: true }; } },
            store: {
                saveTask: async (value: any) => { savedTask = { ...value }; },
                listTaskUpdates: async () => updates,
                saveTaskUpdate: async (value: any) => { updates.push(value); },
                getSourceMessage: async (): Promise<any> => null,
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
            },
            feishu: { sendPrivateText: async () => ({ ok: true, message_id: "om_private", chat_id: "oc_private" }) },
        };

        await setTaskStatus(ctx, {
            id: "om_blocked",
            sender_open_id: "ou_dev",
            sender_name: "开发",
            mentions: [{ open_id: "ou_helper", name: "协助人" }],
        } as any, "private", task, "blocked", "blocked", "阻塞，原因：接口无权限，需要 @协助人 协助", TAPD_STATUS_BLOCKED);
        expect(savedTask.primary_owner_open_id).toBe("ou_dev");
        expect(savedTask.trace.workflow).toMatchObject({ phase: "development", blocked: true, resume_status: "in_progress" });

        const resumed = await applyAction(ctx, {
            id: "om_resume",
            sender_open_id: "ou_dev",
            sender_name: "开发",
        } as any, "private", savedTask, "恢复", "恢复");
        expect(resumed).toMatchObject({ action: "unblocked", status: "in_progress" });
        expect(savedTask.primary_owner_open_id).toBe("ou_dev");
        expect(savedTask.trace.workflow).toMatchObject({ phase: "development", blocked: false, resume_status: null });
        expect(statuses).toEqual([TAPD_STATUS_BLOCKED, TAPD_STATUS_IN_PROGRESS]);
    });

    test("should finish persisting due-date updates before replying", async () => {
        let releaseSave!: () => void;
        let markSaveStarted!: () => void;
        const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
        const saveReleased = new Promise<void>(resolve => { releaseSave = resolve; });
        const replies: string[] = [];
        const updates: any[] = [];
        const task: any = {
            id: "task-due-order",
            title: "验证持久化顺序",
            status: "in_progress",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "负责人",
            assignee_open_ids: ["ou_owner"],
            assignee_names: ["负责人"],
        };
        const ctx: any = {
            tapd: {},
            store: {
                saveTask: async () => { markSaveStarted(); await saveReleased; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async () => updates,
                saveTaskUpdate: async (update: any) => { updates.push(update); },
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true, message_id: "om_due", chat_id: "oc_private" };
                },
            },
        };

        const operation = updateTaskDue(ctx, {
            id: "om_due_request",
            sender_open_id: "ou_owner",
            sender_name: "负责人",
        } as any, "private", task, "2026-07-20", "改到下周一");

        await saveStarted;
        expect(replies).toHaveLength(0);
        expect(updates).toHaveLength(0);
        releaseSave();
        await operation;
        expect(replies).toHaveLength(1);
        expect(updates).toHaveLength(1);
    });

    test("should finish persisting task supplements before replying", async () => {
        let releaseSave!: () => void;
        let markSaveStarted!: () => void;
        const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
        const saveReleased = new Promise<void>(resolve => { releaseSave = resolve; });
        const replies: string[] = [];
        const updates: any[] = [];
        const task: any = {
            id: "task-supplement-order",
            title: "验证补充信息顺序",
            status: "in_progress",
            primary_owner_open_id: "ou_owner",
            primary_owner_name: "负责人",
            assignee_open_ids: ["ou_owner"],
            assignee_names: ["负责人"],
            acceptance_criteria: [],
        };
        const ctx: any = {
            tapd: {},
            store: {
                saveTask: async () => { markSaveStarted(); await saveReleased; },
                getSourceMessage: async (): Promise<any> => null,
                listTaskUpdates: async () => updates,
                saveTaskUpdate: async (update: any) => { updates.push(update); },
                saveBotMessageContext: async () => {},
                appendAuditLog: async () => {},
            },
            feishu: {
                sendPrivateText: async (_openId: string, text: string) => {
                    replies.push(text);
                    return { ok: true, message_id: "om_supplement", chat_id: "oc_private" };
                },
            },
        };

        const operation = updateTaskSupplement(ctx, {
            id: "om_supplement_request",
            sender_open_id: "ou_owner",
            sender_name: "负责人",
        } as any, "private", task, null, ["接口返回 200"], "补充验收标准");

        await saveStarted;
        expect(replies).toHaveLength(0);
        expect(updates).toHaveLength(0);
        releaseSave();
        await operation;
        expect(replies).toHaveLength(1);
        expect(updates).toHaveLength(1);
    });
});
