import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { StandupService } from "@/services/standupService";
import { TaskService } from "@/services/taskService";
import type { WeeklyReport } from "@/models/types";
import { collectWeeklyReportFacts } from "./facts";
import { buildWeeklyNarrative } from "./narrative";
import { resolveWeeklyPeriod } from "./period";
import { renderWeeklyReportHtml, writeWeeklyReportHtml } from "./renderer";
import type { WeeklyPeriod, WeeklyReportRequest, WeeklyTapdStatusChange } from "./types";
import { aiDegradationNotice } from "@/platform/aiDegradation";

export const DEFAULT_WEEKLY_REPORT_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_WEEKLY_REPORT_PUBLIC_BASE_URL = "http://localhost:8090";

export class WeeklyReportService {
    constructor(
        private readonly config: any,
        private readonly store: any,
        private readonly tapd: any,
        private readonly llm?: any,
    ) {}

    async generate(request: WeeklyReportRequest): Promise<WeeklyReport> {
        const group = (this.config.groups || []).find((item: any) => item.chat_id === request.group_id);
        if (!group) throw new Error(`未找到群组配置：${request.group_id}`);
        if (!StandupService.isGroupEnabled(group)) {
            throw new Error("当前群未开启日报站会，周报未生成");
        }

        const timeZone = String(
            group.schedule?.weekly_report_timezone
            || this.config.schedule?.weekly_report_timezone
            || DEFAULT_WEEKLY_REPORT_TIME_ZONE
        );
        const cutoffAt = request.cutoff_at || new Date().toISOString();
        const period = resolveWeeklyPeriod(request.period, cutoffAt, timeZone);

        const sync = await TaskService.syncProjectScope({
            config: this.config,
            store: this.store,
            tapd: this.tapd,
        });
        if (!sync.ok) {
            await Promise.resolve(this.store.appendAuditLog("weekly_report_failed", {
                group_id: request.group_id,
                period_start: period.start,
                period_end: period.end,
                reason: "tapd_sync_failed",
                error: sync.error,
            })).catch(() => {});
            throw TaskService.projectSyncError("TAPD 数据同步失败，周报未生成", sync);
        }

        const tapdSyncedAt = new Date().toISOString();
        const tapdStatusHistory = await this.loadTapdStatusHistory(period);
        const facts = await collectWeeklyReportFacts({
            config: this.config,
            store: this.store,
            group,
            period,
            tapdSyncedAt,
            tapdStatusChanges: tapdStatusHistory.changes,
            tapdStatusHistoryAvailable: tapdStatusHistory.available,
        });
        const narrative = await buildWeeklyNarrative(facts, this.llm);
        if (narrative.ai_degraded) {
            await Promise.resolve(this.store.appendAuditLog("ai_weekly_report_failed", {
                group_id: group.chat_id,
                period_start: period.start,
                period_end: period.end,
                category: narrative.ai_failure_category,
                error: narrative.ai_error,
                fallback: "deterministic_narrative",
            })).catch(() => {});
        }
        const previous = await this.store.listWeeklyReports(group.chat_id, period.start, period.end);
        let version = Math.max(0, ...previous.map((report: WeeklyReport) => report.version || 0)) + 1;
        const id = randomUUID();
        const generatedAt = new Date().toISOString();
        const html = renderWeeklyReportHtml(facts, narrative);
        const configuredPublicBase = String(this.config.runtime?.public_base_url || "").trim().replace(/\/+$/, "");
        const publicBase = configuredPublicBase || DEFAULT_WEEKLY_REPORT_PUBLIC_BASE_URL;
        const report: WeeklyReport = {
            id,
            group_id: group.chat_id,
            period_start: period.start,
            period_end: period.end,
            cutoff_at: period.cutoff_at,
            version,
            status: "succeeded",
            facts,
            narrative,
            html_path: "",
            public_url: `${publicBase}/api/weekly-reports/${encodeURIComponent(id)}`,
            tapd_synced_at: tapdSyncedAt,
            generated_at: generatedAt,
            trigger_type: request.trigger_type,
            source_message_id: request.source_message_id || null,
        };

        for (let attempt = 0; attempt < 3; attempt++) {
            report.version = version;
            report.html_path = writeWeeklyReportHtml(
                this.config.data_path,
                `${group.chat_id}-${period.start}-${period.end}-v${version}-${id}.html`,
                html,
            );
            try {
                await this.store.saveWeeklyReport(report);
                break;
            } catch (error) {
                try { unlinkSync(report.html_path); } catch {}
                if (!isVersionConflict(error) || attempt === 2) throw error;
                const concurrent = await this.store.listWeeklyReports(group.chat_id, period.start, period.end);
                version = Math.max(version, ...concurrent.map((item: WeeklyReport) => item.version || 0)) + 1;
            }
        }
        await Promise.resolve(this.store.appendAuditLog("weekly_report_generated", {
            report_id: id,
            group_id: group.chat_id,
            period_start: period.start,
            period_end: period.end,
            version,
            narrative_source: narrative.source,
            tapd_sync: sync,
        })).catch(() => {});
        return report;
    }

    private async loadTapdStatusHistory(period: WeeklyPeriod): Promise<{ available: boolean; changes: WeeklyTapdStatusChange[] }> {
        if (typeof this.tapd?.listStoryStatusChanges !== "function") return { available: false, changes: [] };
        const changes: WeeklyTapdStatusChange[] = [];
        const seen = new Set<string>();
        for (const date of reportDates(period.start, period.end)) {
            for (let page = 1; page <= 1000; page++) {
                let result: any;
                try {
                    result = await this.tapd.listStoryStatusChanges(date, page, 100);
                } catch {
                    return { available: false, changes: [] };
                }
                if (!result?.ok || !Array.isArray(result.raw?.data)) return { available: false, changes: [] };
                const rows = result.raw.data;
                for (const row of rows) {
                    const item = row?.WorkitemChange || row?.StoryChange || row;
                    const fields = Array.isArray(item?.field_changes) ? item.field_changes : parseChanges(item?.changes);
                    for (const field of fields) {
                        if (field?.field !== "status") continue;
                        const storyId = String(item?.story_id || "").trim();
                        const at = String(item?.created || "").trim();
                        if (!storyId || !at) continue;
                        const key = `${item?.id || ""}:${storyId}:${at}:${String(field.value_after ?? "")}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        changes.push({
                            story_id: storyId,
                            at,
                            from: field.value_before_parsed ?? field.value_before,
                            to: field.value_after_parsed ?? field.value_after,
                        });
                    }
                }
                if (rows.length < 100) break;
                if (page === 1000) return { available: false, changes: [] };
            }
        }
        return { available: true, changes };
    }

    static deliveryMarkdown(report: WeeklyReport): string {
        const periodLabel = report.facts?.period?.is_partial ? "本周（截至当前）" : `${report.period_start} 至 ${report.period_end}`;
        const reportUrl = report.public_url || `${DEFAULT_WEEKLY_REPORT_PUBLIC_BASE_URL}/api/weekly-reports/${encodeURIComponent(report.id)}`;
        const lines = [
            `**${report.facts?.group?.name || "项目"}周报**`,
            `统计周期：${periodLabel}`,
        ];
        if (report.narrative?.ai_degraded) {
            lines.push(aiDegradationNotice(report.narrative.ai_failure_category || "unavailable", "确定性事实模板"));
        }
        lines.push(`[查看完整可视化周报](${reportUrl})`);
        return lines.join("\n\n");
    }
}

function reportDates(start: string, end: string): string[] {
    const dates: string[] = [];
    for (let value = new Date(`${start}T00:00:00Z`), finish = new Date(`${end}T00:00:00Z`); value <= finish; value.setUTCDate(value.getUTCDate() + 1)) {
        dates.push(value.toISOString().slice(0, 10));
    }
    return dates;
}

function parseChanges(value: unknown): any[] {
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function isVersionConflict(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: string }).code === "P2002";
}
