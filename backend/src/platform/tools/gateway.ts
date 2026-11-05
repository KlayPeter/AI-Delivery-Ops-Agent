import { randomUUID } from 'node:crypto';
import type { AgentError } from '@/platform/agents/contracts';
import type { AgentRunStore } from '@/platform/agents/runStore';
import { validateSchema } from '@/platform/agents/schema';
import type { ToolCallStore, ToolExecuteOptions } from './contracts';
import type { ToolRegistry } from './registry';

export class ToolGateway {
    constructor(
        private readonly registry: ToolRegistry,
        private readonly calls: ToolCallStore,
        private readonly runs?: AgentRunStore,
    ) {}

    async execute(toolId: string, input: unknown, options: ToolExecuteOptions): Promise<unknown> {
        if (options.signal?.aborted) throw this.error('TOOL_CANCELLED', `Tool cancelled: ${toolId}`, false);
        if (!options.allowedTools.includes(toolId)) throw this.error('TOOL_NOT_ALLOWED', `Tool is not allowed: ${toolId}`, false);
        const tool = this.registry.resolve(toolId);
        const inputErrors = validateSchema(input, tool.definition.inputSchema);
        if (inputErrors.length) throw this.error('INVALID_TOOL_INPUT', inputErrors.join('; '), false);
        if (tool.definition.sideEffect === 'write' && !options.idempotencyKey) {
            throw this.error('IDEMPOTENCY_KEY_REQUIRED', `Write Tool requires idempotencyKey: ${toolId}`, false);
        }

        const ledgerKey = options.idempotencyKey
            ? [options.scope.workspaceId, options.scope.botInstanceId, toolId, options.idempotencyKey].map(encodeURIComponent).join(':')
            : undefined;
        if (ledgerKey) {
            const claim = await this.calls.claim(ledgerKey, toolId);
            if (!claim.claimed) {
                if (claim.record.status === 'succeeded') return structuredClone(claim.record.output);
                const prior = claim.record.error;
                throw this.error(prior?.code || 'TOOL_CALL_IN_PROGRESS', prior?.message || `Tool call already running: ${toolId}`, prior?.retryable ?? true);
            }
        }

        try {
            options.budget?.consume(toolId);
        } catch (cause: any) {
            const error = this.normalizeError(cause);
            if (ledgerKey) await this.calls.fail(ledgerKey, error).catch(() => {});
            const now = new Date().toISOString();
            try {
                await this.runs?.saveStep({
                    id: randomUUID(),
                    runId: options.runId,
                    kind: 'guardrail',
                    name: 'maxToolCalls',
                    status: 'failed',
                    startedAt: now,
                    completedAt: now,
                    error,
                    metadata: { toolId, skillId: options.skillId, limit: options.budget?.limit, used: options.budget?.used },
                });
            } catch {}
            throw Object.assign(new Error(error.message), error);
        }

        const stepId = randomUUID();
        const startedAt = new Date().toISOString();
        await this.runs?.saveStep({
            id: stepId,
            runId: options.runId,
            kind: 'tool',
            name: toolId,
            status: 'running',
            startedAt,
            metadata: { toolId, skillId: options.skillId, sideEffect: tool.definition.sideEffect, riskLevel: tool.definition.riskLevel },
        });

        const controller = new AbortController();
        const abort = () => controller.abort(this.error('TOOL_CANCELLED', `Tool cancelled: ${toolId}`, false));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            controller.signal.throwIfAborted();
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    const error = this.error('TOOL_TIMEOUT', `Tool timed out: ${toolId}`, true);
                    controller.abort(error);
                    reject(error);
                }, tool.definition.timeoutSeconds * 1000);
            });
            const output = await Promise.race([
                tool.handler(input, {
                    runId: options.runId,
                    agentId: options.agentId,
                    scope: options.scope,
                    trustedContext: options.trustedContext,
                    signal: controller.signal,
                    skillId: options.skillId,
                    idempotencyKey: options.idempotencyKey,
                }),
                timeout,
            ]);
            const outputErrors = validateSchema(output, tool.definition.outputSchema);
            if (outputErrors.length) throw this.error('INVALID_TOOL_OUTPUT', outputErrors.join('; '), false);
            if (ledgerKey) await this.calls.succeed(ledgerKey, output);
            await this.runs?.saveStep({
                id: stepId,
                runId: options.runId,
                kind: 'tool',
                name: toolId,
                status: 'succeeded',
                startedAt,
                completedAt: new Date().toISOString(),
                metadata: { toolId, skillId: options.skillId, sideEffect: tool.definition.sideEffect, riskLevel: tool.definition.riskLevel },
            });
            return output;
        } catch (cause: any) {
            const error = this.normalizeError(cause);
            if (ledgerKey) await this.calls.fail(ledgerKey, error).catch(() => {});
            await this.runs?.saveStep({
                id: stepId,
                runId: options.runId,
                kind: 'tool',
                name: toolId,
                status: 'failed',
                startedAt,
                completedAt: new Date().toISOString(),
                error,
                metadata: { toolId, skillId: options.skillId, sideEffect: tool.definition.sideEffect, riskLevel: tool.definition.riskLevel },
            });
            throw Object.assign(new Error(error.message), error);
        } finally {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        }
    }

    private normalizeError(cause: any): AgentError {
        return { code: cause?.code || 'TOOL_EXECUTION_ERROR', message: cause?.message || String(cause), retryable: cause?.retryable === true };
    }

    private error(code: string, message: string, retryable: boolean): Error {
        return Object.assign(new Error(message), { code, retryable });
    }
}
