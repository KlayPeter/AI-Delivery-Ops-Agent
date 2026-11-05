import { describe, expect, test } from "bun:test";
import { executeManualJob, MANUAL_JOB_NAMES, parseManualJobDay, UnsupportedJobPreviewError } from "@/services/jobExecution";

function createRunner() {
    const calls: string[] = [];
    const runner: any = {
        generateDailySummary: async () => {
            calls.push("generateDailySummary");
            return {
                summaryIds: ["summary-1"],
                artifacts: [{
                    type: "markdown",
                    content: "日报预览内容",
                    metadata: { title: "产研大群总结", targetId: "oc_target" },
                }],
            };
        },
        dailySummary: async () => { calls.push("dailySummary"); return { sent: true }; },
        standupPush: async () => { calls.push("standupPush"); return {}; },
        taskStandupTemplate: async () => { calls.push("taskStandupTemplate"); return {}; },
        standupRemind: async () => { calls.push("standupRemind"); return {}; },
        standupSecondRemind: async () => { calls.push("standupSecondRemind"); return {}; },
        standupSummary: async () => { calls.push("standupSummary"); return {}; },
        overdueScan: async () => { calls.push("overdueScan"); return {}; },
        dashboardGenerate: async () => { calls.push("dashboardGenerate"); return {}; },
    };
    return { runner, calls };
}

describe("manual job API execution", () => {
    test("daily summary dry-run generates a preview without sending", async () => {
        const { runner, calls } = createRunner();

        const result = await executeManualJob(runner, "daily-summary", "oc_target", parseManualJobDay("2026-07-16"), true);

        expect(calls).toEqual(["generateDailySummary"]);
        expect(result).toEqual({
            dry_run: true,
            date: "2026-07-16",
            summary_ids: ["summary-1"],
            previews: [{ type: "markdown", content: "日报预览内容", title: "产研大群总结", target_id: "oc_target" }],
        });
    });

    test("non-preview daily summary uses the delivery method", async () => {
        const { runner, calls } = createRunner();

        await executeManualJob(runner, "daily-summary", "oc_target", parseManualJobDay("2026-07-16"), false);

        expect(calls).toEqual(["dailySummary"]);
    });

    test("manual task standup template uses its independent job", async () => {
        const { runner, calls } = createRunner();

        await executeManualJob(runner, "task-standup-template", "oc_target", parseManualJobDay("2026-07-16"), false);

        expect(calls).toEqual(["taskStandupTemplate"]);
    });

    test("rejects unsafe preview jobs instead of pretending success", async () => {
        const { runner, calls } = createRunner();

        expect(executeManualJob(runner, "standup-push", "oc_target", new Date(), true)).rejects.toBeInstanceOf(UnsupportedJobPreviewError);
        expect(calls).toEqual([]);
    });

    test("validates requested historical date", () => {
        expect(() => parseManualJobDay("2026-02-30")).toThrow("日期无效");
        expect(() => parseManualJobDay("16/07/2026")).toThrow("YYYY-MM-DD");
    });

    test("does not expose the old no-op job as a valid API job", () => {
        expect(MANUAL_JOB_NAMES.has("standup-mark-missing")).toBe(false);
    });
});
