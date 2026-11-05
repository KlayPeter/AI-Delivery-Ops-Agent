import { teamSchedules } from "./helpers/schedules";
import { describe, expect, test } from "bun:test";
import { InProcessScheduler } from "@/core/scheduler";
import { ScheduledAgentDispatcher } from "@/platform/bootstrap/scheduledAgentDispatcher";

describe("InProcessScheduler group dashboard", () => {
    test("preserves permanent Agent failures so the scheduler cannot retry them", async () => {
        const dispatcher = new ScheduledAgentDispatcher(() => ({ ctx: {} }) as any);
        (dispatcher as any).host = {
            dispatch: async () => ({
                status: "failed",
                claim: { error: { code: "TAPD_SYNC_TIMEOUT", message: "TAPD sync timed out", retryable: false } },
            }),
            flushDeliveries: async () => ({ delivered: 0, retried: 0, deadLettered: 0 }),
        };

        await expect(dispatcher.dailySummary("oc_dev", new Date("2026-07-10T18:30:00+08:00"))).rejects.toMatchObject({
            code: "TAPD_SYNC_TIMEOUT",
            retryable: false,
        });
    });

    test("claims scheduled deliveries with the actual flush time instead of the stale trigger time", async () => {
        const dispatcher = new ScheduledAgentDispatcher(() => ({ ctx: {} }) as any);
        let flushedAt: Date | undefined;
        (dispatcher as any).host = {
            dispatch: async () => ({ status: "completed", claim: {}, execution: { run: { id: "run-1" }, result: { data: {} } } }),
            flushDeliveries: async (now: Date) => {
                flushedAt = now;
                return { delivered: 1, retried: 0, deadLettered: 0 };
            },
        };
        const before = Date.now();

        await dispatcher.dailySummary("oc_dev", new Date("2026-07-10T18:30:00+08:00"));

        expect(flushedAt).toBeInstanceOf(Date);
        expect(flushedAt!.getTime()).toBeGreaterThanOrEqual(before);
        expect(flushedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    test("coalesces overlapping scheduler ticks into one in-flight execution", async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let configReads = 0;
        const rawConfig: any = { project: { name: "Demo Project" }, runtime: {}, schedule: {}, groups: [] };
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => {
                    configReads++;
                    await gate;
                    return rawConfig;
                },
                appendAuditLog: async () => {},
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0);

        const first = scheduler.tick(new Date("2026-07-10T09:00:00+08:00"));
        const second = scheduler.tick(new Date("2026-07-10T09:00:30+08:00"));
        release();

        expect(await Promise.all([first, second])).toEqual([{}, {}]);
        expect(configReads).toBe(1);
    });

    test("runs the task standup template at its own time when fixed standup prompts are disabled", async () => {
        const idempotency = new Map<string, any>();
        const rawConfig: any = {
            project: { name: "Demo Project" },
            runtime: {},
            schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                standup_push: "09:00",
                standup_push_enabled: false,
                task_standup_template: "10:00",
                module_standup_enabled: true,
                task_standup_enabled: true,
                overdue_scan: "09:00",
                overdue_scan_end: "18:30",
                overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai",
                overdue_scan_enabled: false,
                workdays_only: false,
            } }],
        };
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                listTasks: async (): Promise<any[]> => [],
                claimIdempotencyKey: async (key: string, value: any) => {
                    if (idempotency.has(key)) return false;
                    idempotency.set(key, value);
                    return true;
                },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async () => {},
            },
            feishu: {},
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        const runs: string[] = [];
        scheduler.runJob = async (_handler: any, jobName: string) => {
            runs.push(jobName);
            return { ok: true };
        };

        expect(await scheduler.tick(new Date(2026, 7, 13, 9, 0, 0))).toEqual({});
        expect(await scheduler.tick(new Date(2026, 7, 13, 10, 0, 0))).toEqual({ "task-standup-template:oc_dev": "completed" });
        expect(runs).toEqual(["task-standup-template"]);
    });

    test("runs overdue scans every 30 minutes only in the Beijing working window", async () => {
        const idempotency = new Map<string, any>();
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                overdue_scan: "09:00", overdue_scan_end: "18:30", overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai", overdue_scan_enabled: true, workdays_only: false,
            } }],
        };
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => { if (idempotency.has(key)) return false; idempotency.set(key, value); return true; },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async () => {},
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        const runs: Date[] = [];
        scheduler.runJob = async (_handler: any, _jobName: string, _groupId: string, day: Date) => { runs.push(day); return { ok: true }; };

        expect(await scheduler.tick(new Date("2026-07-10T08:30:00+08:00"))).toEqual({});
        expect(await scheduler.tick(new Date("2026-07-10T09:00:00+08:00"))).toEqual({ "overdue-scan:oc_dev": "completed" });
        expect(await scheduler.tick(new Date("2026-07-10T09:00:30+08:00"))).toEqual({});
        expect(await scheduler.tick(new Date("2026-07-10T09:30:00+08:00"))).toEqual({ "overdue-scan:oc_dev": "completed" });
        expect(await scheduler.tick(new Date("2026-07-10T18:30:00+08:00"))).toEqual({ "overdue-scan:oc_dev": "completed" });
        expect(await scheduler.tick(new Date("2026-07-10T19:00:00+08:00"))).toEqual({});
        expect(runs).toHaveLength(3);
        expect(idempotency.has("scheduled:overdue-scan:oc_dev:2026-07-10:09:00")).toBe(true);
        expect(idempotency.has("scheduled:overdue-scan:oc_dev:2026-07-10:09:30")).toBe(true);
        expect(idempotency.has("scheduled:overdue-scan:oc_dev:2026-07-10:18:30")).toBe(true);
    });

    test("shares one TAPD project sync across same-tick overdue scans for multiple groups", async () => {
        const idempotency = new Map<string, any>();
        let tapdSyncs = 0;
        const schedule = {
            overdue_scan: "09:00",
            overdue_scan_end: "18:30",
            overdue_scan_interval_minutes: 30,
            overdue_scan_timezone: "Asia/Shanghai",
            overdue_scan_enabled: true,
            workdays_only: false,
        };
        const rawConfig: any = {
            project: { name: "Demo Project" },
            runtime: { public_base_url: "" },
            schedule: { workdays_only: false },
            groups: [
                { chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule },
                { chat_id: "oc_product", name: "Demo 产品设计组", members: [], schedule },
            ],
        };
        const ctx: any = {
            config: rawConfig,
            feishu: {},
            tapd: {
                listStories: async () => {
                    tapdSyncs++;
                    return { ok: true, raw: { data: [] as any[] } };
                },
            },
            store: {
                getDynamicConfig: async () => rawConfig,
                listTasks: async (): Promise<any[]> => [],
                saveTask: async () => {},
                claimIdempotencyKey: async (key: string, value: any) => {
                    if (idempotency.has(key)) return false;
                    idempotency.set(key, value);
                    return true;
                },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async () => {},
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0);

        expect(await scheduler.tick(new Date("2026-07-10T09:00:00+08:00"))).toEqual({
            "overdue-scan:oc_dev": "completed",
            "overdue-scan:oc_product": "completed",
        });
        expect(tapdSyncs).toBe(1);
    });

    test("records overdue delivery warnings instead of reporting a clean completion", async () => {
        const idempotency = new Map<string, any>();
        const audits: any[] = [];
        const rawConfig: any = {
            project: { name: "Demo Project" },
            runtime: { public_base_url: "" },
            schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                overdue_scan: "09:00", overdue_scan_end: "18:30", overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai", overdue_scan_enabled: true, workdays_only: false,
            } }],
        };
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => {
                    if (idempotency.has(key)) return false;
                    idempotency.set(key, value);
                    return true;
                },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async (eventType: string, detail: any) => audits.push({ eventType, detail }),
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        scheduler.runJob = async () => ({ status: "completed_with_warnings", delivery: { skipped: 1 } });

        expect(await scheduler.tick(new Date("2026-07-10T09:00:00+08:00"))).toEqual({
            "overdue-scan:oc_dev": "completed_with_warnings",
        });
        expect(audits.some(item => item.eventType === "job_completed_with_warnings")).toBe(true);
        expect(idempotency.get("scheduled:overdue-scan:oc_dev:2026-07-10:09:00").status).toBe("completed_with_warnings");
    });

    test("does not run overdue scans on non-workdays when workdays_only is enabled", async () => {
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: true },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                overdue_scan: "09:00", overdue_scan_end: "18:30", overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai", overdue_scan_enabled: true, workdays_only: true,
            } }],
        };
        const ctx: any = {
            config: rawConfig,
            store: { getDynamicConfig: async () => rawConfig, appendAuditLog: async () => {} },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        let runs = 0;
        scheduler.runJob = async () => { runs++; return { ok: true }; };

        expect(await scheduler.tick(new Date("2026-07-11T10:00:00+08:00"))).toEqual({});
        expect(runs).toBe(0);
    });

    test("does not run overdue scans when a group's overdue reminder switch is disabled", async () => {
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_test", name: "测试群", members: [], schedule: {
                overdue_scan: "09:00", overdue_scan_end: "18:30", overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai", overdue_scan_enabled: false, workdays_only: false,
            } }],
        };
        const ctx: any = {
            config: rawConfig,
            store: { getDynamicConfig: async () => rawConfig, appendAuditLog: async () => {} },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        let runs = 0;
        scheduler.runJob = async () => { runs++; return { ok: true }; };

        expect(await scheduler.tick(new Date("2026-07-10T09:00:00+08:00"))).toEqual({});
        expect(runs).toBe(0);
    });

    test("runs standup supplement summary one hour after the main summary", async () => {
        const idempotency = new Map<string, any>();
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: { standup_summary: "18:40", standup_summary_enabled: true, module_standup_enabled: true, workdays_only: false } }],
        };
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => { if (idempotency.has(key)) return false; idempotency.set(key, value); return true; },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async () => {},
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        const runs: string[] = [];
        scheduler.runJob = async (_handler: any, jobName: string) => { runs.push(jobName); return { ok: true }; };

        expect(await scheduler.tick(new Date(2026, 6, 10, 19, 40, 0))).toEqual({ "standup-supplement-summary:oc_dev": "completed" });
        expect(runs).toEqual(["standup-supplement-summary"]);
        expect(idempotency.has("scheduled:standup-supplement-summary:oc_dev:2026-07-10:19:40")).toBe(true);
    });

    test("runs one independent snapshot per group when schedules match", async () => {
        const idempotency = new Map<string, any>();
        const rawConfig = {
            project: { name: "Demo Project" },
            runtime: { data_dir: "test_data", public_base_url: "" },
            schedule: { workdays_only: false },
            groups: [
                { chat_id: "oc_dev", name: "Demo 研发组", members: [] as any[], schedule: { dashboard: "18:40", dashboard_enabled: true, module_dashboard_enabled: true, workdays_only: false } },
                { chat_id: "oc_product", name: "Demo 产品设计组", members: [] as any[], schedule: { dashboard: "18:40", dashboard_enabled: true, module_dashboard_enabled: true, workdays_only: false } },
            ],
        };
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => {
                    if (idempotency.has(key)) return false;
                    idempotency.set(key, value);
                    return true;
                },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async () => {},
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0) as any;
        let runs = 0;
        scheduler.runJob = async (_handler: any, jobName: string) => {
            if (jobName === "dashboard") runs++;
            return { artifact_id: "snapshot-1" };
        };

        const first = await scheduler.tick(new Date(2026, 6, 10, 18, 40, 0));
        const second = await scheduler.tick(new Date(2026, 6, 10, 18, 40, 30));

        expect(first).toEqual({ "dashboard:oc_dev": "completed", "dashboard:oc_product": "completed" });
        expect(second).toEqual({});
        expect(runs).toBe(2);
        expect(idempotency.has("scheduled:dashboard:oc_dev:2026-07-10:18:40")).toBe(true);
        expect(idempotency.has("scheduled:dashboard:oc_product:2026-07-10:18:40")).toBe(true);
        expect(idempotency.get("scheduled:dashboard:oc_dev:2026-07-10:18:40").status).toBe("completed");
    });

    test("lets the Agent trigger store own daily-summary idempotency", async () => {
        const idempotency = new Map<string, any>();
        const audits: Array<{ eventType: string; detail: any }> = [];
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: { daily_summary: "18:40", daily_summary_enabled: true, module_daily_summary_enabled: true, workdays_only: false } }],
        };
        const ctx: any = {
            config: rawConfig, feishu: {}, tapd: {}, intentParser: {},
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => { if (idempotency.has(key)) return false; idempotency.set(key, value); return true; },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async (eventType: string, detail: any) => { audits.push({ eventType, detail }); },
            },
        };
        let dispatches = 0; let flushes = 0;
        const agentJobs: any = {
            flushDeliveries: async () => { flushes++; return { delivered: 0, retried: 0, deadLettered: 0 }; },
            dailySummary: async () => { dispatches++; return { status: dispatches === 1 ? 'completed' : 'duplicate' }; },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0, agentJobs);
        expect(await scheduler.tick(new Date(2026, 6, 10, 18, 40, 0))).toEqual({ "daily-summary:oc_dev": "completed" });
        expect(await scheduler.tick(new Date(2026, 6, 10, 18, 40, 30))).toEqual({ "daily-summary:oc_dev": "duplicate" });
        expect(dispatches).toBe(2); expect(flushes).toBe(2);
        expect(audits.filter(item => item.eventType === "job_completed")).toHaveLength(1);
        expect(audits.filter(item => item.eventType === "job_duplicate_skipped")).toHaveLength(1);
        expect(idempotency.has("scheduled:daily-summary:oc_dev:2026-07-10:18:40")).toBe(false);
    });

    test("runs the weekly report Agent only on Friday in the configured timezone", async () => {
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: true },
            groups: [
                { chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                    weekly_report: "18:50",
                    weekly_report_enabled: true,
                    weekly_report_timezone: "Asia/Shanghai",
                    module_weekly_report_enabled: true,
                    module_standup_enabled: true,
                    standup_push_enabled: true,
                    workdays_only: true,
                } },
                { chat_id: "oc_no_standup", name: "No Standup", members: [], schedule: {
                    weekly_report: "18:50",
                    weekly_report_enabled: true,
                    weekly_report_timezone: "Asia/Shanghai",
                    module_weekly_report_enabled: true,
                    module_standup_enabled: false,
                    workdays_only: true,
                } },
            ],
        };
        const ctx: any = {
            config: rawConfig, feishu: {}, tapd: {}, intentParser: {},
            store: { getDynamicConfig: async () => rawConfig, appendAuditLog: async () => {} },
        };
        let dispatches = 0;
        const agentJobs: any = {
            flushDeliveries: async () => ({ delivered: 0, retried: 0, deadLettered: 0 }),
            weeklyReport: async () => { dispatches++; return { status: "completed" }; },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0, agentJobs);

        expect(await scheduler.tick(new Date("2026-07-23T10:50:00Z"))).toEqual({});
        expect(await scheduler.tick(new Date("2026-07-24T10:50:00Z"))).toEqual({ "weekly-report:oc_dev": "completed" });
        expect(dispatches).toBe(1);
    });

    test("runs an enabled legacy daily summary even when its later-added module switch was saved as off", async () => {
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: { daily_summary: "18:40", daily_summary_enabled: true, module_daily_summary_enabled: false, workdays_only: false } }],
        };
        const ctx: any = {
            config: rawConfig, feishu: {}, tapd: {}, intentParser: {},
            store: { getDynamicConfig: async () => rawConfig, appendAuditLog: async () => {} },
        };
        let dispatches = 0;
        const agentJobs: any = {
            flushDeliveries: async () => ({ delivered: 0, retried: 0, deadLettered: 0 }),
            dailySummary: async () => { dispatches++; return { status: "completed" }; },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0, agentJobs);

        expect(await scheduler.tick(new Date(2026, 6, 10, 18, 40, 0))).toEqual({ "daily-summary:oc_dev": "completed" });
        expect(dispatches).toBe(1);
    });

    test("retries every failed scheduled job once with a separate Agent trigger attempt", async () => {
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: { daily_summary: "18:40", daily_summary_enabled: true, module_daily_summary_enabled: true, workdays_only: false } }],
        };
        const auditLogs: any[] = [];
        const ctx: any = {
            config: rawConfig, feishu: {}, tapd: {}, intentParser: {},
            store: {
                getDynamicConfig: async () => rawConfig,
                appendAuditLog: async (eventType: string, detail: any) => auditLogs.push({ eventType, detail }),
            },
        };
        const attempts: number[] = [];
        const agentJobs: any = {
            flushDeliveries: async () => ({ delivered: 0, retried: 0, deadLettered: 0 }),
            dailySummary: async (_groupId: string, _day: Date, retryAttempt: number) => {
                attempts.push(retryAttempt);
                if (retryAttempt === 0) throw new Error("Agent execution timed out");
                return { status: "completed" };
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0, agentJobs, 0);

        expect(await scheduler.tick(new Date(2026, 6, 10, 18, 40, 0))).toEqual({ "daily-summary:oc_dev": "completed" });
        expect(attempts).toEqual([0, 1]);
        expect(auditLogs.some(item => item.eventType === "job_retrying" && item.detail.attempt === 2)).toBe(true);
        expect(auditLogs.some(item => item.eventType === "job_retry_succeeded" && item.detail.attempts === 2)).toBe(true);
        expect(auditLogs.some(item => item.eventType === "job_completed" && item.detail.attempts === 2)).toBe(true);
    });

    test("marks a scheduled job failed only after the retry also fails", async () => {
        const idempotency = new Map<string, any>();
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { data_dir: "test_data", public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                overdue_scan: "18:00", overdue_scan_end: "18:30", overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai", overdue_scan_enabled: true, workdays_only: false,
            } }],
        };
        const auditLogs: any[] = [];
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => { idempotency.set(key, value); return true; },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async (eventType: string, detail: any) => auditLogs.push({ eventType, detail }),
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0, undefined, 0) as any;
        let runs = 0;
        scheduler.runJob = async () => { runs++; throw new Error(`failure-${runs}`); };

        expect(await scheduler.tick(new Date("2026-07-10T18:00:00+08:00"))).toEqual({ "overdue-scan:oc_dev": "failed" });
        expect(runs).toBe(2);
        expect(auditLogs.some(item => item.eventType === "job_failed" && item.detail.attempts === 2 && item.detail.first_error === "failure-1")).toBe(true);
        expect(idempotency.get("scheduled:overdue-scan:oc_dev:2026-07-10:18:00").status).toBe("failed");
    });

    test("does not retry a scheduled job after a permanent provider failure", async () => {
        const idempotency = new Map<string, any>();
        const rawConfig: any = {
            project: { name: "Demo Project" }, runtime: { data_dir: "test_data", public_base_url: "" }, schedule: { workdays_only: false },
            groups: [{ chat_id: "oc_dev", name: "Demo 研发组", members: [], schedule: {
                overdue_scan: "18:00", overdue_scan_end: "18:30", overdue_scan_interval_minutes: 30,
                overdue_scan_timezone: "Asia/Shanghai", overdue_scan_enabled: true, workdays_only: false,
            } }],
        };
        const auditLogs: any[] = [];
        const ctx: any = {
            config: rawConfig,
            store: {
                getDynamicConfig: async () => rawConfig,
                claimIdempotencyKey: async (key: string, value: any) => { idempotency.set(key, value); return true; },
                setIdempotencyKey: async (key: string, value: any) => idempotency.set(key, value),
                appendAuditLog: async (eventType: string, detail: any) => auditLogs.push({ eventType, detail }),
            },
        };
        ctx.schedules = teamSchedules();
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0, undefined, 0) as any;
        let runs = 0;
        scheduler.runJob = async () => {
            runs++;
            throw Object.assign(new Error('monthly quota exhausted'), { retryable: false, code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED' });
        };

        expect(await scheduler.tick(new Date("2026-07-10T18:00:00+08:00"))).toEqual({ "overdue-scan:oc_dev": "failed" });
        expect(runs).toBe(1);
        expect(auditLogs.some(item => item.eventType === "job_retrying")).toBe(false);
        expect(auditLogs.some(item => item.eventType === "job_failed" && item.detail.attempts === 1)).toBe(true);
    });
});
