import type { AgentManifest } from "@/platform/agents/contracts";
import type { NativeAgentAdapter } from "@/platform/agents/nativeAdapter";
import type { ScheduledJobs } from "@/services/jobs";
import type { WeeklyPeriodKind } from "@/domains/weeklyReport/types";

export const WEEKLY_REPORT_AGENT_ID = "native.weekly-report";
export const WEEKLY_REPORT_CAPABILITY = "summary.weekly.generate";

export const weeklyReportManifest: AgentManifest = {
    schemaVersion: "1.0",
    id: WEEKLY_REPORT_AGENT_ID,
    name: "Weekly Report Agent",
    version: "1.0.0",
    description: "Builds a persisted, evidence-backed weekly report and a link-only delivery artifact.",
    runtime: { type: "native" },
    capabilities: [WEEKLY_REPORT_CAPABILITY],
    triggers: ["schedule", "manual", "agent"],
    inputSchema: {
        type: "object",
        required: ["groupId", "period"],
        properties: {
            groupId: { type: "string" },
            period: { type: "string", enum: ["current_week", "last_week"] },
            cutoffAt: { type: "string" },
            sourceMessageId: { type: "string" },
        },
    },
    outputSchema: {
        type: "object",
        required: ["reportId", "publicUrl"],
        properties: {
            reportId: { type: "string" },
            publicUrl: { type: "string" },
            version: { type: "integer" },
        },
    },
    requirements: { tools: ["task.read", "standup.read", "weekly-report.write"], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 180, maxSteps: 10, maxToolCalls: 20, maxAgentCalls: 1, maxOutputBytes: 5 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ["markdown"], directDelivery: false },
};

export function registerWeeklyReportAgent(adapter: Pick<NativeAgentAdapter, 'register'>, jobs: () => ScheduledJobs): void {
    adapter.register(weeklyReportManifest.id, weeklyReportManifest.version, async (request, _resolved, signal) => {
        if (signal.aborted) {
            return { status: "failed", artifacts: [], error: { code: "CANCELLED", message: "Weekly report cancelled", retryable: true } };
        }
        const input = request.input as {
            groupId: string;
            period: WeeklyPeriodKind;
            cutoffAt?: string;
            sourceMessageId?: string;
        };
        if (!["current_week", "last_week"].includes(input.period)) {
            return { status: "failed", artifacts: [], error: { code: "INVALID_PERIOD", message: "period is invalid", retryable: false } };
        }
        const generated = await jobs().generateWeeklyReport(input.groupId, {
            period: input.period,
            cutoffAt: input.cutoffAt,
            triggerType: request.scope.triggerType === "schedule"
                ? "schedule"
                : request.scope.triggerType === "agent"
                    ? "agent"
                    : "manual",
            sourceMessageId: input.sourceMessageId,
        });
        return { status: "succeeded", data: generated.result, artifacts: generated.artifacts };
    });
}
