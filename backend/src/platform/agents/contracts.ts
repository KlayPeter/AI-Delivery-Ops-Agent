import type { BotAgentBinding } from '@/platform/bots/contracts';
import type { ExecutionScope, TriggerType } from '@/platform/runtime/scope';
import type { JsonSchemaType } from '@modelcontextprotocol/client';

export type AgentRuntimeType = 'native' | 'model-loop' | 'a2a' | 'mcp-agent' | 'http' | 'process' | 'container';
export type AgentInstallationStatus = 'active' | 'disabled' | 'error';
export type AgentRunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled';
export type AgentStepStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JsonSchema = JsonSchemaType;

export interface AgentManifest {
    schemaVersion: '1.0' | '1.1';
    id: string;
    name: string;
    version: string;
    description: string;
    runtime: { type: AgentRuntimeType; engine?: 'ai-sdk'; entrypoint?: string };
    capabilities: readonly string[];
    triggers: readonly TriggerType[];
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    requirements: { tools: readonly string[]; secrets: readonly string[]; networkHosts: readonly string[] };
    limits: { timeoutSeconds: number; maxSteps: number; maxToolCalls: number; maxAgentCalls: number; maxDepth?: number; maxOutputBytes: number };
    delivery: { allowedArtifactTypes: readonly ArtifactType[]; directDelivery: false };
    instructionsRef?: string;
    modelProfile?: 'fast' | 'balanced' | 'reasoning';
    skills?: readonly string[];
    delegates?: readonly string[];
    optionalDelegates?: readonly string[];
    memory?: { mode: 'none' | 'session'; maxMessages: number; ttlHours: number };
}

export interface AgentInstallation {
    id: string;
    workspaceId: string;
    agentId: string;
    version: string;
    status: AgentInstallationStatus;
    config: Readonly<Record<string, unknown>>;
    secretRefs: Readonly<Record<string, string>>;
}

export type ArtifactType = 'text' | 'markdown' | 'article_list' | 'json' | 'file' | 'image';

export interface ArtifactInput {
    type: ArtifactType;
    mediaType: string;
    schemaVersion: string;
    content?: unknown;
    storageRef?: string;
    checksum?: string;
    metadata?: Readonly<Record<string, unknown>>;
}

export interface Artifact extends ArtifactInput {
    id: string;
    runId: string;
    createdAt: string;
    metadata: Readonly<Record<string, unknown>>;
}

export interface AgentError { code: string; message: string; retryable: boolean }

export interface AgentRequest<TInput = unknown> {
    runId: string;
    scope: Readonly<ExecutionScope>;
    capability: string;
    input: TInput;
    trustedContext?: Readonly<Record<string, unknown>>;
    deadlineAt: string;
    traceContext: Readonly<Record<string, string>>;
}

export interface AgentResult<TData = unknown> {
    status: 'succeeded' | 'failed' | 'needs_human';
    data?: TData;
    artifacts: ArtifactInput[];
    error?: AgentError;
    metrics?: { modelCalls?: number; toolCalls?: number; inputTokens?: number; outputTokens?: number };
}

export interface AgentRun {
    id: string;
    workspaceId: string;
    botInstanceId: string;
    agentInstallationId: string;
    capability: string;
    triggerId: string;
    correlationId: string;
    rootRunId: string;
    parentRunId?: string;
    depth: number;
    status: AgentRunStatus;
    error?: AgentError;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}

export interface AgentStep {
    id: string;
    runId: string;
    kind: 'agent' | 'model' | 'skill' | 'tool' | 'guardrail' | 'delivery';
    name: string;
    status: AgentStepStatus;
    startedAt: string;
    completedAt?: string;
    error?: AgentError;
    metadata?: Readonly<Record<string, unknown>>;
}

export interface ResolvedAgent {
    manifest: AgentManifest;
    installation: AgentInstallation;
    binding: BotAgentBinding;
}

export interface AgentRuntimeAdapter {
    readonly type: AgentRuntimeType;
    execute(request: AgentRequest, resolved: ResolvedAgent, signal: AbortSignal): Promise<AgentResult>;
}
