import type { JsonSchema } from '@/platform/agents/contracts';
import type { ExecutionScope } from '@/platform/runtime/scope';
import type { ToolCallBudget } from '@/platform/tools/contracts';

export type SkillRiskLevel = 'low' | 'medium' | 'high';
export type SkillExecutionType = 'native' | 'prompt';

export interface SkillManifest {
    schemaVersion: '1.0';
    id: string;
    version: string;
    name: string;
    description: string;
    execution: { type: SkillExecutionType };
    instructionsRef: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    allowedTools: readonly string[];
    compatibleAgents: readonly string[];
    riskLevel: SkillRiskLevel;
    maxToolCalls: number;
    timeoutSeconds: number;
}

export interface SkillToolExecutor {
    execute(toolId: string, input: unknown, options?: { idempotencyKey?: string }): Promise<unknown>;
}

export interface SkillHandlerContext {
    runId: string;
    agentId: string;
    scope: Readonly<ExecutionScope>;
    trustedContext?: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    instructions: string;
    tools: SkillToolExecutor;
}

export type SkillHandler = (input: unknown, context: SkillHandlerContext) => Promise<unknown>;

export interface RegisteredSkill {
    manifest: SkillManifest;
    instructions: string;
    handler?: SkillHandler;
}

export interface SkillExecutionRequest {
    runId: string;
    agentId: string;
    scope: Readonly<ExecutionScope>;
    skillId: string;
    version?: string;
    input: unknown;
    trustedContext?: Readonly<Record<string, unknown>>;
    idempotencyKey?: string;
    signal?: AbortSignal;
    budget?: ToolCallBudget;
}

export interface PromptSkillExecutor {
    execute(skill: RegisteredSkill, input: unknown, context: SkillHandlerContext): Promise<unknown>;
}

export interface SkillMetadata {
    id: string;
    version: string;
    name: string;
    description: string;
    riskLevel: SkillRiskLevel;
    compatibleAgents: readonly string[];
}
