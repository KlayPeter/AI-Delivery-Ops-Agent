import type { AgentError, JsonSchema } from '@/platform/agents/contracts';
import type { ExecutionScope } from '@/platform/runtime/scope';

export type ToolSideEffect = 'read' | 'write';
export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface ToolDefinition {
    id: string;
    version: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    sideEffect: ToolSideEffect;
    riskLevel: ToolRiskLevel;
    idempotent: boolean;
    timeoutSeconds: number;
}

export interface ToolExecutionContext {
    runId: string;
    agentId: string;
    scope: Readonly<ExecutionScope>;
    trustedContext?: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    skillId?: string;
    idempotencyKey?: string;
}

export type ToolHandler = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

export interface RegisteredTool {
    definition: ToolDefinition;
    handler: ToolHandler;
}

export interface ToolCallRecord {
    key: string;
    toolId: string;
    status: 'running' | 'succeeded' | 'failed';
    output?: unknown;
    error?: AgentError;
    createdAt: string;
    updatedAt: string;
}

export interface ToolCallClaim {
    claimed: boolean;
    record: ToolCallRecord;
}

export interface ToolCallStore {
    claim(key: string, toolId: string, now?: Date): Promise<ToolCallClaim>;
    succeed(key: string, output: unknown, now?: Date): Promise<ToolCallRecord>;
    fail(key: string, error: AgentError, now?: Date): Promise<ToolCallRecord>;
}

export interface ToolCallBudget {
    readonly limit: number;
    readonly used: number;
    consume(toolId: string): void;
}

export interface ToolExecuteOptions {
    runId: string;
    agentId: string;
    scope: Readonly<ExecutionScope>;
    allowedTools: readonly string[];
    trustedContext?: Readonly<Record<string, unknown>>;
    skillId?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
    budget?: ToolCallBudget;
}
