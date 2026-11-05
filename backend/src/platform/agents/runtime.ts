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

export interface AgentStartOutcome { run: AgentRun; completion: Promise<AgentExecutionOutcome> }

export class AgentRuntime {
    private readonly executions = new Map<string, { run: AgentRun; controller: AbortController }>();
    private readonly runLocks = new Map<string, Promise<void>>();
    private readonly adapters = new Map<string, AgentRuntimeAdapter>();

    constructor(
        private readonly registry: AgentRegistry,
        private readonly bots: BotRegistry,
        private readonly runs: AgentRunStore,
        adapters: readonly AgentRuntimeAdapter[],
    ) { for (const adapter of adapters) this.adapters.set(adapter.type, adapter); }

    async execute<T>(trigger: TriggerEnvelope, capability: string, input: T): Promise<AgentExecutionOutcome> {
        return (await this.prepare(trigger, capability, input, false)).completion;
    }

    start<T>(trigger: TriggerEnvelope, capability: string, input: T, onPrepared: (run: AgentRun) => Promise<void>): Promise<AgentStartOutcome> {
        return this.prepare(trigger, capability, input, true, onPrepared);
    }

    async getRun(runId: string) { return this.runs.get(runId); }

    controls(run: AgentRun) {
        const execution = this.executions.get(run.id);
        return { canCancel: !run.parentRunId && run.triggerType === 'manual' && (run.status === 'waiting_human' || (['queued', 'running'].includes(run.status) && Boolean(execution && !execution.controller.signal.aborted))),
            cancellationRequested: execution?.controller.signal.reason?.code === 'RUN_CANCELLED' };
    }

    private async prepare<T>(trigger: TriggerEnvelope, capability: string, input: T, limited: boolean, onPrepared?: (run: AgentRun) => Promise<void>): Promise<AgentStartOutcome> {
        this.requireBotScope(trigger);
        const resolved = this.registry.resolve(trigger.scope.workspaceId, trigger.scope.botInstanceId, capability);
        const expected = trigger.trustedContext?.expectedExecution as { installationId?: unknown; manifestHash?: unknown } | undefined;
        if (expected !== undefined && (!expected || expected.installationId !== resolved.installation.id || expected.manifestHash !== jsonFingerprint(resolved.manifest))) {
            throw Object.assign(new Error('Agent 版本、契约或绑定已变化，未执行配方任务'), { code: 'AGENT_CONTRACT_CHANGED', retryable: false });
        }
        const now = new Date(), runId = randomUUID(), controller = new AbortController();
        const scope = createExecutionScope(trigger.scope, resolved.installation.id, { correlationId: runId });
        const run: AgentRun = { id: runId, workspaceId: scope.workspaceId, botInstanceId: scope.botInstanceId, agentInstallationId: scope.agentInstallationId, capability, triggerId: trigger.id, triggerType: trigger.type,
            correlationId: scope.correlationId, rootRunId: runId, depth: 0, status: 'queued', createdAt: now.toISOString() };
        let created = false;
        try {
            const running = await this.locked(runId, async () => {
                const active = [...this.executions.values()].filter(value => !value.run.parentRunId && value.run.triggerType === 'manual' && value.run.workspaceId === run.workspaceId && value.run.botInstanceId === run.botInstanceId);
                if (limited && active.length >= 4) throw Object.assign(new Error('已有 4 个本机任务执行中，请等待完成后重新发起'), { code: 'RUN_CAPACITY', retryable: true });
                this.executions.set(runId, { run, controller });
                await this.runs.create(run); created = true;
                const running = await this.runs.transition(runId, 'running', { startedAt: now.toISOString() });
                await onPrepared?.(running);
                return running;
            });
            const completion = this.invoke(trigger, running, resolved, input, scope, undefined, undefined, controller).finally(() => this.releaseExecution(runId, controller));
            void completion.catch(() => {});
            return { run: running, completion };
        } catch (cause: any) {
            try { if (created) await this.fail(runId, { code: cause?.code || 'RUN_PREPARE_ERROR', message: cause?.message || String(cause), retryable: false }); }
            finally { this.releaseExecution(runId, controller); }
            throw cause;
        }
    }

    async resume<T>(trigger: TriggerEnvelope, runId: string, input: T): Promise<AgentExecutionOutcome> {
        this.requireBotScope(trigger);
        const prepared = await this.locked(runId, async () => {
            const run = await this.runs.get(runId);
            if (!run) throw Object.assign(new Error(`AgentRun not found: ${runId}`), { code: 'RUN_NOT_FOUND', retryable: false });
            if (run.status !== 'waiting_human') throw Object.assign(new Error(`AgentRun is not waiting for human input: ${runId}`), { code: 'RUN_NOT_WAITING_HUMAN', retryable: false });
            if (run.workspaceId !== trigger.scope.workspaceId || run.botInstanceId !== trigger.scope.botInstanceId) throw Object.assign(new Error('Resume trigger scope does not match AgentRun'), { code: 'WORKSPACE_SCOPE_MISMATCH', retryable: false });
            if (run.parentRunId && (await this.runs.get(run.rootRunId))?.status === 'cancelled') throw Object.assign(new Error('Root run was cancelled'), { code: 'ROOT_RUN_CANCELLED', retryable: false });
            const resolved = this.registry.resolveInstallation(run.workspaceId, run.botInstanceId, run.agentInstallationId, run.capability);
            const scope = createExecutionScope(trigger.scope, resolved.installation.id, { correlationId: run.correlationId, causationId: trigger.id });
            const controller = new AbortController();
            this.executions.set(runId, { run, controller });
            try { const running = await this.runs.transition(runId, 'running', { error: undefined, completedAt: undefined }); return { running, resolved, scope, controller }; }
            catch (cause) { this.releaseExecution(runId, controller); throw cause; }
        });
        return this.invoke(trigger, prepared.running, prepared.resolved, input, prepared.scope, undefined, undefined, prepared.controller).finally(() => this.releaseExecution(runId, prepared.controller));
    }

    async cancel(runId: string, scope: { workspaceId: string; botInstanceId: string }) {
        const reason = Object.assign(new Error('用户请求停止；已完成的操作不会撤销'), { code: 'RUN_CANCELLED', retryable: false });
        const result = await this.locked(runId, async () => {
            const run = await this.runs.get(runId);
            if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.parentRunId || run.triggerType !== 'manual') return null;
            return this.cancelExecution(run, reason);
        });
        if (!result) return null;
        if (result.requested) {
            const pending = [result.run], visited = new Set([result.run.id]);
            while (pending.length) {
                const parent = pending.pop()!;
                for (const child of await this.runs.listChildren(parent.id)) {
                    if (visited.has(child.id) || child.rootRunId !== result.run.rootRunId || child.workspaceId !== scope.workspaceId || child.botInstanceId !== scope.botInstanceId) continue;
                    visited.add(child.id); pending.push(child);
                    await this.locked(child.id, async () => { const current = await this.runs.get(child.id); if (current) await this.cancelExecution(current, reason); });
                }
            }
        }
        return { ...result, run: (await this.runs.get(runId))! };
    }

    private async cancelExecution(run: AgentRun, reason: Error & AgentError) {
        if (!['queued', 'running', 'waiting_human'].includes(run.status)) return { run, requested: false };
        const execution = this.executions.get(run.id);
        if (run.status !== 'waiting_human' && !execution) return { run, requested: false };
        if (execution?.controller.signal.aborted && run.status !== 'waiting_human') return { run, requested: execution.controller.signal.reason?.code === 'RUN_CANCELLED' };
        const now = new Date().toISOString();
        await this.runs.saveStep({ id: `cancel:${run.id}`, runId: run.id, kind: 'guardrail', name: 'run.cancel', status: 'succeeded', startedAt: now, completedAt: now, metadata: { action: 'cancellation_requested', previousStatus: run.status, rootRunId: run.rootRunId } });
        const cancelled = run.status === 'waiting_human' ? await this.runs.transition(run.id, 'cancelled', { error: { code: reason.code, message: reason.message, retryable: false }, completedAt: now }) : run;
        execution?.controller.abort(reason);
        return { run: cancelled, requested: true };
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
        if (signal.reason?.code === 'RUN_CANCELLED') signal.throwIfAborted();
        this.requireDelegate(parentManifest, capability);
        const parentRun = await this.runs.get(parent.runId);
        if (!parentRun) throw Object.assign(new Error(`Parent AgentRun not found: ${parent.runId}`), { code: 'PARENT_RUN_NOT_FOUND', retryable: false });
        if (signal.reason?.code === 'RUN_CANCELLED') signal.throwIfAborted();
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
                triggerType: trigger.type,
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
                status: outcome.run.status === 'cancelled' ? 'cancelled' : outcome.run.status === 'failed' ? 'failed' : 'succeeded',
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
        suppliedController?: AbortController,
    ): Promise<AgentExecutionOutcome> {
        const runId = run.id;
        if (!resolved.manifest.triggers.includes(trigger.type)) return this.fail(runId, { code: 'TRIGGER_NOT_ALLOWED', message: `Trigger type is not allowed: ${trigger.type}`, retryable: false });
        const inputErrors = validateSchema(input, resolved.manifest.inputSchema);
        if (inputErrors.length) return this.fail(runId, { code: 'INVALID_INPUT', message: inputErrors.join('; '), retryable: false });
        const adapter = this.adapters.get(resolved.manifest.runtime.type);
        if (!adapter) return this.fail(runId, { code: 'ADAPTER_NOT_FOUND', message: `Adapter not found: ${resolved.manifest.runtime.type}`, retryable: false });

        const configuredTimeoutMs = Math.max(1, resolved.manifest.limits.timeoutSeconds) * 1000;
        const deadlineMs = Math.min(Date.now() + configuredTimeoutMs, deadlineCap ? new Date(deadlineCap).getTime() : Infinity);
        const deadlineAt = new Date(deadlineMs).toISOString();
        const controller = suppliedController || new AbortController();
        this.executions.set(runId, { run, controller });
        const abortFromParent = (): void => controller.abort(parentSignal?.reason?.code === 'RUN_CANCELLED' ? parentSignal.reason : Object.assign(new Error('Parent Agent execution aborted'), { code: 'PARENT_ABORTED', retryable: false }));
        const timeoutError = Object.assign(new Error('Agent execution timed out'), { code: 'TIMEOUT', retryable: true });
        const checkActive = (): void => {
            if (Date.now() >= deadlineMs) controller.abort(timeoutError);
            controller.signal.throwIfAborted();
        };
        const stepId = randomUUID();
        const startedAt = new Date().toISOString();
        const execution = { schemaVersion: '1.0', agentId: resolved.manifest.id, agentVersion: resolved.manifest.version, manifestHash: jsonFingerprint(resolved.manifest), inputHash: jsonFingerprint(input) };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortExecution: (() => void) | undefined;
        try {
            await this.runs.saveStep({ id: stepId, runId, kind: 'agent', name: resolved.manifest.id, status: 'running', startedAt, metadata: { execution } });
            if (parentSignal?.aborted) abortFromParent();
            else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
            checkActive();
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
            timer = setTimeout(() => controller.abort(timeoutError), Math.max(0, deadlineMs - Date.now()));
            const result = await Promise.race([Promise.resolve().then(() => {
                checkActive();
                return adapter.execute(request, resolved, controller.signal);
            }), aborted]);
            checkActive();
            const outputErrors = result.data === undefined ? [] : validateSchema(result.data, resolved.manifest.outputSchema);
            if (outputErrors.length) throw new Error(`Invalid Agent output: ${outputErrors.join('; ')}`);
            const encoded = JSON.stringify({ data: result.data, artifacts: result.artifacts });
            if (Buffer.byteLength(encoded) > resolved.manifest.limits.maxOutputBytes) throw new Error('Agent output exceeds maxOutputBytes');
            for (const artifact of result.artifacts) if (!resolved.manifest.delivery.allowedArtifactTypes.includes(artifact.type)) throw new Error(`Artifact type is not allowed: ${artifact.type}`);
            const artifacts = result.artifacts.map((artifact): Artifact => ({ ...artifact, id: randomUUID(), runId, createdAt: new Date().toISOString(), metadata: artifact.metadata || {} }));
            await this.runs.saveArtifacts(artifacts);
            checkActive();
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
            checkActive();
            if (result.status === 'failed') return await this.fail(runId, result.error || { code: 'AGENT_FAILED', message: 'Agent failed', retryable: false });
            const status = result.status === 'needs_human' ? 'waiting_human' : 'succeeded';
            const finalRun = await this.locked(runId, async () => { checkActive(); return this.runs.transition(runId, status, { completedAt: status === 'succeeded' ? new Date().toISOString() : undefined }); });
            return { run: finalRun, result, artifacts };
        } catch (error: any) {
            const cause = controller.signal.aborted ? controller.signal.reason : error;
            const failure = {
                code: cause?.code || 'EXECUTION_ERROR',
                message: cause?.message || String(cause),
                retryable: cause?.retryable === true,
            };
            const cancelled = failure.code === 'RUN_CANCELLED';
            await this.runs.saveStep({ id: stepId, runId, kind: 'agent', name: resolved.manifest.id, status: cancelled ? 'cancelled' : 'failed', startedAt, completedAt: new Date().toISOString(), error: failure, metadata: { execution } });
            return await this.fail(runId, failure, cancelled ? 'cancelled' : 'failed');
        } finally {
            if (timer) clearTimeout(timer);
            if (abortExecution) controller.signal.removeEventListener('abort', abortExecution);
            parentSignal?.removeEventListener('abort', abortFromParent);
            this.releaseExecution(runId, controller);
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

    private async fail(runId: string, error: AgentError, status: 'failed' | 'cancelled' = 'failed'): Promise<AgentExecutionOutcome> {
        const run = await this.locked(runId, async () => {
            const current = await this.runs.get(runId);
            const reason = this.executions.get(runId)?.controller.signal.reason;
            if (reason?.code === 'RUN_CANCELLED') { error = { code: reason.code, message: reason.message, retryable: false }; status = 'cancelled'; }
            return current?.status === 'cancelled' ? current : this.runs.transition(runId, status, { error, completedAt: new Date().toISOString() });
        });
        return { run, result: errorResult(run.error || error), artifacts: [] };
    }

    private releaseExecution(runId: string, controller: AbortController) {
        if (this.executions.get(runId)?.controller === controller) this.executions.delete(runId);
    }

    // Serialize cancellation with final state commits, never with the long adapter call.
    private async locked<T>(runId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.runLocks.get(runId) || Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        this.runLocks.set(runId, current);
        await previous;
        try { return await action(); }
        finally { release(); if (this.runLocks.get(runId) === current) this.runLocks.delete(runId); }
    }
}
