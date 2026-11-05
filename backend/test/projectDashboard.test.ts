import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardService } from "@/services/dashboard";
import { ProjectDashboardService } from "@/services/projectDashboard";
import { taskBelongsToMembers, taskReminderGroupId } from "@/services/taskScope";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectConfig() {
    return {
        project: { name: "Demo Project" },
        runtime: { public_base_url: "https://example.test/dashboards" },
        groups: [
            {
                chat_id: "oc_dev",
                name: "Demo 研发组",
                members: [{ open_id: "ou_dev", name: "开发", is_active: true }],
                schedule: { dashboard_enabled: true, module_dashboard_enabled: true },
            },
            {
                chat_id: "oc_product",
                name: "Demo 产品设计组",
                members: [{ open_id: "ou_product", name: "产品", is_active: true }],
                schedule: { dashboard_enabled: true, module_dashboard_enabled: true },
            },
            {
                chat_id: "oc_test",
                name: "测试群",
                members: [{ open_id: "ou_test", name: "测试", is_active: true }],
                schedule: { dashboard_enabled: false, module_dashboard_enabled: false },
            },
        ],
    } as any;
}

describe("ProjectDashboardService", () => {
    test("fails closed and does not generate a snapshot when project sync fails", async () => {
        let generated = 0;
        const service = new ProjectDashboardService({
            config: projectConfig(),
            store: { listTasks: async (): Promise<any[]> => [], saveTask: async () => {} },
            tapd: { listStories: async () => ({ ok: false, error: "TAPD unavailable" }) },
            dashboard: { generateForGroup: async () => { generated++; } },
        } as any);

        await expect(service.generateFresh(new Date("2026-07-10T10:00:00+08:00"), "manual", "oc_dev"))
            .rejects.toThrow("TAPD unavailable");
        expect(generated).toBe(0);
    });

    test("syncs once and generates a snapshot only for the requested group", async () => {
        const events: string[] = [];
        const service = new ProjectDashboardService({
            config: projectConfig(),
            store: {
                listTasks: async (): Promise<any[]> => [],
                saveTask: async () => {},
                appendAuditLog: async () => {},
            },
            tapd: {
                listStories: async () => {
                    events.push("sync");
                    return { ok: true, raw: { data: [] as any[] } };
                },
            },
            dashboard: {
                generateForGroup: async (group: any) => {
                    events.push(`generate:${group.chat_id}`);
                    return { id: "snapshot-1", date: "2026-07-10", html_path: "/tmp/a.html", stats_path: "/tmp/a.json", created_at: "2026-07-10T02:00:00Z" };
                },
            },
            renderer: {
                render: async (htmlPath: string) => {
                    events.push(`render:${htmlPath}`);
                    return "/tmp/a.png";
                },
            },
        } as any);

        const result = await service.generateFresh(new Date("2026-07-10T10:00:00+08:00"), "manual", "oc_dev");

        expect(events).toEqual(["sync", "generate:oc_dev", "render:/tmp/a.html"]);
        expect(result.artifact.id).toBe("snapshot-1");
        expect(result.artifact.image_path).toBe("/tmp/a.png");
        expect(result.subscribers.map((g: any) => g.chat_id)).toEqual(["oc_dev"]);
    });

    test("returns an immutable historical snapshot instead of regenerating current data", async () => {
        let generated = 0;
        const service = new ProjectDashboardService({
            config: projectConfig(),
            store: {
                listDashboardArtifacts: async (date: string) => date === "2026-07-07" ? [{
                    id: "dashboard-oc_dev-2026-07-07-history",
                    date,
                    html_path: "/tmp/history.html",
                    stats_path: "/tmp/history.json",
                    created_at: "2026-07-07T10:00:00Z",
                }] : [],
            },
            tapd: {},
            dashboard: { generateForGroup: async () => { generated++; } },
        } as any);

        const artifact = await service.findHistoricalSnapshot("2026-07-07", "oc_dev");

        expect(artifact?.id).toBe("dashboard-oc_dev-2026-07-07-history");
        expect(generated).toBe(0);
    });
});

describe("DashboardService group snapshot scope", () => {
    test("matches TAPD handlers by authoritative names when a derived Feishu open id is stale", () => {
        const members = [{ open_id: "ou_current", name: "陈项目", is_active: true }] as any;
        const tapdTask = {
            status: "in_progress",
            primary_owner_open_id: "ou_stale",
            primary_owner_name: "陈项目",
            assignee_open_ids: ["ou_stale"],
            assignee_names: ["陈项目"],
            trace: { tapd: { source: "project_sync", people_source: "tapd_names" } },
        } as any;
        const localTask = { ...tapdTask, trace: {}, source_group_id: "" };

        expect(taskBelongsToMembers(tapdTask, members)).toBe(true);
        expect(taskBelongsToMembers(localTask, members)).toBe(false);
    });

    test("selects one deterministic reminder group and prefers the owner's smallest team", () => {
        const groups: any[] = [
            { chat_id: "oc_company", members: [
                { open_id: "ou_owner", name: "负责人", is_active: true },
                { open_id: "ou_creator", name: "创建人", is_active: true },
                { open_id: "ou_other", name: "其他人", is_active: true },
            ] },
            { chat_id: "oc_owner_team", members: [{ open_id: "ou_owner", name: "负责人", is_active: true }] },
            { chat_id: "oc_creator_team", members: [{ open_id: "ou_creator", name: "创建人", is_active: true }] },
        ];
        const task: any = {
            status: "in_progress",
            creator_open_id: "ou_creator",
            primary_owner_open_id: "ou_owner",
            assignee_open_ids: ["ou_owner"],
        };

        expect(taskReminderGroupId(task, groups)).toBe("oc_owner_team");
        expect(taskReminderGroupId({ ...task, source_group_id: "oc_company" }, groups)).toBe("oc_company");
    });

    test("sorts unfinished roots and siblings before completed work", () => {
        const dashboard = new DashboardService({} as any, ".", "Demo Project");
        const ordered = (dashboard as any).sortTaskTree([
            { id: "done-root", status: "development_completed", dashboard_status: "development_completed", effective_completed: true, priority: "P0", due_date: "2026-01-01" },
            { id: "active-root", status: "requirement", dashboard_status: "requirement", effective_completed: false, priority: "P3" },
            { id: "done-child", parent_id: "active-root", status: "accepted", dashboard_status: "accepted", effective_completed: true, priority: "P0", due_date: "2026-01-01" },
            { id: "active-child", parent_id: "active-root", status: "requirement", dashboard_status: "requirement", effective_completed: false, priority: "P3" },
        ]);

        expect(ordered.map((task: any) => task.id)).toEqual([
            "active-root",
            "active-child",
            "done-child",
            "done-root",
        ]);
    });

    test("labels unassigned work explicitly instead of calling it generic high risk", () => {
        const dashboard = new DashboardService({} as any, ".", "Demo Project");
        const risks = (dashboard as any).buildRisks([{
            title: "待分配任务",
            primary_owner_name: "",
            workload_eligible: true,
            risk_level: "high",
            risk_label: "高",
            dashboard_status: "requirement",
        }], []);

        expect(risks).toEqual([{
            title: "待分配任务",
            owner: "",
            impact: "未分配负责人",
            action: "请尽快分配主负责人",
        }]);
    });

    test("counts active TAPD story, develop, and art assignments including parent work items", () => {
        const dashboard = new DashboardService({} as any, ".", "Demo Project");
        const members = new Map([["ou_dev", { open_id: "ou_dev", name: "陈项目" }]]);
        const workload = (dashboard as any).buildWorkload([
            { title: "草案需求父项", assignment_eligible: true, workload_eligible: false, primary_owner_open_id: "ou_dev", primary_owner_name: "陈项目", assignee_open_ids: ["ou_dev"], assignee_names: ["陈项目"], trace: { tapd: { workitem_type: "STORY" } }, effort_days: null },
            { title: "开发子项", assignment_eligible: true, workload_eligible: true, primary_owner_open_id: "ou_dev", primary_owner_name: "陈项目", assignee_open_ids: ["ou_dev"], assignee_names: ["陈项目"], trace: { tapd: { workitem_type: "DEVELOP" } }, effort_days: null },
            { title: "美术工作项", assignment_eligible: true, workload_eligible: true, primary_owner_open_id: "ou_dev", primary_owner_name: "陈项目", assignee_open_ids: ["ou_dev"], assignee_names: ["陈项目"], trace: { tapd: { workitem_type: "ARTS" } }, effort_days: 1.5 },
            { title: "已完成工作项", assignment_eligible: false, workload_eligible: false, primary_owner_open_id: "ou_dev", primary_owner_name: "陈项目", assignee_open_ids: ["ou_dev"], assignee_names: ["陈项目"], effort_days: 2 },
        ], members);

        expect(workload).toEqual([{
            open_id: "ou_dev",
            name: "陈项目",
            task_count: 3,
            requirement_tasks: 1,
            development_tasks: 2,
            testing_tasks: 0,
            estimated_days: 1.5,
            unestimated_tasks: 2,
        }]);
    });

    test("moves self-assigned work from development to testing after transfer", () => {
        const dashboard = new DashboardService({} as any, ".", "Demo Project");
        const members = new Map([
            ["ou_product", { open_id: "ou_product", name: "产品" }],
            ["ou_dev", { open_id: "ou_dev", name: "开发" }],
        ]);
        const workload = (dashboard as any).buildWorkload([
            {
                title: "需求方案",
                status: "requirement",
                assignment_eligible: true,
                trace: { workflow: { phase: "requirement", roles: { product: { open_id: "ou_product", name: "产品" } } } },
                effort_days: null,
            },
            {
                title: "开发实现",
                status: "in_progress",
                assignment_eligible: true,
                trace: { workflow: { phase: "development", roles: { developer: { open_id: "ou_dev", name: "开发" } } } },
                effort_days: 2,
            },
            {
                title: "自己转给自己测试",
                status: "owner_marked_done",
                assignment_eligible: true,
                trace: { workflow: { phase: "transfer_test", roles: {
                    developer: { open_id: "ou_dev", name: "开发" },
                    tester: { open_id: "ou_dev", name: "开发" },
                } } },
                effort_days: 1,
            },
            {
                title: "TAPD 已进入测试但本地流程滞后",
                status: "testing",
                assignment_eligible: true,
                primary_owner_open_id: "ou_dev",
                primary_owner_name: "开发",
                assignee_open_ids: ["ou_dev"],
                assignee_names: ["开发"],
                trace: { workflow: { phase: "development", roles: { developer: { open_id: "ou_dev", name: "开发" } } } },
                effort_days: null,
            },
        ], members);

        expect(workload).toEqual([
            {
                open_id: "ou_dev",
                name: "开发",
                task_count: 3,
                requirement_tasks: 0,
                development_tasks: 1,
                testing_tasks: 2,
                estimated_days: 3,
                unestimated_tasks: 1,
            },
            {
                open_id: "ou_product",
                name: "产品",
                task_count: 1,
                requirement_tasks: 1,
                development_tasks: 0,
                testing_tasks: 0,
                estimated_days: 0,
                unestimated_tasks: 1,
            },
        ]);
    });

    test("includes active tasks when creator or developer belongs to the requested group", async () => {
        const dir = mkdtempSync(join(tmpdir(), "project-dashboard-"));
        tempDirs.push(dir);
        const saved: any[] = [];
        const store = {
            listTasks: async () => [
                { id: "tapd-manual", title: "TAPD 手工任务", tapd_story_id: "1", source_group_id: "", status: "in_progress", priority: "P1", primary_owner_open_id: "ou_product", primary_owner_name: "产品", assignee_names: ["产品"], due_date: "2026-07-11", trace: { tapd: { begin_date: "2026-07-08", effort_days: 2.5 } }, created_at: "2026-07-08T01:00:00Z", updated_at: "2026-07-10T01:00:00Z" },
                { id: "tapd-created-by-dev", title: "开发创建的 TAPD 任务", tapd_story_id: "2", source_group_id: "", status: "in_progress", priority: "P1", creator_open_id: "ou_dev", creator_name: "开发", primary_owner_open_id: "ou_external", primary_owner_name: "外部人员", assignee_names: ["外部人员"], due_date: "2026-07-10", created_at: "2026-07-08T01:00:00Z", updated_at: "2026-07-10T01:00:00Z" },
                { id: "same-name-outsider", title: "同名外部人员任务", tapd_story_id: "3", source_group_id: "", status: "in_progress", priority: "P2", creator_open_id: "ou_external", creator_name: "外部", primary_owner_open_id: "ou_other_dev", primary_owner_name: "开发", assignee_open_ids: ["ou_other_dev"], assignee_names: ["开发"], created_at: "2026-07-10T01:00:00Z", updated_at: "2026-07-10T01:00:00Z" },
                { id: "local-dev", title: "群内独立任务", source_group_id: "oc_dev", status: "pending_confirmation", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_names: ["开发"], due_date: "2026-07-09", trace: { tapd: { effort_days: 2.5 } }, created_at: "2026-07-10T01:00:00Z", updated_at: "2026-07-10T01:00:00Z" },
                { id: "old-active", title: "三个月前仍活跃的任务", source_group_id: "oc_dev", status: "in_progress", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_names: ["开发"], due_date: "2025-12-31", created_at: "2025-12-01T01:00:00Z", updated_at: "2025-12-01T01:00:00Z" },
                { id: "local-test", title: "测试群独立任务", source_group_id: "oc_test", status: "in_progress", priority: "P2", assignee_names: [] as string[], created_at: "2026-07-10T01:00:00Z", updated_at: "2026-07-10T01:00:00Z" },
                { id: "deleted", title: "已删除任务", tapd_story_id: "4", status: "deleted", priority: "P2", assignee_names: [] as string[], created_at: "2026-07-10T01:00:00Z", updated_at: "2026-07-10T01:00:00Z" },
            ],
            listStandups: async (_date: string, groupId: string): Promise<any[]> => groupId === "oc_dev" ? [{
                open_id: "ou_dev",
                user_name: "开发",
                yesterday_done: ["完成接口设计"],
                today_plan: ["联调核心流程"],
                blockers: ["等待测试环境"],
                risks: ["联调可能延期"],
                decisions_needed: ["确认上线窗口"],
            }] : [],
            listTaskUpdates: async (): Promise<any[]> => [{ id: "update-1", task_id: "local-dev", user_name: "开发", content: "接口联调中", created_at: "2026-07-10T02:00:00Z" }],
            saveDashboardArtifact: async (artifact: any) => saved.push(artifact),
        };
        const dashboard = new DashboardService(store as any, dir, "Demo Project", "https://example.test/dashboards");
        const group = projectConfig().groups[0];

        const artifact = await dashboard.generateForGroup(group, new Date("2026-07-10T10:00:00+08:00"));
        const data = JSON.parse(readFileSync(artifact.stats_path, "utf8"));

        expect(data.tasks.map((task: any) => task.id).sort()).toEqual(["local-dev", "old-active", "tapd-created-by-dev"]);
        expect(data.stats.total_tasks).toBe(3);
        expect(data.stats.overdue).toBe(2);
        expect(data.stats.standup_submit_rate).toBe(1);
        expect(data.data_health).toBeUndefined();
        expect(data.status_distribution).toHaveLength(8);
        expect(data.status_distribution.find((item: any) => item.status === "overdue").count).toBe(2);
        expect(data.tasks.find((task: any) => task.id === "local-dev")).toMatchObject({
            dashboard_status: "overdue",
            latest_update: "接口联调中",
            risk_level: "high",
        });
        expect(data.burndown.points).toHaveLength(7);
        expect(data.burndown).toMatchObject({ start: "2026-07-04", end: "2026-07-10" });
        expect(data.burndown.points.every((point: any) => point.remaining !== null)).toBe(true);
        expect(data.burndown.points.every((point: any) => point.ideal === undefined)).toBe(true);
        expect(data.workload).toEqual([{
            open_id: "ou_dev",
            name: "开发",
            task_count: 2,
            requirement_tasks: 1,
            development_tasks: 1,
            testing_tasks: 0,
            estimated_days: 2.5,
            unestimated_tasks: 1,
        }]);
        expect(data.month_calendar).toMatchObject({ anchor_month: "2026-07", undated_count: 0 });
        expect(data.month_calendar.tasks).toHaveLength(3);
        expect(data.standup_summary).toMatchObject({
            submitted: 1,
            total_members: 1,
            missing: 0,
            missing_names: [],
            team_focus: [{ name: "开发", text: "联调核心流程" }],
            blocker_entries: [{ name: "开发", text: "等待测试环境" }],
            risk_entries: [{ name: "开发", text: "联调可能延期" }],
            decision_entries: [{ name: "开发", text: "确认上线窗口" }],
        });
        const html = readFileSync(artifact.html_path, "utf8");
        expect(html).toContain("近 7 天未完成任务趋势");
        expect(html).not.toContain("理想燃尽线");
        expect(html).toContain("群成员任务负载");
        expect(html).toContain("需求 1 · 开发 1 · 测试 0");
        expect(html).toContain("按当前责任阶段 · 需求 / 开发 / 测试");
        expect(html).toContain("任务筛选");
        expect(html).toContain('class="subtitle"><strong>2026-07-10</strong>');
        expect(html).toContain('font-size:18px');
        expect(html).toContain('priority-pill priority-p1');
        expect(html).not.toContain("数据口径");
        expect(html).toContain("月度任务区间");
        expect(html).toContain("← 上月");
        expect(html).toContain("下月 →");
        expect(html).toContain('id="calendar-prev"');
        expect(html).toContain('id="task-person-filter"');
        expect(html).toContain('id="task-status-filter"');
        expect(html).toContain('id="task-priority-filter"');
        expect(html).toContain('id="task-risk-filter"');
        expect(html).toContain('id="task-time-filter"');
        expect(html).not.toContain('data-sort="priority"');
        expect(html).toContain('父子树展示');
        expect(html).toContain('<th>创建人</th>');
        expect(html).toContain('placeholder="查询创建人 / 负责人 / 参与人"');
        expect(html).toContain("data-people='开发、外部人员'");
        expect(html).toContain("pageSize = 20");
        expect(html).toContain('id="risk-page-input"');
        expect(html).toContain('id="task-page-input"');
        expect(html).toContain("团队重点概览");
        expect(html).toContain("昨日完成");
        expect(html).toContain("当日计划");
        expect(html).toContain("联调可能延期");
        expect(html).toContain("确认上线窗口");
        expect(html).toContain("全员已提交 ✓");
        expect(html).not.toContain('class="standup-person-head"><span>');
        const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
        expect(() => new Function(script)).not.toThrow();
        expect(html).toContain("数据校验通过");
        expect(html).toContain("<svg");
        expect(html).toContain("@media print");
        expect(saved).toHaveLength(1);
        expect(artifact.id).toContain("dashboard-oc_dev-2026-07-10-");
    });

    test("inherits completed parent state while counting active parent and child assignments separately", async () => {
        const dir = mkdtempSync(join(tmpdir(), "project-dashboard-hierarchy-"));
        tempDirs.push(dir);
        const tasks = [
            { id: "done-parent", tapd_story_id: "100", title: "完成父项", status: "development_completed", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_open_ids: ["ou_dev"], assignee_names: ["开发"], due_date: "2026-07-01", created_at: "2026-07-01T01:00:00Z", updated_at: "2026-07-09T01:00:00Z" },
            { id: "done-child", tapd_story_id: "101", parent_id: "100", title: "父项下的未改状态子项", status: "in_progress", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_open_ids: ["ou_dev"], assignee_names: ["开发"], due_date: "2026-07-01", created_at: "2026-07-01T01:00:00Z", updated_at: "2026-07-08T01:00:00Z" },
            { id: "active-parent", tapd_story_id: "200", title: "活跃父项", status: "in_progress", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_open_ids: ["ou_dev"], assignee_names: ["开发"], due_date: "2026-07-05", trace: { tapd: { begin_date: "2026-07-02" } }, created_at: "2026-07-01T01:00:00Z", updated_at: "2026-07-08T01:00:00Z" },
            { id: "active-child", tapd_story_id: "201", parent_id: "200", title: "活跃执行子项", status: "in_progress", priority: "P2", primary_owner_open_id: "ou_test", primary_owner_name: "测试", assignee_open_ids: ["ou_dev", "ou_test"], assignee_names: ["开发", "测试"], due_date: "2026-07-08", trace: { tapd: { begin_date: "2026-07-03" } }, created_at: "2026-07-01T01:00:00Z", updated_at: "2026-07-08T01:00:00Z" },
        ];
        const dashboard = new DashboardService({
            listTasks: async () => tasks,
            listStandups: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            saveDashboardArtifact: async () => {},
        } as any, dir, "Demo Project");

        const artifact = await dashboard.generateForGroup(projectConfig().groups[0], new Date("2026-07-10T10:00:00+08:00"));
        const data = JSON.parse(readFileSync(artifact.stats_path, "utf8"));

        expect(data.stats).toMatchObject({ total_tasks: 4, parent_tasks: 2, leaf_tasks: 2, active_leaf_tasks: 1, completed_leaf_tasks: 1, overdue: 1 });
        expect(data.tasks.find((task: any) => task.id === "done-child")).toMatchObject({ dashboard_status: "accepted", effective_completed: true, completed_by_ancestor: true });
        expect(data.tasks.map((task: any) => task.id).indexOf("active-parent")).toBeLessThan(data.tasks.map((task: any) => task.id).indexOf("active-child"));
        expect(data.tasks.find((task: any) => task.id === "active-parent")).toMatchObject({ display_depth: 0, child_count: 1 });
        expect(data.tasks.find((task: any) => task.id === "active-child")).toMatchObject({ display_depth: 1, display_parent_id: "active-parent" });
        expect(data.month_calendar.tasks.find((task: any) => task.id === "active-parent")).toMatchObject({
            start: "2026-07-02",
            end: "2026-07-08",
            own_end: "2026-07-05",
            range_source: "parent_and_children",
            owner: "开发、测试",
            participants: ["开发", "测试"],
        });
        expect(data.month_calendar.tasks.map((task: any) => task.id)).toEqual(["active-parent", "done-parent"]);
        expect(data.month_calendar.tasks.some((task: any) => task.id === "active-child")).toBe(false);
        expect(data.workload).toEqual([{
            open_id: "ou_dev",
            name: "开发",
            task_count: 2,
            requirement_tasks: 0,
            development_tasks: 2,
            testing_tasks: 0,
            estimated_days: 0,
            unestimated_tasks: 2,
        }]);
        expect(data.risks.map((risk: any) => risk.title)).toEqual(["活跃执行子项"]);
        const html = readFileSync(artifact.html_path, "utf8");
        expect(html).toContain("task-completed task-parent-row");
        expect(html).toContain("父项自身截止");
        expect(html).toContain("month-weekdays");
        expect(html).not.toContain("task-kind");
    });

    test("projects parent transfer-to-test state onto child rows while retaining overdue risk", async () => {
        const dir = mkdtempSync(join(tmpdir(), "project-dashboard-transfer-test-"));
        tempDirs.push(dir);
        const tasks = [
            { id: "transfer-parent", tapd_story_id: "300", title: "转测试父项", status: "owner_marked_done", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_open_ids: ["ou_dev"], assignee_names: ["开发"], due_date: "2026-07-05", created_at: "2026-07-01T01:00:00Z", updated_at: "2026-07-09T01:00:00Z" },
            { id: "transfer-child", tapd_story_id: "301", parent_id: "300", title: "仍是 TAPD 开发状态的子项", status: "in_progress", priority: "P2", primary_owner_open_id: "ou_dev", primary_owner_name: "开发", assignee_open_ids: ["ou_dev"], assignee_names: ["开发"], due_date: "2026-07-05", created_at: "2026-07-01T01:00:00Z", updated_at: "2026-07-08T01:00:00Z" },
        ];
        const dashboard = new DashboardService({
            listTasks: async () => tasks,
            listStandups: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            saveDashboardArtifact: async () => {},
        } as any, dir, "Demo Project");

        const artifact = await dashboard.generateForGroup(projectConfig().groups[0], new Date("2026-07-10T10:00:00+08:00"));
        const data = JSON.parse(readFileSync(artifact.stats_path, "utf8"));
        const child = data.tasks.find((task: any) => task.id === "transfer-child");

        expect(child).toMatchObject({
            status: "in_progress",
            dashboard_status: "owner_marked_done",
            inherited_phase: "transfer_test",
            inherited_phase_source_id: "transfer-parent",
            is_overdue: true,
        });
        expect(child.overdue_label).toBe("超期 5 天以上");
        expect(data.stats).toMatchObject({ active_leaf_tasks: 1, overdue: 1 });
        expect(data.status_distribution.find((item: any) => item.status === "owner_marked_done").count).toBe(2);
        expect(data.workload[0]).toMatchObject({ task_count: 2, development_tasks: 0, testing_tasks: 2 });
        expect(data.risks.map((risk: any) => risk.title)).toEqual(["仍是 TAPD 开发状态的子项"]);
    });
});
