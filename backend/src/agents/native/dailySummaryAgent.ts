import type { AgentManifest } from '@/platform/agents/contracts';
import type { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import type { ScheduledJobs } from '@/services/jobs';

export const DAILY_SUMMARY_AGENT_ID = 'native.daily-summary';
export const DAILY_SUMMARY_CAPABILITY = 'summary.daily.generate';

export const dailySummaryManifest: AgentManifest = {
    schemaVersion: '1.0', id: DAILY_SUMMARY_AGENT_ID, name: 'Daily Summary Agent', version: '1.0.0',
    description: 'Generates a persisted project daily summary without directly sending messages.',
    runtime: { type: 'native' }, capabilities: [DAILY_SUMMARY_CAPABILITY], triggers: ['schedule', 'manual', 'agent'],
    inputSchema: { type: 'object', required: ['groupId', 'dayIso'], properties: { groupId: { type: 'string' }, dayIso: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['summaryIds'], properties: { summaryIds: { type: 'array', items: { type: 'string' } } } },
    requirements: { tools: ['task.read', 'standup.read', 'summary.write'], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 120, maxSteps: 10, maxToolCalls: 20, maxAgentCalls: 1, maxOutputBytes: 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
};

export function registerDailySummaryAgent(adapter: NativeAgentAdapter, jobs: () => ScheduledJobs): void {
    adapter.register(dailySummaryManifest.id, dailySummaryManifest.version, async (request, _resolved, signal) => {
        if (signal.aborted) return { status: 'failed', artifacts: [], error: { code: 'CANCELLED', message: 'Daily summary cancelled', retryable: true } };
        const input = request.input as { groupId: string; dayIso: string };
        const day = new Date(input.dayIso);
        if (Number.isNaN(day.getTime())) return { status: 'failed', artifacts: [], error: { code: 'INVALID_DAY', message: 'dayIso is invalid', retryable: false } };
        const generated = await jobs().generateDailySummary(input.groupId, day);
        return { status: 'succeeded', data: { summaryIds: generated.summaryIds }, artifacts: generated.artifacts };
    });
}
