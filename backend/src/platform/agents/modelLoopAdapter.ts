import { randomUUID } from 'node:crypto';
import type { AgentManifest, AgentRequest, AgentResult, AgentRuntimeAdapter, Artifact, JsonSchema, ResolvedAgent } from './contracts';
import type { AgentExecutionOutcome } from './runtime';
import type { AgentRunStore } from './runStore';
import type { OrchestratorAdapter, OrchestratorStepTrace, OrchestratorTool } from '@/platform/models/contracts';
import type { AgentSession, AgentSessionScope, AgentSessionStore } from '@/platform/session/contracts';
import type { SkillRegistry } from '@/platform/skills/registry';
import type { SkillRuntime } from '@/platform/skills/runtime';
import { RunToolCallBudget } from '@/platform/tools/budget';
import type { ToolCallBudget } from '@/platform/tools/contracts';
import type { ToolGateway } from '@/platform/tools/gateway';
import type { ToolRegistry } from '@/platform/tools/registry';

export interface ModelLoopAgentDefinition {
    instructions: string;
    artifactTitle?: string;
}

export interface AgentDelegateExecutor {
    describeDelegate(parent: AgentRequest, parentManifest: AgentManifest, capability: string): {
        name: string;
        description: string;
        inputSchema: JsonSchema;
    };
    delegate(
        parent: AgentRequest,
        parentManifest: AgentManifest,
        capability: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<AgentExecutionOutcome>;
}

export class ModelLoopAgentAdapter implements AgentRuntimeAdapter {
    readonly type = 'model-loop' as const;
    private readonly definitions = new Map<string, ModelLoopAgentDefinition>();
    private delegateExecutor?: AgentDelegateExecutor;

    constructor(
        private readonly orchestrator: OrchestratorAdapter,
        private readonly tools: ToolRegistry,
        private readonly toolGateway: ToolGateway,
        private readonly skills: SkillRegistry,
        private readonly skillRuntime: SkillRuntime,
        private readonly sessions: AgentSessionStore,
        private readonly runs?: AgentRunStore,
    ) {}

    register(agentId: string, version: string, definition: ModelLoopAgentDefinition): void {
        const key = `${agentId}@${version}`;
        if (this.definitions.has(key)) throw new Error(`Model Loop Agent already registered: ${key}`);
        if (!definition.instructions.trim()) throw new Error(`Model Loop Agent instructions are required: ${key}`);
        this.definitions.set(key, { ...definition });
    }

    setDelegateExecutor(executor: AgentDelegateExecutor): void {
        this.delegateExecutor = executor;
    }

    async execute(request: AgentRequest, resolved: ResolvedAgent, signal: AbortSignal): Promise<AgentResult> {
        const definition = this.definitions.get(`${resolved.manifest.id}@${resolved.manifest.version}`);
        if (!definition) throw new Error(`Model Loop Agent definition not found: ${resolved.manifest.id}@${resolved.manifest.version}`);
        const checkpoint = await this.sessions.getCheckpoint(request.runId);
        const memory = resolved.manifest.memory || { mode: 'session' as const, maxMessages: 20, ttlHours: 24 * 7 };
        const session = checkpoint?.status === 'waiting'
            ? await this.requireSession(checkpoint.sessionId)
            : await this.sessions.getOrCreate(this.sessionScope(request), { maxMessages: memory.maxMessages, ttlHours: memory.ttlHours });
        const prompt = this.prompt(request.input);
        const updated = await this.sessions.append(session.id, { role: 'user', content: prompt }, { maxMessages: memory.maxMessages, ttlHours: memory.ttlHours });
        const instructions = memory.mode === 'session' && updated.summary
            ? `${definition.instructions}\n\nEarlier session context:\n${updated.summary}`
            : definition.instructions;
        const delegatedArtifacts: Artifact[] = [];
        const priorToolCalls = this.runs
            ? (await this.runs.listSteps(request.runId)).filter(step => step.kind === 'tool').length
            : 0;
        const toolBudget = new RunToolCallBudget(resolved.manifest.limits.maxToolCalls, priorToolCalls);
        const orchestratorTools = this.toolsFor(request, resolved, delegatedArtifacts, toolBudget);
        const result = await this.orchestrator.run({
            agentId: resolved.manifest.id,
            modelProfile: resolved.manifest.modelProfile,
            instructions,
            messages: (memory.mode === 'session' ? updated.messages : updated.messages.slice(-1)).map(message => ({ role: message.role, content: message.content })),
            tools: orchestratorTools,
            maxSteps: resolved.manifest.limits.maxSteps,
            timeoutMs: Math.max(1, new Date(request.deadlineAt).getTime() - Date.now()),
            signal,
            onStep: trace => this.saveModelStep(request.runId, resolved.manifest.id, trace),
        });

        if (result.needsHuman) {
            await this.sessions.saveCheckpoint({
                runId: request.runId,
                sessionId: updated.id,
                agentId: resolved.manifest.id,
                question: result.needsHuman.question,
                fields: result.needsHuman.fields,
            });
            await this.sessions.append(updated.id, { role: 'assistant', content: result.needsHuman.question }, { maxMessages: memory.maxMessages, ttlHours: memory.ttlHours });
            return {
                status: 'needs_human',
                data: { text: result.needsHuman.question, needsHuman: true, fields: result.needsHuman.fields },
                artifacts: [{
                    type: 'markdown',
                    mediaType: 'text/markdown',
                    schemaVersion: '1.0',
                    content: result.needsHuman.question,
                    metadata: { title: definition.artifactTitle || resolved.manifest.name, waitingHuman: true },
                }, ...this.promotedArtifacts(delegatedArtifacts)],
                metrics: result.metrics,
            };
        }

        if (checkpoint?.status === 'waiting') await this.sessions.completeCheckpoint(request.runId);
        await this.sessions.append(updated.id, { role: 'assistant', content: result.text }, { maxMessages: memory.maxMessages, ttlHours: memory.ttlHours });
        return {
            status: 'succeeded',
            data: { text: result.text },
            artifacts: result.text ? [{
                type: 'markdown',
                mediaType: 'text/markdown',
                schemaVersion: '1.0',
                content: result.text,
                metadata: { title: definition.artifactTitle || resolved.manifest.name },
            }, ...this.promotedArtifacts(delegatedArtifacts)] : this.promotedArtifacts(delegatedArtifacts),
            metrics: result.metrics,
        };
    }

    private toolsFor(
        request: AgentRequest,
        resolved: ResolvedAgent,
        delegatedArtifacts: Artifact[],
        toolBudget: ToolCallBudget,
    ): OrchestratorTool[] {
        const definitions: OrchestratorTool[] = resolved.manifest.requirements.tools.map(toolId => {
            const tool = this.tools.resolve(toolId).definition;
            return {
                name: this.safeName(`tool_${toolId}`),
                description: tool.description,
                inputSchema: tool.inputSchema,
                execute: (input, toolCallId, signal) => this.toolGateway.execute(toolId, input, {
                    runId: request.runId,
                    agentId: resolved.manifest.id,
                    scope: request.scope,
                    trustedContext: request.trustedContext,
                    allowedTools: resolved.manifest.requirements.tools,
                    idempotencyKey: `${request.runId}:${toolCallId}`,
                    signal,
                    budget: toolBudget,
                }),
            };
        });
        for (const skillId of resolved.manifest.skills || []) {
            const skill = this.skills.resolve(skillId, resolved.manifest.id);
            definitions.push({
                name: this.safeName(`skill_${skillId}`),
                description: skill.manifest.description,
                inputSchema: skill.manifest.inputSchema,
                execute: (input, toolCallId, signal) => this.skillRuntime.execute({
                    runId: request.runId,
                    agentId: resolved.manifest.id,
                    scope: request.scope,
                    trustedContext: request.trustedContext,
                    skillId,
                    input,
                    idempotencyKey: `${request.runId}:${toolCallId}`,
                    signal,
                    budget: toolBudget,
                }),
            });
        }
        let agentCalls = 0;
        const requiredDelegates = new Set(resolved.manifest.delegates || []);
        const delegateCapabilities = [...requiredDelegates, ...(resolved.manifest.optionalDelegates || []).filter(capability => !requiredDelegates.has(capability))];
        for (const capability of delegateCapabilities) {
            if (!this.delegateExecutor) throw new Error(`Agent delegate executor is not configured: ${capability}`);
            let descriptor;
            try {
                descriptor = this.delegateExecutor.describeDelegate(request, resolved.manifest, capability);
            } catch (error) {
                if (!requiredDelegates.has(capability)) continue;
                throw error;
            }
            definitions.push({
                name: this.safeName(`agent_${capability}`),
                description: `Delegate to ${descriptor.name}: ${descriptor.description}. To resume a waiting child Run, include its resumeRunId with the new prompt.`,
                inputSchema: descriptor.inputSchema,
                execute: async (input, _toolCallId, signal) => {
                    agentCalls++;
                    if (agentCalls > resolved.manifest.limits.maxAgentCalls) {
                        throw Object.assign(new Error(`Agent call limit exceeded: ${resolved.manifest.limits.maxAgentCalls}`), { code: 'AGENT_CALL_LIMIT_EXCEEDED', retryable: false });
                    }
                    const outcome = await this.delegateExecutor!.delegate(request, resolved.manifest, capability, input, signal);
                    delegatedArtifacts.push(...outcome.artifacts.filter(artifact => artifact.type !== 'markdown'));
                    return {
                        runId: outcome.run.id,
                        status: outcome.run.status,
                        data: outcome.result.data,
                        error: outcome.result.error,
                        artifacts: outcome.artifacts.map(artifact => ({
                            type: artifact.type,
                            mediaType: artifact.mediaType,
                            content: artifact.type === 'markdown' || artifact.type === 'article_list' ? artifact.content : undefined,
                            metadata: artifact.metadata,
                        })),
                    };
                },
            });
        }
        const names = new Set<string>();
        for (const tool of definitions) {
            if (names.has(tool.name)) throw new Error(`Agent Tool name collision: ${tool.name}`);
            names.add(tool.name);
        }
        return definitions;
    }

    private promotedArtifacts(artifacts: readonly Artifact[]) {
        return artifacts.map(artifact => ({
            type: artifact.type,
            mediaType: artifact.mediaType,
            schemaVersion: artifact.schemaVersion,
            content: artifact.content,
            metadata: { ...artifact.metadata, delegatedFromRunId: artifact.runId },
        }));
    }

    private sessionScope(request: AgentRequest): AgentSessionScope {
        const channel = request.scope.chatId ? 'group' : request.scope.conversationId ? 'private' : 'manual';
        return {
            workspaceId: request.scope.workspaceId,
            botInstanceId: request.scope.botInstanceId,
            channel,
            conversationId: request.scope.chatId || request.scope.conversationId || request.scope.triggerId,
            userId: request.scope.actorId || 'system',
        };
    }

    private prompt(input: unknown): string {
        if (typeof input === 'string') return input;
        if (input && typeof input === 'object' && typeof (input as any).prompt === 'string') return (input as any).prompt;
        return JSON.stringify(input);
    }

    private async requireSession(sessionId: string): Promise<AgentSession> {
        const session = await this.sessions.get(sessionId);
        if (!session) throw Object.assign(new Error(`Agent session expired: ${sessionId}`), { code: 'SESSION_EXPIRED', retryable: false });
        return session;
    }

    private async saveModelStep(runId: string, name: string, trace: OrchestratorStepTrace): Promise<void> {
        const now = new Date().toISOString();
        await this.runs?.saveStep({ id: randomUUID(), runId, kind: 'model', name, status: 'succeeded', startedAt: now, completedAt: now, metadata: { ...trace } });
    }

    private safeName(id: string): string { return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64); }
}
