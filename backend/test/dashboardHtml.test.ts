import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardService } from "@/services/dashboard";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("DashboardService HTML", () => {
    test("renders the empty standup summary with the shared seven-section layout", async () => {
        const dataDir = mkdtempSync(join(tmpdir(), "dashboard-html-"));
        temporaryDirectories.push(dataDir);
        const store = {
            listTasks: async (): Promise<any[]> => [],
            listStandups: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            saveDashboardArtifact: async (): Promise<void> => undefined,
        };
        const dashboard = new DashboardService(store as any, dataDir, "测试项目");

        const artifact = await dashboard.generateForGroup({
            chat_id: "oc_test",
            name: "测试群",
            members: [],
        }, new Date("2026-07-13T00:00:00+08:00"));
        const html = readFileSync(artifact.html_path, "utf-8");

        expect(html).toContain('<div class="standup-empty-wide">暂无站会提交</div>');
        expect(html).toContain("font:16px/1.55");
        expect(html).toContain(".metric span { display:block; color:var(--muted); font-size:14px;");
        expect(html).toContain("th,td { padding:13px 12px; border-bottom:1px solid #1d3145; text-align:left; vertical-align:top; font-size:13px;");
        expect(html).toContain("团队重点概览");
        expect(html).toContain("阻塞 / 需要帮助");
        expect(html).toContain("风险 / 可能延期");
        expect(html).toContain("未提交情况");
        expect(html).toContain("writing-mode:horizontal-tb; white-space:nowrap; word-break:keep-all;");
        expect(html).toContain("月度任务区间");
        expect(html).toContain('class="month-calendar"');
        expect(html).toContain("safe(task.title) + '<em> · ' + safe(task.owner)");
        expect(html).toContain("var weekCount = 6");
        expect(html).toContain(".month-day-number { z-index:2; grid-row:1; display:grid; width:100%; height:31px; place-items:center;");
        expect(html).toContain(".month-day-cell.outside { background:#06111c; }");
        expect(html).toContain("另有 ' + hidden + ' 项任务");
        expect(html).not.toContain("个重叠区间");
        const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
        expect(() => new Function(script)).not.toThrow();
    });

    test("renders development completed, transfer test, and testing as distinct dashboard states", async () => {
        const dataDir = mkdtempSync(join(tmpdir(), "dashboard-statuses-"));
        temporaryDirectories.push(dataDir);
        const baseTask = {
            title: "任务",
            creator_open_id: "ou_dev",
            creator_name: "开发",
            primary_owner_open_id: "ou_dev",
            primary_owner_name: "开发",
            assignee_open_ids: ["ou_dev"],
            assignee_names: ["开发"],
            priority: "P1",
            source_group_id: "oc_test",
            created_at: "2026-07-13T01:00:00Z",
            updated_at: "2026-07-13T02:00:00Z",
        };
        const store = {
            listTasks: async (): Promise<any[]> => [
                { ...baseTask, id: "task-requirement", title: "需求任务", status: "requirement" },
                { ...baseTask, id: "task-dev-done", title: "开发完成任务", status: "development_completed" },
                { ...baseTask, id: "task-transfer", title: "转测试任务", status: "owner_marked_done" },
                { ...baseTask, id: "task-testing", title: "测试中任务", status: "testing" },
            ],
            listStandups: async (): Promise<any[]> => [],
            listTaskUpdates: async (): Promise<any[]> => [],
            saveDashboardArtifact: async (): Promise<void> => undefined,
        };
        const dashboard = new DashboardService(store as any, dataDir, "测试项目");

        const artifact = await dashboard.generateForGroup({
            chat_id: "oc_test",
            name: "测试群",
            members: [{ open_id: "ou_dev", name: "开发" }],
        }, new Date("2026-07-13T00:00:00+08:00"));
        const html = readFileSync(artifact.html_path, "utf-8");

        expect(html).toContain("pill-requirement'>需求");
        expect(html).toContain("pill-development_completed'>开发完成");
        expect(html).toContain("pill-owner_marked_done'>转测试");
        expect(html).toContain("pill-testing'>测试进行中");
        expect(html).toContain('<option value="development_completed">开发完成</option>');
        expect(html).toContain('.pill-requirement { color:#f06292;');
        expect(html).toContain('.pill-in_progress,.pill-confirmed { color:#4d9bff;');
        expect(html).toContain('.pill-development_completed { color:#ffd477;');
        expect(html).toContain('.pill-owner_marked_done { color:#c5a4ff;');
        expect(html).toContain('.pill-testing { color:#69ddd3;');
        expect(html).toContain('.pill-accepted { color:#51d292;');
    });
});
