import { randomUUID } from 'node:crypto';
import type { AgentError } from '@/platform/agents/contracts';
import type { AgentRunStore } from '@/platform/agents/runStore';
import { validateSchema } from '@/platform/agents/schema';
import type { ToolGateway } from '@/platform/tools/gateway';
import type { PromptSkillExecutor, SkillExecutionRequest, SkillHandlerContext } from './contracts';
import type { SkillRegistry } from './registry';

export class SkillRuntime {
    constructor(
        private readonly registry: SkillRegistry,
        private readonly tools: ToolGateway,
        private readonly runs?: AgentRunStore,
        private readonly promptExecutor?: PromptSkillExecutor,
    ) {}

    async execute(request: SkillExecutionRequest): Promise<unknown> {
        const skill = this.registry.resolve(request.skillId, request.agentId, request.version);
        const inputErrors = validateSchema(request.input, skill.manifest.inputSchema);
        if (inputErrors.length) throw this.error('INVALID_SKILL_INPUT', inputErrors.join('; '), false);

        const stepId = randomUUID();
        const startedAt = new Date().toISOString();
        const metadata = { skillId: skill.manifest.id, version: skill.manifest.version, riskLevel: skill.manifest.riskLevel };
        await this.runs?.saveStep({ id: stepId, runId: request.runId, kind: 'skill', name: skill.manifest.id, status: 'running', startedAt, metadata });

        const controller = new AbortController();
        const abort = () => controller.abort();
        request.signal?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let toolCalls = 0;
        const context: SkillHandlerContext = {
            runId: request.runId,
            agentId: request.agentId,
            scope: request.scope,
            trustedContext: request.trustedContext,
            signal: controller.signal,
            instructions: skill.instructions,
            tools: {
                execute: async (toolId, input, options = {}) => {
                    toolCalls++;
                    if (toolCalls > skill.manifest.maxToolCalls) throw this.error('SKILL_TOOL_LIMIT', `Skill Tool limit exceeded: ${skill.manifest.id}`, false);
                    const idempotencyKey = options.idempotencyKey || (request.idempotencyKey ? `${request.idempotencyKey}:${toolId}:${toolCalls}` : undefined);
                    return this.tools.execute(toolId, input, {
                        runId: request.runId,
                        agentId: request.agentId,
                        scope: request.scope,
                        trustedContext: request.trustedContext,
                        skillId: skill.manifest.id,
                        allowedTools: skill.manifest.allowedTools,
                        idempotencyKey,
                        signal: controller.signal,
                        budget: request.budget,
                    });
                },
            },
        };

        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(this.error('SKILL_TIMEOUT', `Skill timed out: ${skill.manifest.id}`, true));
                }, skill.manifest.timeoutSeconds * 1000);
            });
            const execution = skill.manifest.execution.type === 'native'
                ? skill.handler!(request.input, context)
                : this.executePrompt(skill, request.input, context);
            const output = await Promise.race([execution, timeout]);
            const outputErrors = validateSchema(output, skill.manifest.outputSchema);
            if (outputErrors.length) throw this.error('INVALID_SKILL_OUTPUT', outputErrors.join('; '), false);
            await this.runs?.saveStep({
                id: stepId,
                runId: request.runId,
                kind: 'skill',
                name: skill.manifest.id,
                status: 'succeeded',
                startedAt,
                completedAt: new Date().toISOString(),
                metadata: { ...metadata, toolCalls },
            });
            return output;
        } catch (cause: any) {
            const error: AgentError = { code: cause?.code || 'SKILL_EXECUTION_ERROR', message: cause?.message || String(cause), retryable: cause?.retryable === true };
            await this.runs?.saveStep({
                id: stepId,
                runId: request.runId,
                kind: 'skill',
                name: skill.manifest.id,
                status: 'failed',
                startedAt,
                completedAt: new Date().toISOString(),
                error,
                metadata: { ...metadata, toolCalls },
            });
            throw Object.assign(new Error(error.message), error);
        } finally {
            if (timer) clearTimeout(timer);
            request.signal?.removeEventListener('abort', abort);
        }
    }

    private executePrompt(skill: Parameters<PromptSkillExecutor['execute']>[0], input: unknown, context: SkillHandlerContext): Promise<unknown> {
        if (!this.promptExecutor) throw this.error('PROMPT_SKILL_RUNTIME_UNAVAILABLE', `Prompt Skill runtime is unavailable: ${skill.manifest.id}`, false);
        return this.promptExecutor.execute(skill, input, context);
    }

    private error(code: string, message: string, retryable: boolean): Error {
        return Object.assign(new Error(message), { code, retryable });
    }
}
