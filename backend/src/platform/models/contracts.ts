import type { LanguageModel } from 'ai';
import type { JsonSchema } from '@/platform/agents/contracts';

export type ModelProfile = 'fast' | 'balanced' | 'reasoning';

export interface ModelGateway {
    resolve(profile?: ModelProfile): LanguageModel;
    diagnostics(): { provider: string; model: string; configured: boolean };
}

export interface OrchestratorMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface OrchestratorTool {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    execute(input: unknown, toolCallId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface OrchestratorStepTrace {
    modelCalls: number;
    toolCalls: number;
    inputTokens?: number;
    outputTokens?: number;
    finishReason?: string;
}

export interface HumanInputRequest {
    question: string;
    fields: string[];
}

export interface OrchestratorRunRequest {
    agentId: string;
    modelProfile?: ModelProfile;
    instructions: string;
    messages: OrchestratorMessage[];
    tools: OrchestratorTool[];
    maxSteps: number;
    timeoutMs: number;
    maxOutputTokens?: number;
    temperature?: number;
    signal: AbortSignal;
    onStep?(trace: OrchestratorStepTrace): Promise<void> | void;
}

export interface OrchestratorRunResult {
    text: string;
    needsHuman?: HumanInputRequest;
    metrics: { modelCalls: number; toolCalls: number; inputTokens?: number; outputTokens?: number };
}

export interface OrchestratorAdapter {
    run(request: OrchestratorRunRequest): Promise<OrchestratorRunResult>;
}
