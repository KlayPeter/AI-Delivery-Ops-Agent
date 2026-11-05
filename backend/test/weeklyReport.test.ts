import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWeeklyReportFacts } from "@/domains/weeklyReport/facts";
import { buildWeeklyNarrative } from "@/domains/weeklyReport/narrative";
import { resolveWeeklyPeriod } from "@/domains/weeklyReport/period";
import { isWeeklyReportPathAllowed, renderWeeklyReportHtml } from "@/domains/weeklyReport/renderer";
import { WeeklyReportService } from "@/domains/weeklyReport/service";
import { WeeklyReportHandler } from "@/services/messageHandler/handlers/WeeklyReportHandler";
import { TaskService } from "@/services/taskService";
import { weeklyReportManifest } from "@/agents/native/weeklyReportAgent";

afterEach(() => {
    (TaskService.syncProjectScope as any).mockRestore?.();
});

const members = [
    { open_id: "ou_zhang", name: "张三", is_active: true },
    { open_id: "ou_li", name: "李四", is_active: true },
];
const group = { chat_id: "oc_dev", name: "研发组", members, schedule: {} };
const config: any = { groups: [group], schedule: {}, runtime: { public_base_url: "https://reports.example.com" } };

function task(overrides: Record<string, any> = {}): any {
    return {
        id: "task-active",
        title: "登录模块",
        creator_open_id: "ou_zhang",
        creator_name: "张三",
        primary_owner_open_id: "ou_zhang",
        primary_owner_name: "张三",
        assignee_open_ids: ["ou_zhang"],
        assignee_names: ["张三"],
        status: "in_progress",
        priority: "P1",
        source_message_id: "",
        source_group_id: "",
        created_at: "2026-07-20T01:00:00Z",
        updated_at: "2026-07-22T01:00:00Z",
        due_date: "2026-07-23",
        trace: { tapd: { people_source: "tapd_names", status: "status_14" } },
        ...overrides,
    };
}

describe("weekly report facts and rendering", () => {
    test("resolves current and previous week in the configured timezone", () => {
        const current = resolveWeeklyPeriod("current_week", "2026-07-22T04:00:00Z", "Asia/Shanghai");
        expect(current).toMatchObject({
            start: "2026-07-20",
            end: "2026-07-22",
            business_days: ["2026-07-20", "2026-07-21", "2026-07-22"],
            is_partial: true,
        });
        const previous = resolveWeeklyPeriod("last_week", "2026-07-22T04:00:00Z", "Asia/Shanghai");
        expect(previous).toMatchObject({ start: "2026-07-13", end: "2026-07-17", is_partial: false });
    });

    test("aggregates standups, TAPD task evidence and member detail deterministically", async () => {
        const active = task();
        const completed = task({
            id: "task-done",
            title: "支付联调",
            status: "accepted",
            updated_at: "2026-07-21T09:00:00Z",
            trace: { tapd: { people_source: "tapd_names", status: "status_5", completed_at: "2026-07-21T09:00:00Z" } },
        });
        const store: any = {
            listStandups: async (date: string, groupId: string | null) =>
                groupId === "oc_dev" && date === "2026-07-20"
                    ? [{ open_id: "ou_zhang", user_name: "张三", date, yesterday_done: ["完成登录页"], today_plan: ["联调接口"], blockers: [] as string[], risks: ["测试资源不足"], decisions_needed: [] as string[], submitted_at: `${date}T01:00:00Z`, source_group_id: "oc_dev" }]
                    : [],
            listTasks: async () => [active, completed],
            listTaskUpdates: async () => [{
                id: "update-1",
                task_id: active.id,
                source: "tapd",
                created_at: "2026-07-22T02:00:00Z",
                metadata: { changes: { priority: { from: "P2", to: "P1" } } },
            }, {
                id: "update-2",
                task_id: active.id,
                source: "tapd",
                created_at: "2026-07-22T02:01:00Z",
                metadata: { changes: { status: { from: "overdue", to: "in_progress" } } },
            }, {
                id: "update-3",
                task_id: active.id,
                source: "tapd",
                created_at: "2026-07-22T02:02:00Z",
                metadata: { changes: { tapd_status: { from: "status_2", to: "status_14" } } },
            }],
        };
        const facts = await collectWeeklyReportFacts({
            config,
            store,
            group,
            period: resolveWeeklyPeriod("current_week", "2026-07-22T04:00:00Z"),
            tapdSyncedAt: "2026-07-22T04:00:01Z",
        });

        expect(facts.metrics).toMatchObject({
            active_members: 2,
            standup_expected: 6,
            standup_submitted: 1,
            new_tasks: 2,
            completed_tasks: 1,
            active_tasks: 1,
            overdue_tasks: 0,
        });
        expect(facts.members[0]).toMatchObject({ name: "张三", standup_submitted: 1, yesterday_done: ["完成登录页"] });
        expect(facts.task_changes.find(change => "priority" in change.changes)?.summary).toContain("优先级");
        expect(facts.task_changes).toHaveLength(2);
        expect(facts.task_changes.map(change => change.changes)).not.toContainEqual({ status: { from: "overdue", to: "in_progress" } });
        expect(facts.task_changes[0].changes).toEqual({ tapd_status: { from: "status_2", to: "status_14" } });
    });

    test("uses TAPD status history as the authoritative weekly state transition evidence", async () => {
        const active = task({ tapd_story_id: "100" });
        const facts = await collectWeeklyReportFacts({
            config,
            store: {
                listStandups: async (): Promise<any[]> => [],
                listTasks: async () => [active],
                listTaskUpdates: async () => [{
                    task_id: active.id,
                    source: "tapd",
                    created_at: "2026-07-22T02:00:00Z",
                    metadata: { changes: { tapd_status: { from: "status_2", to: "status_14" } } },
                }],
            },
            group,
            period: resolveWeeklyPeriod("current_week", "2026-07-22T04:00:00Z"),
            tapdSyncedAt: "2026-07-22T04:00:01Z",
            tapdStatusHistoryAvailable: true,
            tapdStatusChanges: [{
                story_id: "100",
                at: "2026-07-21 10:30:00",
                from: "规划中",
                to: "开发中",
            }],
        });

        expect(facts.tapd_status_history_available).toBe(true);
        expect(facts.task_changes).toContainEqual(expect.objectContaining({
            task_id: active.id,
            at: "2026-07-21 10:30:00",
            changes: { tapd_status: { from: "规划中", to: "开发中" } },
        }));
        expect(facts.task_changes).not.toContainEqual(expect.objectContaining({
            at: "2026-07-22T02:00:00Z",
            changes: { tapd_status: { from: "status_2", to: "status_14" } },
        }));
    });

    test("uses a safe fallback when the model returns invalid output and escapes HTML", async () => {
        const active = task({
            title: "<登录模块>",
            status: "in_progress",
            tapd_story_id: "100",
            tapd_url: "https://tapd.example.com/story/100",
            due_date: "2026-07-23",
            trace: { tapd: { begin_date: "2026-07-20", workitem_type_key: "STORY" } },
        });
        const noDates = task({
            id: "task-no-dates",
            title: "无时间任务",
            due_date: null,
            tapd_story_id: "101",
            tapd_url: "javascript:alert(1)",
            parent_id: active.tapd_story_id,
            trace: { tapd: { workitem_type: "DEVELOP" } },
        });
        const extraTasks = Array.from({ length: 7 }, (_, index) => task({
                id: `task-extra-${index + 1}`,
                title: `补充任务${index + 1}`,
                tapd_story_id: String(index + 102),
                tapd_url: `https://tapd.example.com/story/${index + 101}`,
                parent_id: index === 0 ? noDates.tapd_story_id : null,
                trace: { tapd: { workitem_type_key: index === 0 ? "ARTS" : "DEVELOP" } },
            }));
        const newTasks = [extraTasks[0], noDates, active, ...extraTasks.slice(1)];
        const changeFields = ["tapd_status", "priority", "progress", "primary_owner_name", "due_date"];
        const taskChanges = Array.from({ length: 13 }, (_, index) => {
            const field = changeFields[index % changeFields.length];
            const values: Record<string, { from: string; to: string }> = {
                tapd_status: { from: "status_2", to: "status_14" },
                priority: { from: "P2", to: "P1" },
                progress: { from: "30%", to: "65%" },
                primary_owner_name: { from: "待分配", to: "张三" },
                due_date: { from: "2026-07-22", to: "2026-07-24" },
            };
            return {
            task_id: `task-change-${index + 1}`,
            title: `流转任务${index + 1}`,
            at: "2026-07-22T02:00:00Z",
            summary: "状态变更",
            changes: { [field]: values[field] },
            };
        });
        const facts: any = {
            group: { id: "oc_dev", name: "<研发组>" },
            period: resolveWeeklyPeriod("last_week", "2026-07-22T04:00:00Z"),
            generated_at: "", tapd_synced_at: "", schema_version: 1, warnings: [],
            metrics: { active_members: 1, standup_rate: 1, completed_tasks: 0, new_tasks: 9, active_tasks: 1, blocked_tasks: 0, overdue_tasks: 0 },
            standup_days: [],
            members: [{
                open_id: "ou_zhang", name: "张三", standup_submitted: 5, standup_expected: 5,
                yesterday_done: ["完成登录页"], today_plan: ["联调接口"], blockers: [], risks: [],
                decisions_needed: [], active_tasks: [active], new_tasks: [active], completed_tasks: [],
            }],
            new_tasks: newTasks, completed_tasks: [], active_tasks: [active], blocked_tasks: [], overdue_tasks: [],
            task_changes: taskChanges,
        };
        const narrative = await buildWeeklyNarrative(facts, { chat: async () => ({ ok: true, content: "not-json" }) });
        expect(narrative.source).toBe("deterministic");
        expect(narrative.ai_degraded).toBe(true);
        expect(narrative.ai_failure_category).toBe("invalid_response");
        const html = renderWeeklyReportHtml(facts, { ...narrative, executive_summary: "<script>alert(1)</script>" });
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;登录模块&gt;");
        expect(html).toContain("成员周度统计");
        expect(html.indexOf("成员周度统计")).toBeLessThan(html.indexOf("任务概览"));
        expect(html).toContain("本周新增任务");
        expect(html).toContain("本周完成任务");
        expect(html).toContain("近期超期任务");
        expect(html).toContain("需求阶段");
        expect(html).toContain("进行中");
        expect(html).toContain("TAPD 状态");
        expect(html).toContain('href="https://tapd.example.com/story/100"');
        expect(html).toContain('target="_blank"');
        expect(html).not.toContain("javascript:alert");
        expect(html).toContain("07/20 — 07/23");
        expect(html).toContain("- — -");
        expect(html).toContain("展开其余 1 项");
        expect(html).toContain("收起任务");
        expect(html).toContain("流转任务13");
        expect(html).toContain('class="change-flow status"');
        expect(html).toContain('class="change-flow priority"');
        expect(html).toContain('class="change-flow progress"');
        expect(html).toContain('class="change-flow owner"');
        expect(html).toContain('class="change-flow date"');
        expect(html).toContain('.change-flow.progress .to{color:#087166;background:#dff6ef}');
        expect(html).toContain('<td class="person"><div class="person-inner">');
        expect(html).toContain('class="task-item has-children" style="--depth:0"');
        expect(html).toContain('class="task-item child-node has-children" style="--depth:1"');
        expect(html).toContain('class="task-item child-node" style="--depth:2"');
        expect(html).toContain('class="task-type story">STORY</span>');
        expect(html).toContain('class="task-type develop">DEVELOP</span>');
        expect(html).toContain('class="task-type arts">ARTS</span>');
        expect(html).toContain(".task-more[open] summary{order:2}");
        const taskBoardStart = html.indexOf('<div class="task-board">');
        const taskBoard = html.slice(taskBoardStart, html.indexOf('</section>\n<section', taskBoardStart));
        expect(taskBoard.indexOf("&lt;登录模块&gt;")).toBeLessThan(taskBoard.indexOf("无时间任务"));
        expect(taskBoard.indexOf("无时间任务")).toBeLessThan(taskBoard.indexOf("补充任务1"));
        expect(html).toContain("本周任务变更");
        expect(html).not.toContain("管理摘要");
        expect(html).not.toContain("每日站会统计");
        expect(taskBoard).not.toContain(">进度<");
        expect(html).not.toContain("最多展示");
        expect(html).not.toContain("按群成员聚合");
        expect(html).not.toContain("已收起");
        expect(html).toContain("AI 服务本次不可用");
        expect(html).toContain("确定性事实模板");
    });

    test("fails closed without writing a report when TAPD synchronization fails", async () => {
        spyOn(TaskService, "syncProjectScope").mockResolvedValue({ ok: false, error: "HTTP 503" } as any);
        const dataPath = mkdtempSync(join(tmpdir(), "weekly-report-"));
        const saved: any[] = [];
        try {
            const service = new WeeklyReportService(
                { ...config, data_path: dataPath },
                { saveWeeklyReport: async (value: any) => saved.push(value), appendAuditLog: async () => {} },
                {},
            );
            await expect(service.generate({ group_id: "oc_dev", period: "current_week", trigger_type: "manual" }))
                .rejects.toThrow("TAPD 数据同步失败");
            expect(saved).toHaveLength(0);
            expect(isWeeklyReportPathAllowed(dataPath, join(dataPath, "outside.html"))).toBe(false);
        } finally {
            rmSync(dataPath, { recursive: true, force: true });
        }
    });

    test("rejects every generation path when the group has daily standups disabled", async () => {
        const sync = spyOn(TaskService, "syncProjectScope").mockResolvedValue({ ok: true, fetched: 0 } as any);
        const disabledConfig = {
            ...config,
            groups: [{ ...group, schedule: { module_standup_enabled: false } }],
        };
        const service = new WeeklyReportService(disabledConfig, {}, {});

        await expect(service.generate({
            group_id: "oc_dev",
            period: "current_week",
            trigger_type: "agent",
        })).rejects.toThrow("当前群未开启日报站会");
        expect(sync).not.toHaveBeenCalled();
    });

    test("persists an immutable HTML version and returns a link-only delivery", async () => {
        spyOn(TaskService, "syncProjectScope").mockResolvedValue({ ok: true, fetched: 0 } as any);
        const dataPath = mkdtempSync(join(tmpdir(), "weekly-report-"));
        const saved: any[] = [];
        const auditLogs: any[] = [];
        let listCalls = 0;
        let saveCalls = 0;
        const historyDates: string[] = [];
        try {
            const store: any = {
                listStandups: async (): Promise<any[]> => [],
                listTasks: async (): Promise<any[]> => [],
                listTaskUpdates: async (): Promise<any[]> => [],
                listWeeklyReports: async () => (++listCalls === 1 ? [{ version: 2 }] : [{ version: 3 }]),
                saveWeeklyReport: async (report: any) => {
                    if (++saveCalls === 1) throw Object.assign(new Error("version conflict"), { code: "P2002" });
                    saved.push(structuredClone(report));
                },
                appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
            };
            const report = await new WeeklyReportService(
                { ...config, data_path: dataPath },
                store,
                {
                    listStoryStatusChanges: async (date: string) => {
                        historyDates.push(date);
                        return { ok: true, raw: { data: [] as any[] } };
                    },
                },
                { chat: async () => ({ ok: true, content: "" }) },
            ).generate({
                group_id: "oc_dev",
                period: "last_week",
                cutoff_at: "2026-07-22T04:00:00Z",
                trigger_type: "manual",
            });

            expect(report).toMatchObject({ version: 4, status: "succeeded", group_id: "oc_dev" });
            expect(historyDates).toEqual(["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"]);
            expect(report.public_url).toBe(`https://reports.example.com/api/weekly-reports/${report.id}`);
            expect(existsSync(report.html_path)).toBe(true);
            expect(saved).toHaveLength(1);
            expect(saveCalls).toBe(2);
            const delivery = WeeklyReportService.deliveryMarkdown(report);
            expect(delivery).toContain("**研发组周报**");
            expect(delivery).not.toContain("###");
            expect(delivery).toContain("查看完整可视化周报");
            expect(delivery).toContain("统计周期：2026-07-13 至 2026-07-17");
            expect(delivery).toContain("内容未经过 AI 归纳");
            expect(report.narrative.ai_degraded).toBe(true);
            expect(auditLogs).toContainEqual(expect.objectContaining({
                eventType: "ai_weekly_report_failed",
                payload: expect.objectContaining({
                    fallback: "deterministic_narrative",
                    category: "invalid_response",
                }),
            }));
            expect(delivery).not.toContain("站会提交率");
            expect(delivery).not.toContain("完成 0");
            expect(delivery).not.toContain("新增 0");
            expect(delivery).not.toContain("阻塞 0");
            expect(WeeklyReportService.deliveryMarkdown({ ...report, public_url: null })).toContain(`http://localhost:8090/api/weekly-reports/${report.id}`);
            expect(weeklyReportManifest).toMatchObject({
                id: "native.weekly-report",
                capabilities: ["summary.weekly.generate"],
                delivery: { directDelivery: false },
            });
        } finally {
            rmSync(dataPath, { recursive: true, force: true });
        }
    });
});

describe("weekly report command and TAPD history", () => {
    test("dispatches an explicit previous-week command to the Native Agent", async () => {
        const dispatched: any[] = [];
        const result = await WeeklyReportHandler.maybeHandle({
            config,
            store: { appendAuditLog: async () => {} },
            feishu: { sendReplyText: async () => ({ ok: true }) },
            agentDispatcher: {
                isAvailable: () => true,
                runManual: async (...args: any[]) => { dispatched.push(args); return { status: "completed", run_id: "run-1" }; },
            },
        } as any, {
            id: "om-weekly",
            chat_id: "oc_dev",
            text: "@机器人 生成上周周报",
            sent_at: "2026-07-22T04:00:00Z",
        } as any, "group");

        expect(result).toMatchObject({ action: "weekly_report", period: "last_week", run_id: "run-1" });
        expect(dispatched[0][0]).toBe("summary.weekly.generate");
        expect(dispatched[0][2]).toMatchObject({ groupId: "oc_dev", period: "last_week", sourceMessageId: "om-weekly" });
        expect(WeeklyReportHandler.isRequest("周报怎么配置")).toBe(false);
        expect(WeeklyReportHandler.isRequest("不要生成周报")).toBe(false);
    });

    test("does not dispatch a group command when daily standups are disabled", async () => {
        const replies: string[] = [];
        let dispatched = false;
        const result = await WeeklyReportHandler.maybeHandle({
            config: { ...config, groups: [{ ...group, schedule: { standup_push_enabled: false } }] },
            store: { appendAuditLog: async () => {} },
            feishu: { sendReplyText: async (_id: string, text: string) => { replies.push(text); return { ok: true }; } },
            agentDispatcher: {
                isAvailable: () => true,
                runManual: async () => { dispatched = true; },
            },
        } as any, {
            id: "om-weekly-disabled",
            chat_id: "oc_dev",
            text: "@机器人 生成本周周报",
            sent_at: "2026-07-22T04:00:00Z",
        } as any, "group");

        expect(result).toMatchObject({ action: "weekly_report_failed", reason: "standup_disabled" });
        expect(dispatched).toBe(false);
        expect(replies[0]).toContain("未开启日报站会");
    });

    test("records idempotent field-level changes when TAPD updates an existing task", async () => {
        const existing = task({ tapd_story_id: "1001", title: "旧标题", status: "overdue" });
        const updates: any[] = [];
        const result = await TaskService.syncProjectScope({
            config,
            tapd: {
                listStories: async () => ({ ok: true, raw: { data: [{ Story: {
                    id: "1001", name: "新标题", owner: "张三;", creator: "张三;",
                    status: "status_5", priority: "Middle", modified: "2026-07-22T03:00:00Z",
                    completed: "2026-07-22T03:00:00Z",
                } }] } }),
                storyUrl: (id: string) => `https://tapd.example/${id}`,
            },
            store: {
                listTasks: async () => [existing],
                saveTask: async () => {},
                saveTaskUpdate: async (update: any) => updates.push(update),
            },
        });

        expect(result).toMatchObject({ ok: true, updated: 1 });
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            source: "tapd",
            update_type: "tapd_sync",
            metadata: { changes: { title: { from: "旧标题", to: "新标题" }, tapd_status: { from: "status_14", to: "status_5" } } },
        });
        expect(updates[0].metadata.changes).toMatchObject({
            title: { from: "旧标题", to: "新标题" },
            tapd_status: { from: "status_14", to: "status_5" },
        });
        expect(updates[0].metadata.changes.status).toBeUndefined();
    });
});
