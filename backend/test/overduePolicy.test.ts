import { describe, expect, test } from "bun:test";
import { dueReminderSlot, overduePolicy } from "@/domains/task/overduePolicy";
import { DashboardService } from "@/services/dashboard";
import { buildDailySummary, renderDailySummary } from "@/services/summaries";

describe("overdue task policy", () => {
    test("classifies overdue tasks into 1, 3 and 5 day reminder tiers", () => {
        const reference = "2026-07-10";

        expect(overduePolicy("2026-07-09", reference)).toMatchObject({ tier: "overdue_day1", daysOverdue: 1 });
        expect(overduePolicy("2026-07-07", reference)).toMatchObject({ tier: "overdue_day3", daysOverdue: 3 });
        expect(overduePolicy("2026-07-05", reference)).toMatchObject({ tier: "overdue_day5", daysOverdue: 5 });
        expect(overduePolicy("2026-07-10", reference)).toBeNull();
    });

    test("selects only the latest reminder slot inside Beijing working hours", () => {
        const schedule = { startTime: "09:00", endTime: "18:30", timeZone: "Asia/Shanghai" };

        expect(dueReminderSlot("due_today", new Date("2026-07-10T09:30:00+08:00"), schedule)).toBeNull();
        expect(dueReminderSlot("due_today", new Date("2026-07-10T10:30:00+08:00"), schedule)).toBe("2026-07-10:10:00");
        expect(dueReminderSlot("overdue_day3", new Date("2026-07-10T15:59:00+08:00"), schedule)).toBe("2026-07-10:10:00");
        expect(dueReminderSlot("overdue_day3", new Date("2026-07-10T16:00:00+08:00"), schedule)).toBe("2026-07-10:16:00");
        expect(dueReminderSlot("overdue_day5", new Date("2026-07-10T18:30:00+08:00"), schedule)).toBe("2026-07-10:18:00");
        expect(dueReminderSlot("overdue_day5", new Date("2026-07-10T18:31:00+08:00"), schedule)).toBeNull();
    });

    test("adds overdue tiers to dashboard tasks", () => {
        const dashboard = new DashboardService({} as any, "/tmp", "Test");
        const task = (dashboard as any).enrichTask({
            id: "task-dashboard-overdue",
            title: "长期超期任务",
            status: "in_progress",
            due_date: "2026-07-05",
            primary_owner_name: "张三",
        }, "2026-07-10");

        expect(task).toMatchObject({ dashboard_status: "overdue", overdue_days: 5, overdue_tier: "overdue_day5", overdue_label: "超期 5 天以上" });
        expect((dashboard as any).taskRow(task)).toContain("data-overdue-tier='overdue_day5'");
        expect((dashboard as any).taskRow(task)).toContain("超期 5 天以上");
    });

    test("includes every date-overdue task in the daily summary even before its status is marked overdue", async () => {
        const store: any = {
            listSourceMessages: async (): Promise<any[]> => [],
            listTasks: async () => [{
                id: "task-summary-overdue",
                title: "日报中的长期超期任务",
                status: "in_progress",
                source_group_id: "oc_target",
                due_date: "2026-07-05",
                primary_owner_name: "张三",
                created_at: "2026-07-01T09:00:00+08:00",
                updated_at: "2026-07-01T09:00:00+08:00",
            }],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-10T18:30:00+08:00"));
        expect(summary.risks).toHaveLength(1);
        expect(summary.risks[0]).toMatchObject({ overdue_days: 5, overdue_tier: "overdue_day5", overdue_label: "超期 5 天以上" });
        expect(renderDailySummary(summary)).toContain("超期 5 天以上");
    });

    test("includes only active leaf overdue tasks in the daily summary", async () => {
        const store: any = {
            listSourceMessages: async (): Promise<any[]> => [],
            listTasks: async (): Promise<any[]> => [
                { id: "done-parent", title: "已完成父项", status: "development_completed", source_group_id: "oc_target", due_date: "2026-07-01", created_at: "2026-07-01T09:00:00+08:00" },
                { id: "done-child", parent_id: "done-parent", title: "完成父项子项", status: "in_progress", source_group_id: "oc_target", due_date: "2026-07-01", created_at: "2026-07-01T09:00:00+08:00" },
                { id: "active-parent", title: "活跃父项", status: "in_progress", source_group_id: "oc_target", due_date: "2026-07-01", created_at: "2026-07-01T09:00:00+08:00" },
                { id: "active-child", parent_id: "active-parent", title: "活跃超期叶子项", status: "in_progress", source_group_id: "oc_target", due_date: "2026-07-01", created_at: "2026-07-01T09:00:00+08:00" },
            ],
            listTaskUpdates: async (): Promise<any[]> => [],
        };

        const summary = await buildDailySummary(store, "oc_target", new Date("2026-07-10T18:30:00+08:00"));

        expect(summary.risks.map(item => item.title)).toEqual(["活跃超期叶子项"]);
    });
});
