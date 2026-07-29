import { describe, expect, test } from "bun:test";
import { ScheduledJobs } from "@/services/jobs";
import { buildFallbackStandupSummary } from "@/services/standupLLM";

const config: any = {
    groups: [{
        chat_id: "oc_target",
        name: "目标群",
        members: [{ open_id: "ou_same", name: "张三", is_active: true }],
        schedule: {
            standup_summary: "18:00",
            overdue_scan: "09:00",
            overdue_scan_end: "18:30",
            overdue_scan_interval_minutes: 30,
            overdue_scan_timezone: "Asia/Shanghai",
        },
    }],
    runtime: { public_missing_standups: false },
    schedule: {},
};

function makeJobs(store: any, feishu: any = { sendGroupText: async () => ({ ok: true }), sendGroupMarkdown: async () => ({ ok: true }) }) {
    return new ScheduledJobs(
        config,
        store,
        feishu,
        {} as any,
        {} as any
    );
}

describe("ScheduledJobs standup group scoping", () => {
    test("keeps risks and decisions in the deterministic standup summary fallback", () => {
        const text = buildFallbackStandupSummary([{
            open_id: "ou_same",
            user_name: "张三",
            yesterday_done: ["完成接口"],
            today_plan: ["继续联调"],
            blockers: ["等待环境"],
            risks: ["可能延期"],
            decisions_needed: ["确认上线时间"],
        }], "2026-07-23", "全员已提交");

        expect(text).toContain("**🎯 一、团队重点概览**");
        expect(text).toContain("张三**：继续联调");
        expect(text).toContain("张三**：可能延期");
        expect(text).toContain("张三**：确认上线时间");
    });

    test("should scope missing standup checks by group id", async () => {
        const calls: any[] = [];
        const store = {
            listStandups: async (date: string, groupId?: string | null): Promise<any[]> => {
                calls.push({ date, groupId });
                return [];
            },
        };
        const jobs = makeJobs(store);

        const missing = await (jobs as any).missingStandupMembers("oc_target", new Date("2026-07-07T00:00:00Z"));

        expect(calls).toEqual([
            { date: "2026-07-07", groupId: "oc_target" },
            { date: "2026-07-07", groupId: null },
        ]);
        expect(missing).toEqual(config.groups[0].members);
    });

    test("should scope standup summary submissions by group id", async () => {
        const calls: any[] = [];
        const store = {
            listStandups: async (date: string, groupId?: string | null): Promise<any[]> => {
                calls.push({ date, groupId });
                return [];
            },
            appendAuditLog: async () => {},
        };
        const jobs = makeJobs(store);

        const result = await jobs.standupSummary("oc_target", new Date("2026-07-07T00:00:00Z"));

        expect(calls).toEqual([
            { date: "2026-07-07", groupId: "oc_target" },
            { date: "2026-07-07", groupId: null },
        ]);
        expect(result).toEqual({ submitted: 0, missing: 1 });
    });

    test("should include legacy no-group standups for single-group members", async () => {
        const store = {
            listStandups: async (_date: string, groupId?: string | null): Promise<any[]> => {
                if (groupId === null) {
                    return [{ open_id: "ou_same", user_name: "张三", submitted_at: "2026-07-07T01:00:00Z" }];
                }
                return [];
            },
            appendAuditLog: async () => {},
        };
        const sentTexts: string[] = [];
        const jobs = makeJobs(store, {
            sendGroupText: async (text: string) => {
                sentTexts.push(text);
                return { ok: true };
            },
            sendGroupMarkdown: async (text: string, chatId: string, title?: string) => {
                sentTexts.push(title ? `${title}\n${text}` : text);
                return { ok: true };
            },
        });

        const result = await jobs.standupSummary("oc_target", new Date("2026-07-07T00:00:00Z"));

        expect(result).toEqual({ submitted: 1, missing: 0 });
        expect(sentTexts[0]).not.toContain("暂无站会提交");
    });

    test("should publish only standups submitted after the main summary as a supplement", async () => {
        const auditLogs: any[] = [];
        const sent: Array<{ text: string; title?: string }> = [];
        const store = {
            listStandups: async (): Promise<any[]> => [
                { open_id: "ou_same", user_name: "张三", submitted_at: "2026-07-07T17:59:00Z", yesterday_done: ["主汇总内容"], today_plan: [], blockers: [], risks: [], decisions_needed: [] },
                { open_id: "ou_late", user_name: "李四", submitted_at: "2026-07-07T18:15:00Z", yesterday_done: ["补交内容"], today_plan: ["继续联调"], blockers: [], risks: [], decisions_needed: [] },
            ],
            appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
        };
        config.groups[0].members.push({ open_id: "ou_late", name: "李四", is_active: true });
        try {
            const jobs = makeJobs(store, {
                sendGroupMarkdown: async (text: string, _chatId: string, title?: string) => {
                    sent.push({ text, title });
                    return { ok: true };
                },
            });

            const result = await jobs.standupSupplementSummary("oc_target", new Date("2026-07-07T12:00:00Z"));

            expect(result).toEqual({ supplemented: 1 });
            expect(sent).toHaveLength(1);
            expect(sent[0].title).toBe("【站会补充｜2026-07-07】");
            expect(sent[0].text).toContain("李四");
            expect(sent[0].text).toContain("补交内容");
            expect(sent[0].text).not.toContain("主汇总内容");
            expect(auditLogs.some(item => item.eventType === "standup_supplement_summary_generated" && item.payload.submitted === 1)).toBe(true);
        } finally {
            config.groups[0].members.pop();
        }
    });

    test("should retry a failed standup push once and record recovery", async () => {
        const auditLogs: any[] = [];
        let attempts = 0;
        const store = {
            appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
            updateChatId: async () => {},
            saveBotMessageContext: async () => {},
        };
        const jobs = makeJobs(store, {
            sendPrivateText: async () => {
                attempts++;
                return attempts === 1
                    ? { ok: false, raw: { code: 999 }, error: "temporary failure" }
                    : { ok: true, chat_id: "oc_private", message_id: "om_retry" };
            },
        });

        await expect(jobs.standupPush("oc_target", new Date("2026-07-07T00:00:00Z"))).resolves.toEqual({ sent: 1, failed: 0 });
        expect(attempts).toBe(2);
        expect(auditLogs).toEqual([{
            eventType: "standup_push_retry_succeeded",
            payload: expect.objectContaining({ open_id: "ou_same", first_error: "temporary failure" }),
        }]);
    });

    test("should fail standup push after its retry also fails", async () => {
        const auditLogs: any[] = [];
        let attempts = 0;
        const store = {
            appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
        };
        const jobs = makeJobs(store, {
            sendPrivateText: async () => {
                attempts++;
                return { ok: false, raw: { code: 230001 }, error: "receiver not in scope" };
            },
        });

        await expect(jobs.standupPush("oc_target", new Date("2026-07-07T00:00:00Z"))).rejects.toThrow("站会模板发送失败");
        expect(attempts).toBe(2);
        expect(auditLogs[0].eventType).toBe("standup_push_failed");
        expect(auditLogs[0].payload.failed).toBe(1);
        expect(auditLogs[0].payload.failures[0]).toMatchObject({ attempts: 2, first_error: "receiver not in scope" });
    });
});

describe("ScheduledJobs overdue reminder delivery", () => {
    test("keeps due-tomorrow and due-today reminders at the 10:00 slot", async () => {
        const tasks: any[] = [
            { id: "task-tomorrow", title: "明日截止", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_tomorrow", due_date: "2026-07-11" },
            { id: "task-today", title: "今日截止", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_today", due_date: "2026-07-10" },
        ];
        const owners: string[] = [];
        const jobs = makeJobs({
            listTasks: async () => tasks,
            saveTask: async () => {},
            saveBotMessageContext: async () => {},
            appendAuditLog: async () => {},
        }, {
            sendPrivateText: async (owner: string) => { owners.push(owner); return { ok: true }; },
        });

        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T09:30:00+08:00"))).toMatchObject({ due_tomorrow: 0, due_today: 0 });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T10:00:00+08:00"))).toMatchObject({ due_tomorrow: 1, due_today: 1 });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T10:30:00+08:00"))).toMatchObject({ due_tomorrow: 0, due_today: 0 });
        expect(owners).toEqual(["ou_tomorrow", "ou_today"]);
    });

    test("should leave a transient reminder failure retryable", async () => {
        const audits: Array<{ eventType: string; payload: any }> = [];
        let saved = 0;
        const task: any = {
            id: "task-reminder-failure",
            title: "修复提醒状态",
            status: "in_progress",
            primary_owner_open_id: "ou_owner",
            due_date: "2026-07-15",
        };
        let attempts = 0;
        const jobs = makeJobs({
            saveTask: async () => { saved++; },
            saveBotMessageContext: async () => {},
            appendAuditLog: async (eventType: string, payload: any) => { audits.push({ eventType, payload }); },
        }, {
            sendPrivateText: async () => {
                attempts++;
                return attempts === 1
                    ? { ok: false, error: "too many request", retryable: true }
                    : { ok: true, message_id: "om_retry" };
            },
        });

        const slot = "2026-07-14:10:00";
        const sent = await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:00:00+08:00"), "due_tomorrow", slot, "请更新进展");

        expect(sent).toBe("failed");
        expect(saved).toBe(0);
        expect(task.overdue_reminders).toBeUndefined();
        expect(audits).toEqual([{
            eventType: "overdue_reminder_failed",
            payload: expect.objectContaining({ task_id: task.id, scenario: "due_tomorrow", error: "too many request", retryable: true }),
        }]);

        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:30:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("sent");
        expect(saved).toBe(1);
        expect(task.overdue_reminders.due_tomorrow_slot).toBe(slot);
    });

    test("should suppress repeated permanent recipient failures until the owner changes", async () => {
        const audits: Array<{ eventType: string; payload: any }> = [];
        let deliveries = 0;
        const task: any = {
            id: "task-test-placeholder",
            title: "失效负责人",
            status: "in_progress",
            primary_owner_open_id: "ou_stale",
            due_date: "2026-07-15",
        };
        const jobs = makeJobs({
            saveTask: async () => {},
            saveBotMessageContext: async () => {},
            appendAuditLog: async (eventType: string, payload: any) => { audits.push({ eventType, payload }); },
        }, {
            sendPrivateText: async () => {
                deliveries++;
                return deliveries === 1
                    ? { ok: false, raw: { code: 230001 }, error: "receiver not in scope", retryable: false }
                    : { ok: true };
            },
        });

        const slot = "2026-07-14:10:00";
        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:00:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("rejected");
        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:30:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("duplicate");
        expect(deliveries).toBe(1);
        expect(audits[0]).toMatchObject({
            eventType: "overdue_reminder_rejected",
            payload: { task_id: task.id, retryable: false },
        });

        task.primary_owner_open_id = "ou_current";
        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:30:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("sent");
        expect(deliveries).toBe(2);
    });

    test("skips unresolved owners once per reminder slot without calling Feishu", async () => {
        const audits: Array<{ eventType: string; payload: any }> = [];
        let saved = 0;
        let deliveries = 0;
        const task: any = {
            id: "task-missing-owner",
            title: "负责人未映射",
            status: "in_progress",
            primary_owner_open_id: "",
            primary_owner_name: "刘开发",
            assignee_names: ["刘开发"],
            due_date: "2026-07-15",
        };
        const jobs = makeJobs({
            saveTask: async () => { saved++; },
            appendAuditLog: async (eventType: string, payload: any) => { audits.push({ eventType, payload }); },
        }, {
            sendPrivateText: async () => {
                deliveries++;
                return { ok: true };
            },
        });

        const slot = "2026-07-14:10:00";
        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:00:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("skipped");
        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:30:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("duplicate");

        expect(deliveries).toBe(0);
        expect(saved).toBe(1);
        expect(task.overdue_reminders.due_tomorrow_unresolved_owner_slot).toBe(slot);
        expect(audits).toEqual([{
            eventType: "overdue_reminder_skipped_missing_owner",
            payload: expect.objectContaining({
                task_id: task.id,
                owner_name: "刘开发",
                reason: "primary_owner_open_id_missing",
            }),
        }]);

        task.primary_owner_open_id = "ou_dion";
        expect(await (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:30:00+08:00"), "due_tomorrow", slot, "请更新进展")).toBe("sent");
        expect(deliveries).toBe(1);
        expect(saved).toBe(2);
        expect(task.overdue_reminders.due_tomorrow_slot).toBe(slot);
        expect(audits[1]).toMatchObject({
            eventType: "overdue_reminder_sent",
            payload: { task_id: task.id, scenario: "due_tomorrow", slot },
        });
    });

    test("reminds overdue owners at the 1, 3 and 5 day escalation frequencies without group messages", async () => {
        const tasks: any[] = [
            { id: "task-day1", title: "超期一天", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_day1", due_date: "2026-07-09" },
            { id: "task-day3", title: "超期三天", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_day3", due_date: "2026-07-07" },
            { id: "task-day5", title: "超期五天", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_day5", due_date: "2026-07-05" },
        ];
        const privateMessages: Array<{ owner: string; text: string }> = [];
        let groupMessages = 0;
        const store = {
            listTasks: async () => tasks,
            saveTask: async () => {},
            saveTaskUpdate: async () => {},
            saveBotMessageContext: async () => {},
            appendAuditLog: async () => {},
        };
        const jobs = makeJobs(store, {
            sendPrivateText: async (owner: string, text: string) => {
                privateMessages.push({ owner, text });
                return { ok: true };
            },
            sendGroupMarkdown: async () => { groupMessages++; return { ok: true }; },
        });

        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T08:30:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 0,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T10:00:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 1, overdue_day3: 1, overdue_day5: 1,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T10:30:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 0,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T11:00:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 1,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T16:00:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 1, overdue_day5: 1,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T18:00:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 1,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T18:30:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 0,
        });
        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T19:00:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 0,
        });

        expect(privateMessages.map(item => item.owner)).toEqual(["ou_day1", "ou_day3", "ou_day5", "ou_day5", "ou_day3", "ou_day5", "ou_day5"]);
        expect(privateMessages.every(item => item.text.includes("已超期"))).toBe(true);
        expect(groupMessages).toBe(0);
    });

    test("reminds only active unfinished leaf tasks and ignores completed subtrees", async () => {
        const tasks: any[] = [
            { id: "done-parent", title: "开发完成父项", status: "development_completed", source_group_id: "oc_target", primary_owner_open_id: "ou_done_parent", due_date: "2025-01-01" },
            { id: "done-child", parent_id: "done-parent", title: "父项完成后的子项", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_done_child", due_date: "2025-01-01" },
            { id: "active-parent", title: "活跃父项", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_active_parent", due_date: "2025-01-01" },
            { id: "active-child", parent_id: "active-parent", title: "活跃叶子项", status: "in_progress", source_group_id: "oc_target", primary_owner_open_id: "ou_active_child", due_date: "2025-01-01" },
            { id: "implemented", title: "已实现任务", status: "accepted", source_group_id: "oc_target", primary_owner_open_id: "ou_implemented", due_date: "2025-01-01" },
            { id: "tapd-import", title: "TAPD 直接创建的活跃任务", status: "in_progress", source_group_id: "", primary_owner_open_id: "ou_same", due_date: "2025-01-01" },
        ];
        const owners: string[] = [];
        const jobs = makeJobs({
            listTasks: async () => tasks,
            saveTask: async () => {},
            saveTaskUpdate: async () => {},
            saveBotMessageContext: async () => {},
            appendAuditLog: async () => {},
        }, {
            sendPrivateText: async (owner: string) => { owners.push(owner); return { ok: true }; },
        });

        expect(await jobs.overdueScan("oc_target", new Date("2026-07-10T10:00:00+08:00"))).toMatchObject({
            due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 2,
        });
        expect(owners).toEqual(["ou_active_child", "ou_same"]);
    });

    test("claims one reminder delivery atomically across concurrent scans", async () => {
        const idempotency = new Map<string, any>();
        let deliveries = 0;
        const task: any = {
            id: "task-concurrent",
            title: "并发提醒",
            status: "in_progress",
            primary_owner_open_id: "ou_owner",
            due_date: "2026-07-15",
        };
        const store: any = {
            claimIdempotencyKey: async (key: string, value: any) => {
                if (idempotency.has(key)) return false;
                idempotency.set(key, value);
                return true;
            },
            getIdempotencyValue: async (key: string) => idempotency.get(key) || null,
            compareAndSetIdempotencyKey: async (key: string, expected: any, next: any) => {
                if (JSON.stringify(idempotency.get(key)) !== JSON.stringify(expected)) return false;
                idempotency.set(key, next);
                return true;
            },
            saveTask: async () => {},
            saveBotMessageContext: async () => {},
            appendAuditLog: async () => {},
        };
        const jobs = makeJobs(store, {
            sendPrivateText: async () => {
                deliveries++;
                await Promise.resolve();
                return { ok: true };
            },
        });

        const outcomes = await Promise.all([
            (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:00:00+08:00"), "due_tomorrow", "2026-07-14:10:00", "请更新进展"),
            (jobs as any).sendDueReminderOnce(task, new Date("2026-07-14T10:00:00+08:00"), "due_tomorrow", "2026-07-14:10:00", "请更新进展"),
        ]);

        expect(outcomes.sort()).toEqual(["duplicate", "sent"]);
        expect(deliveries).toBe(1);
    });
});

describe("ScheduledJobs daily summary history", () => {
    test("backfills fetched human group messages before summary generation", async () => {
        const saved: any[] = [];
        const audits: any[] = [];
        const historyConfig: any = {
            ...config,
            runtime: { ...config.runtime, daily_summary_fetch_history: true },
        };
        const sourceMessage = {
            id: "om_history",
            chat_id: "oc_target",
            chat_type: "group",
            sender_open_id: "ou_same",
            sender_name: "张三",
            text: "本期功能已经完成，可以开始验收",
            message_type: "text",
            sent_at: "1784192400000",
        };
        const store = {
            getSourceMessage: async (): Promise<any> => null,
            saveSourceMessage: async (message: any): Promise<void> => { saved.push(message); },
            appendAuditLog: async (eventType: string, payload: any): Promise<void> => { audits.push({ eventType, payload }); },
        };
        const feishu = {
            fetchChatHistory: async (chatId: string): Promise<any[]> => {
                expect(chatId).toBe("oc_target");
                return [sourceMessage];
            },
        };
        const jobs = new ScheduledJobs(historyConfig, store as any, feishu as any, {} as any, {} as any);

        await jobs.backfillGroupMessagesForSummary("oc_target", new Date("2026-07-16T18:30:00+08:00"), "00:00-23:59");

        expect(saved).toEqual([sourceMessage]);
        expect(audits).toEqual([{
            eventType: "daily_summary_history_synced",
            payload: expect.objectContaining({ chat_id: "oc_target", synced: 1, inserted: 1 }),
        }]);
    });

    test("fails summary generation instead of sending an empty report when history sync fails", async () => {
        const audits: any[] = [];
        const historyConfig: any = {
            ...config,
            runtime: { ...config.runtime, daily_summary_fetch_history: true },
        };
        const jobs = new ScheduledJobs(historyConfig, {
            appendAuditLog: async (eventType: string, payload: any): Promise<void> => { audits.push({ eventType, payload }); },
        } as any, {
            fetchChatHistory: async (): Promise<any[]> => { throw new Error("permission denied"); },
        } as any, {} as any, {} as any);

        await expect(jobs.backfillGroupMessagesForSummary(
            "oc_target",
            new Date("2026-07-16T18:30:00+08:00"),
            "00:00-23:59",
        )).rejects.toThrow("日报群聊历史消息同步失败");
        expect(audits).toEqual([{
            eventType: "daily_summary_history_sync_failed",
            payload: expect.objectContaining({ chat_id: "oc_target", reason: "permission denied" }),
        }]);
    });
});

describe("ScheduledJobs group dashboard", () => {
    test("generates and sends a snapshot only to the triggering group", async () => {
        const sent: Array<{ chatId: string, text: string }> = [];
        const sentImages: Array<{ chatId: string, imageKey: string }> = [];
        let uploads = 0;
        const generatedScopes: string[][] = [];
        const dashboardConfig: any = {
            ...config,
            project: { name: "Demo Project" },
            runtime: { public_base_url: "https://example.test/dashboards" },
            groups: [
                { chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: { dashboard_enabled: true, module_dashboard_enabled: true } },
                { chat_id: "oc_product", name: "Demo 产品设计组", members: [], schedule: { dashboard_enabled: true, module_dashboard_enabled: true } },
                { chat_id: "oc_test", name: "测试群", members: [], schedule: { dashboard_enabled: false, module_dashboard_enabled: false } },
            ],
        };
        const store = {
            listTasks: async (_includeDeleted?: boolean): Promise<any[]> => [],
            saveTask: async () => {},
            appendAuditLog: async () => {},
        };
        const dashboard = {
            generateForGroup: async (group: any) => {
                generatedScopes.push([group.chat_id]);
                return {
                    id: "dashboard-project-1",
                    date: "2026-07-10",
                    html_path: "/tmp/dashboard.html",
                    stats_path: "/tmp/dashboard.json",
                    created_at: "2026-07-10T10:00:00Z",
                    public_url: "https://example.test/dashboards/dashboard.html",
                    image_path: "/tmp/dashboard.png",
                };
            },
        };
        const jobs = new ScheduledJobs(
            dashboardConfig,
            store as any,
            {
                uploadImage: async () => { uploads++; return { ok: true, image_key: "img_dashboard" }; },
                sendGroupImageKey: async (imageKey: string, chatId: string) => { sentImages.push({ imageKey, chatId }); return { ok: true }; },
                sendGroupMarkdown: async (text: string, chatId: string) => { sent.push({ text, chatId }); return { ok: true }; },
            } as any,
            dashboard as any,
            { listStories: async () => ({ ok: true, raw: { data: [] as any[] } }) } as any,
        );

        const result = await jobs.dashboardGenerate("oc_dev", new Date("2026-07-10T18:40:00+08:00"));

        expect(generatedScopes).toEqual([["oc_dev"]]);
        expect(sent.map(item => item.chatId)).toEqual(["oc_dev"]);
        expect(uploads).toBe(1);
        expect(sentImages).toEqual([
            { imageKey: "img_dashboard", chatId: "oc_dev" },
        ]);
        expect(new Set(sent.map(item => item.text)).size).toBe(1);
        expect(sent[0].text).toContain("https://example.test/dashboards/dashboard.html?groupId=oc_dev&dashboardId=dashboard-project-1");
        expect(result).toMatchObject({ artifact_id: "dashboard-project-1", subscriber_count: 1 });
    });
});
