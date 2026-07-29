import dayjs from "dayjs";
import type { GeneratedDailySummary } from "./jobs";

export const MANUAL_JOB_NAMES = new Set([
    "standup-push",
    "standup-remind",
    "standup-second-remind",
    "standup-summary",
    "standup-supplement-summary",
    "overdue-scan",
    "daily-summary",
    "dashboard",
]);

export class UnsupportedJobPreviewError extends Error {}

export interface ManualJobRunner {
    standupPush(groupId: string, day: Date): Promise<any>;
    standupRemind(groupId: string, day: Date): Promise<any>;
    standupSecondRemind(groupId: string, day: Date): Promise<any>;
    standupSummary(groupId: string, day: Date): Promise<any>;
    standupSupplementSummary(groupId: string, day: Date): Promise<any>;
    overdueScan(groupId: string, day: Date): Promise<any>;
    dailySummary(groupId: string, day: Date): Promise<any>;
    dashboardGenerate(groupId: string, day: Date): Promise<any>;
    generateDailySummary(groupId: string, day: Date): Promise<GeneratedDailySummary>;
}

export function parseManualJobDay(value: unknown, fallback: Date = new Date()): Date {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error("日期必须使用 YYYY-MM-DD 格式");
    }
    const parsed = dayjs(`${value}T12:00:00`);
    if (!parsed.isValid() || parsed.format("YYYY-MM-DD") !== value) {
        throw new Error("日期无效");
    }
    return parsed.toDate();
}

export async function executeManualJob(
    jobs: ManualJobRunner,
    jobName: string,
    groupId: string,
    day: Date,
    dryRun: boolean,
): Promise<any> {
    if (dryRun) {
        if (jobName !== "daily-summary") {
            throw new UnsupportedJobPreviewError(`任务 ${jobName} 暂不支持安全预览`);
        }
        const generated = await jobs.generateDailySummary(groupId, day);
        return {
            dry_run: true,
            date: dayjs(day).format("YYYY-MM-DD"),
            summary_ids: generated.summaryIds,
            previews: generated.artifacts.map(artifact => ({
                type: artifact.type,
                content: String(artifact.content || ""),
                title: typeof artifact.metadata?.title === "string" ? artifact.metadata.title : "",
                target_id: typeof artifact.metadata?.targetId === "string" ? artifact.metadata.targetId : groupId,
            })),
        };
    }

    switch (jobName) {
        case "standup-push": return jobs.standupPush(groupId, day);
        case "standup-remind": return jobs.standupRemind(groupId, day);
        case "standup-second-remind": return jobs.standupSecondRemind(groupId, day);
        case "standup-summary": return jobs.standupSummary(groupId, day);
        case "standup-supplement-summary": return jobs.standupSupplementSummary(groupId, day);
        case "overdue-scan": return jobs.overdueScan(groupId, day);
        case "daily-summary": return jobs.dailySummary(groupId, day);
        case "dashboard": return jobs.dashboardGenerate(groupId, day);
        default: throw new Error(`无效的任务名称：${jobName}`);
    }
}
