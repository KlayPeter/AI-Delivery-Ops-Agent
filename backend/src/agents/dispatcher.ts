import { randomUUID } from 'node:crypto';
import { AI_HOT_CAPABILITY, createAiHotAgentPackage } from '@/agents/external/aiHotAgent';
import { DAILY_SUMMARY_CAPABILITY } from '@/agents/native/dailySummaryAgent';
import { DASHBOARD_CAPABILITY } from '@/agents/native/dashboardAgent';
import { WEEKLY_REPORT_CAPABILITY } from '@/agents/native/weeklyReportAgent';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { ExternalAgentInstallOptions } from '@/platform/agents/externalInstaller';
import { createTriggerEnvelope, createTriggerScope, DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import type { MessageHandler } from '@/services/messageHandler';
import type { BotInstance } from '@/platform/bots/contracts';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { createDeliveryOpsHost } from '@/agents/host';

export class ScheduledAgentDispatcher {
    private readonly host: AgentHost;

    constructor(hostOrGetHandler: AgentHost | (() => MessageHandler)) {
        this.host = hostOrGetHandler instanceof AgentHost
            ? hostOrGetHandler
            : createDeliveryOpsHost(() => (hostOrGetHandler() as any).ctx);
    }

    async dailySummary(groupId: string, day: Date, retryAttempt: number = 0): Promise<Record<string, unknown>> {
        return this.dispatchCapability(DAILY_SUMMARY_CAPABILITY, 'daily-summary', groupId, day, { groupId, dayIso: day.toISOString() }, 'schedule', retryAttempt);
    }

    async dashboard(groupId: string, day: Date, retryAttempt: number = 0): Promise<Record<string, unknown>> {
        return this.dispatchCapability(DASHBOARD_CAPABILITY, 'dashboard', groupId, day, { groupId, dayIso: day.toISOString() }, 'schedule', retryAttempt);
    }

    async weeklyReport(groupId: string, day: Date, retryAttempt: number = 0): Promise<Record<string, unknown>> {
        return this.dispatchCapability(
            WEEKLY_REPORT_CAPABILITY,
            "weekly-report",
            groupId,
            day,
            { groupId, period: "current_week", cutoffAt: day.toISOString() },
            "schedule",
            retryAttempt,
        );
    }

    async aiHot(groupId: string, day: Date, retryAttempt: number = 0): Promise<Record<string, unknown>> {
        return this.dispatchCapability(AI_HOT_CAPABILITY, 'ai-hot', groupId, day, { date: day.toISOString().slice(0, 10), limit: 10, language: 'zh-CN' }, 'schedule', retryAttempt);
    }

    async runManual(capability: string, groupId: string, input: unknown, triggerId: string = randomUUID()): Promise<Record<string, unknown>> {
        return this.dispatchCapability(capability, `manual:${triggerId}`, groupId, new Date(), input, 'manual');
    }

    async runManualForBot(
        capability: string,
        groupId: string,
        input: unknown,
        options: { workspaceId: string; botInstanceId: string; triggerId?: string },
    ): Promise<Record<string, unknown>> {
        const triggerId = options.triggerId || randomUUID();
        return this.dispatchCapability(capability, `manual:${triggerId}`, groupId, new Date(), input, 'manual', 0, options);
    }

    async resumeManual(
        runId: string,
        groupId: string,
        input: unknown,
        triggerId: string = randomUUID(),
        execution: { workspaceId: string; botInstanceId: string } = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID },
    ): Promise<Record<string, unknown>> {
        const now = new Date();
        const scope = createTriggerScope({
            workspaceId: execution.workspaceId,
            botInstanceId: execution.botInstanceId,
            triggerType: 'manual',
            triggerId: `resume:${triggerId}`,
            chatId: groupId,
        });
        const trigger = createTriggerEnvelope({
            occurredAt: now.toISOString(),
            scope,
            payload: input,
            replyPolicy: { mode: 'configured_target', targetId: groupId },
        });
        const result = await this.host.resume(trigger, runId, input);
        await this.flushDeliveries();
        if (result.status === 'failed') throw new Error(result.claim.error?.message || 'Agent resume failed');
        return result.status === 'duplicate'
            ? { status: 'duplicate', run_id: result.claim.runId }
            : { status: result.execution?.run.status, run_id: result.execution?.run.id, result: result.execution?.result.data };
    }

    async installAiHot(options: { endpoint: string; apiTokenRef?: string; priority?: number; workspaceId?: string; botInstanceId?: string }): Promise<Record<string, unknown>> {
        const agentPackage = createAiHotAgentPackage({
            ...options,
            workspaceId: options.workspaceId || DEFAULT_WORKSPACE_ID,
            botInstanceId: options.botInstanceId || DEFAULT_BOT_INSTANCE_ID,
        });
        const saved = await this.host.installExternal(agentPackage.manifest, {
            workspaceId: agentPackage.installation.workspaceId,
            botInstanceId: agentPackage.binding.botInstanceId,
            installationId: agentPackage.installation.id,
            bindingId: agentPackage.binding.id,
            config: agentPackage.installation.config,
            secretRefs: agentPackage.installation.secretRefs,
            priority: agentPackage.binding.priority,
        });
        return { agentId: saved.manifest.id, installationId: saved.installation.id, capabilities: saved.manifest.capabilities };
    }

    async installExternal(
        manifest: AgentManifest,
        options: Omit<ExternalAgentInstallOptions, 'workspaceId' | 'botInstanceId' | 'installationId' | 'bindingId'> &
            Partial<Pick<ExternalAgentInstallOptions, 'workspaceId' | 'botInstanceId' | 'installationId' | 'bindingId'>>,
    ): Promise<Record<string, unknown>> {
        if (manifest.runtime.type !== 'http') throw new Error('Only HTTP external Agents are enabled');
        const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
        const botInstanceId = options.botInstanceId || DEFAULT_BOT_INSTANCE_ID;
        const isDefaultTarget = workspaceId === DEFAULT_WORKSPACE_ID && botInstanceId === DEFAULT_BOT_INSTANCE_ID;
        const installationId = options.installationId || (isDefaultTarget
            ? `install-${manifest.id}`
            : `install-${manifest.id}-${workspaceId}-${botInstanceId}`);
        const bindingId = options.bindingId || (isDefaultTarget
            ? `bind-${manifest.id}-default`
            : `bind-${installationId}-${botInstanceId}`);
        const saved = await this.host.installExternal(manifest, {
            ...options,
            workspaceId,
            botInstanceId,
            installationId,
            bindingId,
        });
        return { agentId: saved.manifest.id, installationId: saved.installation.id, capabilities: saved.manifest.capabilities };
    }

    listAgents(): Promise<Array<Record<string, unknown>>> {
        return this.host.listAgents();
    }

    registerBot(bot: BotInstance): Promise<Record<string, unknown>> {
        return this.host.registerBot(bot);
    }

    bindAgent(input: Parameters<AgentHost['bindAgent']>[0]) {
        return this.host.bindAgent(input);
    }

    listBots(): Promise<Array<Record<string, unknown>>> {
        return this.host.listBots();
    }

    listBindings(botInstanceId?: string) {
        return this.host.listBindings(botInstanceId);
    }

    async flushDeliveries(now: Date = new Date()): Promise<{ delivered: number; retried: number; deadLettered: number }> {
        return this.host.flushDeliveries(now);
    }

    private async dispatchCapability(
        capability: string,
        triggerName: string,
        groupId: string,
        day: Date,
        input: unknown,
        triggerType: 'schedule' | 'manual' = 'schedule',
        retryAttempt: number = 0,
        execution: { workspaceId: string; botInstanceId: string } = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID },
    ): Promise<Record<string, unknown>> {
        const retrySuffix = retryAttempt > 0 ? `:retry-${retryAttempt}` : '';
        const scope = createTriggerScope({
            workspaceId: execution.workspaceId,
            botInstanceId: execution.botInstanceId,
            triggerType,
            triggerId: `${triggerName}:${groupId}:${day.toISOString().slice(0, 10)}${retrySuffix}`,
            chatId: groupId,
        });
        const trigger = createTriggerEnvelope({
            occurredAt: day.toISOString(),
            scope,
            payload: input,
            replyPolicy: { mode: 'configured_target', targetId: groupId },
        });
        const result = await this.host.dispatch(trigger, capability, input);
        await this.flushDeliveries();
        if (result.status === 'failed') {
            const failure = result.claim.error;
            throw Object.assign(new Error(failure?.message || `${triggerName} Agent failed`), {
                code: failure?.code || 'SCHEDULED_AGENT_FAILED',
                retryable: failure?.retryable === true,
            });
        }
        return result.status === 'duplicate'
            ? { status: 'duplicate', run_id: result.claim.runId }
            : { status: 'completed', run_id: result.execution?.run.id, result: result.execution?.result.data };
    }
}
