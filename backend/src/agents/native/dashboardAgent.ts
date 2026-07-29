import type { AgentManifest } from '@/platform/agents/contracts';
import type { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import type { ScheduledJobs } from '@/services/jobs';

export const DASHBOARD_AGENT_ID = 'native.project-dashboard';
export const DASHBOARD_CAPABILITY = 'dashboard.project.generate';

export const dashboardManifest: AgentManifest = {
    schemaVersion: '1.0', id: DASHBOARD_AGENT_ID, name: 'Project Dashboard Agent', version: '1.0.0',
    description: 'Generates an immutable project dashboard snapshot and delivery Artifacts.',
    runtime: { type: 'native' }, capabilities: [DASHBOARD_CAPABILITY], triggers: ['schedule', 'manual', 'agent'],
    inputSchema: { type: 'object', required: ['groupId', 'dayIso'], properties: { groupId: { type: 'string' }, dayIso: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['artifact_id', 'subscriber_count'], properties: { artifact_id: { type: 'string' }, subscriber_count: { type: 'integer' } } },
    requirements: { tools: ['task.read', 'dashboard.write'], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 180, maxSteps: 10, maxToolCalls: 20, maxAgentCalls: 1, maxOutputBytes: 5 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['image', 'markdown'], directDelivery: false },
};

export function registerDashboardAgent(adapter: NativeAgentAdapter, jobs: () => ScheduledJobs): void {
    adapter.register(dashboardManifest.id, dashboardManifest.version, async (request, _resolved, signal) => {
        if (signal.aborted) return { status: 'failed', artifacts: [], error: { code: 'CANCELLED', message: 'Dashboard generation cancelled', retryable: true } };
        const input = request.input as { groupId: string; dayIso: string }; const day = new Date(input.dayIso);
        if (Number.isNaN(day.getTime())) return { status: 'failed', artifacts: [], error: { code: 'INVALID_DAY', message: 'dayIso is invalid', retryable: false } };
        const generated = await jobs().generateDashboard(input.groupId, day);
        return { status: 'succeeded', data: generated.result, artifacts: generated.artifacts };
    });
}
