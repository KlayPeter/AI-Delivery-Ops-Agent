import { createHash, randomUUID } from 'node:crypto';
import type { BotRegistry } from '@/platform/bots/registry';
import { createExecutionScope, createTriggerEnvelope, createTriggerScope, type TriggerEnvelope } from '@/platform/runtime/scope';
import type { AgentError, AgentManifest, AgentRequest, AgentResult, AgentRun, AgentRuntimeAdapter, Artifact, JsonSchema, ResolvedAgent } from './contracts';
import type { AgentRegistry } from './registry';
import type { AgentRunStore } from './runStore';
import { validateSchema } from './schema';

export interface AgentExecutionOutcome {
    run: AgentRun;
    result: AgentResult;
    artifacts: Artifact[];
}

const errorResult = (error: AgentError): AgentResult => ({ status: 'failed', artifacts: [], error });
function jsonFingerprint(value: unknown): string | undefined {
    try { const json = JSON.stringify(value); return json === undefined ? undefined : createHash('sha256').update(json).digest('hex'); }
    catch { return undefined; }
}

export class AgentRuntime {
    private readonly adapters = new Map<string, AgentRuntimeAdapter>();

    constructor(
        private readonly registry: AgentRegistry,
        private readonly bots: BotRegistry,
        private readonly runs: AgentRunStore,
        adapters: readonly AgentRuntimeAdapter[],
    ) { for (const adapter of adapters) this.adapters.set(adapter.type, adapter); }

    async execute<T>(trigger: TriggerEnvelope, capability: string, input: T): Promise<AgentExecutionOutcome> {
        this.requireBotScope(trigger);
        const resolved = this.registry.resolve(trigger.scope.workspaceId, trigger.scope.botInstanceId, capability);
        const now = new Date();
        const runId = randomUUID();
        const scope = createExecutionScope(trigger.scope, resolved.installation.id, { correlationId: runId });
        const run: AgentRun = {
            id: runId,
            workspaceId: scope.workspaceId,
            botInstanceId: scope.botInstanceId,
            agentInstallationId: scope.agentInstallationId,
            capability,
            triggerId: trigger.id,
            correlationId: scope.correlationId,
            rootRunId: runId,
            depth: 0,
            status: 'queued',
            createdAt: now.toISOString(),
        };
        await this.runs.create(run);
        await this.runs.transition(runId, 'running', { startedAt: now.toISOString() });
        return this.invoke(trigger, run, resolved, input, scope);
    }

    async resume<T>(trigger: TriggerEnvelope, runId: string, input: T): Promise<AgentExecutionOutcome> {
        this.requireBotScope(trigger);
        const run = await this.runs.get(runId);
        if (!run) throw Object.assign(new Error(`AgentRun not found: ${runId}`), { code: 'RUN_NOT_FOUND', retryable: false });
        if (run.status !== 'waiting_human') throw Object.assign(new Error(`AgentRun is not waiting for human input: ${runId}`), { code: 'RUN_NOT_WAITING_HUMAN', retryable: false });
        if (run.workspaceId !== trigger.scope.workspaceId || run.botInstanceId !== trigger.scope.botInstanceId) {
            throw Object.assign(new Error('Resume trigger scope does not match AgentRun'), { code: 'WORKSPACE_SCOPE_MISMATCH', retryable: false });
        }
        const resolved = this.registry.resolveInstallation(run.workspaceId, run.botInstanceId, run.agentInstallationId, run.capability);
        const scope = createExecutionScope(trigger.scope, resolved.installation.id, { correlationId: run.correlationId, causationId: trigger.id });
        const running = await this.runs.transition(runId, 'running', { error: undefined, completedAt: undefined });
        return this.invoke(trigger, running, resolved, input, scope);
    }

    describeDelegate(parent: AgentRequest, parentManifest: AgentManifest, capability: string): { name: string; description: string; inputSchema: JsonSchema } {
        this.requireDelegate(parentManifest, capability);
        const resolved = this.registry.resolve(parent.scope.workspaceId, parent.scope.botInstanceId, capability);
        const schema = structuredClone(resolved.manifest.inputSchema);
        schema.properties = { ...(schema.properties || {}), resumeRunId: { type: 'string' } };
        return { name: resolved.manifest.name, description: resolved.manifest.description, inputSchema: schema };
    }

    async delegate(
        parent: AgentRequest,
        parentManifest: AgentManifest,
        capability: string,
        rawInput: unknown,
        signal: AbortSignal,
    ): Promise<AgentExecutionOutcome> {
        this.requireDelegate(parentManifest, capability);
        const parentRun = await this.runs.get(parent.runId);
        if (!parentRun) throw Object.assign(new Error(`Parent AgentRun not found: ${parent.runId}`), { code: 'PARENT_RUN_NOT_FOUND', retryable: false });
        const maxDepth = parentManifest.limits.maxDepth ?? 2;
        if (parentRun.depth + 1 > maxDepth) throw Object.assign(new Error(`Agent delegation depth exceeds ${maxDepth}`), { code: 'AGENT_DEPTH_EXCEEDED', retryable: false });

        const payload = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {};
        const resumeRunId = typeof payload.resumeRunId === 'string' ? payload.resumeRunId : undefined;
        const input = resumeRunId
            ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'resumeRunId'))
            : rawInput;
        const now = new Date();
        const trigger = createTriggerEnvelope({
            occurredAt: now.toISOString(),
            scope: createTriggerScope({
                workspaceId: parent.scope.workspaceId,
                botInstanceId: parent.scope.botInstanceId,
                triggerType: 'agent',
                triggerId: `delegate:${parent.runId}:${resumeRunId || randomUUID()}`,
                conversationId: parent.scope.conversationId,
                chatId: parent.scope.chatId,
                actorId: parent.scope.actorId,
                locale: parent.scope.locale,
                timezone: parent.scope.timezone,
            }),
            payload: input,
            trustedContext: parent.trustedContext ? structuredClone(parent.trustedContext) : undefined,
            replyPolicy: { mode: 'none' },
        });

        let childRun: AgentRun;
        let resolved: ResolvedAgent;
        if (resumeRunId) {
            const existing = await this.runs.get(resumeRunId);
            if (!existing || existing.parentRunId !== parentRun.id || existing.rootRunId !== parentRun.rootRunId) {
                throw Object.assign(new Error('Delegated AgentRun does not belong to the parent Run'), { code: 'CHILD_RUN_SCOPE_MISMATCH', retryable: false });
            }
            if (existing.status !== 'waiting_human') throw Object.assign(new Error('Delegated AgentRun is not waiting for human input'), { code: 'CHILD_RUN_NOT_WAITING', retryable: false });
            if (existing.capability !== capability) throw Object.assign(new Error('Delegated Agent capability does not match resumeRunId'), { code: 'CHILD_CAPABILITY_MISMATCH', retryable: false });
            resolved = this.registry.resolveInstallation(existing.workspaceId, existing.botInstanceId, existing.agentInstallationId, existing.capability);
            childRun = await this.runs.transition(existing.id, 'running', { error: undefined, completedAt: undefined });
        } else {
            resolved = this.registry.resolve(parent.scope.workspaceId, parent.scope.botInstanceId, capability);
            const childRunId = randomUUID();
            childRun = {
                id: childRunId,
                workspaceId: parentRun.workspaceId,
                botInstanceId: parentRun.botInstanceId,
                agentInstallationId: resolved.installation.id,
                capability,
                triggerId: trigger.id,
                correlationId: parentRun.correlationId,
                rootRunId: parentRun.rootRunId,
                parentRunId: parentRun.id,
                depth: parentRun.depth + 1,
                status: 'queued',
                createdAt: now.toISOString(),
            };
            await this.runs.create(childRun);
            childRun = await this.runs.transition(childRun.id, 'running', { startedAt: now.toISOString() });
        }

        const scope = createExecutionScope(trigger.scope, resolved.installation.id, {
            correlationId: parentRun.correlationId,
            causationId: parentRun.id,
        });
        const stepId = randomUUID();
        const startedAt = new Date().toISOString();
        await this.runs.saveStep({ id: stepId, runId: parentRun.id, kind: 'agent', name: `delegate:${capability}`, status: 'running', startedAt, metadata: { childRunId: childRun.id } });
        try {
            const outcome = await this.invoke(trigger, childRun, resolved, input, scope, parent.deadlineAt, signal);
            await this.runs.saveStep({
                id: stepId,
                runId: parentRun.id,
                kind: 'agent',
                name: `delegate:${capability}`,
                status: outcome.run.status === 'failed' ? 'failed' : 'succeeded',
                startedAt,
                completedAt: new Date().toISOString(),
                error: outcome.run.error,
                metadata: { childRunId: outcome.run.id, childStatus: outcome.run.status },
            });
            return outcome;
        } catch (error: any) {
            await this.runs.saveStep({
                id: stepId,
                runId: parentRun.id,
                kind: 'agent',
                name: `delegate:${capability}`,
                status: 'failed',
                startedAt,
                completedAt: new Date().toISOString(),
                error: { code: error?.code || 'AGENT_DELEGATION_ERROR', message: error?.message || String(error), retryable: error?.retryable === true },
                metadata: { childRunId: childRun.id },
            });
            throw error;
        }
    }

    private async invoke<T>(
        trigger: TriggerEnvelope,
        run: AgentRun,
        resolved: ResolvedAgent,
        input: T,
        scope: AgentRequest['scope'],
        deadlineCap?: string,
        parentSignal?: AbortSignal,
    ): Promise<AgentExecutionOutcome> {
        const runId = run.id;
        if (!resolved.manifest.triggers.includes(trigger.type)) return this.fail(runId, { code: 'TRIGGER_NOT_ALLOWED', message: `Trigger type is not allowed: ${trigger.type}`, retryable: false });
        const inputErrors = validateSchema(input, resolved.manifest.inputSchema);
        if (inputErrors.length) return this.fail(runId, { code: 'INVALID_INPUT', message: inputErrors.join('; '), retryable: false });
        const adapter = this.adapters.get(resolved.manifest.runtime.type);
        if (!adapter) return this.fail(runId, { code: 'ADAPTER_NOT_FOUND', message: `Adapter not found: ${resolved.manifest.runtime.type}`, retryable: false });

        const configuredTimeoutMs = Math.max(1, resolved.manifest.limits.timeoutSeconds) * 1000;
        const remainingMs = deadlineCap ? Math.max(1, new Date(deadlineCap).getTime() - Date.now()) : configuredTimeoutMs;
        const timeoutMs = Math.min(configuredTimeoutMs, remainingMs);
        const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
        const controller = new AbortController();
        const abortFromParent = (): void => controller.abort(Object.assign(new Error('Parent Agent execution aborted'), { code: 'PARENT_ABORTED', retryable: false }));
        const stepId = randomUUID();
        const startedAt = new Date().toISOString();
        const execution = { schemaVersion: '1.0', agentId: resolved.manifest.id, agentVersion: resolved.manifest.version, manifestHash: jsonFingerprint(resolved.manifest), inputHash: jsonFingerprint(input) };
        await this.runs.saveStep({ id: stepId, runId, kind: 'agent', name: resolved.manifest.id, status: 'running', startedAt, metadata: { execution } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortExecution: (() => void) | undefined;
        try {
            if (parentSignal?.aborted) abortFromParent();
            else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
            controller.signal.throwIfAborted();
            const request: AgentRequest<T> = {
                runId,
                scope,
                capability: run.capability,
                input,
                trustedContext: trigger.trustedContext,
                deadlineAt,
                traceContext: { correlationId: run.correlationId },
            };
            const aborted = new Promise<never>((_, reject) => {
                abortExecution = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', abortExecution, { once: true });
            });
            timer = setTimeout(() => controller.abort(Object.assign(new Error('Agent execution timed out'), { code: 'TIMEOUT', retryable: true })), timeoutMs);
            const result = await Promise.race([Promise.resolve().then(() => {
                controller.signal.throwIfAborted();
                return adapter.execute(request, resolved, controller.signal);
            }), aborted]);
            controller.signal.throwIfAborted();
            const outputErrors = result.data === undefined ? [] : validateSchema(result.data, resolved.manifest.outputSchema);
            if (outputErrors.length) throw new Error(`Invalid Agent output: ${outputErrors.join('; ')}`);
            const encoded = JSON.stringify({ data: result.data, artifacts: result.artifacts });
            if (Buffer.byteLength(encoded) > resolved.manifest.limits.maxOutputBytes) throw new Error('Agent output exceeds maxOutputBytes');
            for (const artifact of result.artifacts) if (!resolved.manifest.delivery.allowedArtifactTypes.includes(artifact.type)) throw new Error(`Artifact type is not allowed: ${artifact.type}`);
            const artifacts = result.artifacts.map((artifact): Artifact => ({ ...artifact, id: randomUUID(), runId, createdAt: new Date().toISOString(), metadata: artifact.metadata || {} }));
            await this.runs.saveArtifacts(artifacts);
            controller.signal.throwIfAborted();
            await this.runs.saveStep({
                id: stepId,
                runId,
                kind: 'agent',
                name: resolved.manifest.id,
                status: result.status === 'failed' ? 'failed' : 'succeeded',
                startedAt,
                completedAt: new Date().toISOString(),
                error: result.error,
                metadata: { ...result.metrics, execution },
            });
            controller.signal.throwIfAborted();
            if (result.status === 'failed') return this.fail(runId, result.error || { code: 'AGENT_FAILED', message: 'Agent failed', retryable: false });
            const status = result.status === 'needs_human' ? 'waiting_human' : 'succeeded';
            const finalRun = await this.runs.transition(runId, status, { completedAt: status === 'succeeded' ? new Date().toISOString() : undefined });
            return { run: finalRun, result, artifacts };
        } catch (error: any) {
            const cause = controller.signal.aborted ? controller.signal.reason : error;
            const failure = {
                code: cause?.code || 'EXECUTION_ERROR',
                message: cause?.message || String(cause),
                retryable: cause?.retryable === true,
            };
            await this.runs.saveStep({ id: stepId, runId, kind: 'agent', name: resolved.manifest.id, status: 'failed', startedAt, completedAt: new Date().toISOString(), error: failure, metadata: { execution } });
            return this.fail(runId, failure);
        } finally {
            if (timer) clearTimeout(timer);
            if (abortExecution) controller.signal.removeEventListener('abort', abortExecution);
            parentSignal?.removeEventListener('abort', abortFromParent);
        }
    }

    private requireDelegate(parentManifest: AgentManifest, capability: string): void {
        if (!parentManifest.delegates?.includes(capability) && !parentManifest.optionalDelegates?.includes(capability)) {
            throw Object.assign(new Error(`Agent delegation is not allowed: ${capability}`), { code: 'AGENT_DELEGATION_NOT_ALLOWED', retryable: false });
        }
    }

    private requireBotScope(trigger: TriggerEnvelope): void {
        const bot = this.bots.requireActive(trigger.scope.botInstanceId);
        if (bot.workspaceId !== trigger.scope.workspaceId) throw Object.assign(new Error('BotInstance does not belong to trigger workspace'), { code: 'WORKSPACE_SCOPE_MISMATCH', retryable: false });
    }

    private async fail(runId: string, error: AgentError): Promise<AgentExecutionOutcome> {
        const run = await this.runs.transition(runId, 'failed', { error, completedAt: new Date().toISOString() });
        return { run, result: errorResult(error), artifacts: [] };
    }
}
