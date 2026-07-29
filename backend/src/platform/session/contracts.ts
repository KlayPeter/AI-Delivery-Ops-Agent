export interface AgentSessionScope {
    workspaceId: string;
    botInstanceId: string;
    channel: 'group' | 'private' | 'manual';
    conversationId: string;
    userId: string;
}

export interface AgentConversationMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
}

export interface AgentSession {
    id: string;
    scope: AgentSessionScope;
    messages: AgentConversationMessage[];
    summary?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

export interface AgentCheckpoint {
    runId: string;
    sessionId: string;
    agentId: string;
    question: string;
    fields: string[];
    status: 'waiting' | 'completed';
    createdAt: string;
    updatedAt: string;
}

export interface AgentSessionStore {
    getOrCreate(scope: AgentSessionScope, options?: { maxMessages?: number; ttlHours?: number }, now?: Date): Promise<AgentSession>;
    get(sessionId: string, now?: Date): Promise<AgentSession | null>;
    append(sessionId: string, message: Omit<AgentConversationMessage, 'id' | 'createdAt'>, options?: { maxMessages?: number; ttlHours?: number }, now?: Date): Promise<AgentSession>;
    saveCheckpoint(checkpoint: Omit<AgentCheckpoint, 'status' | 'createdAt' | 'updatedAt'>, now?: Date): Promise<AgentCheckpoint>;
    getCheckpoint(runId: string): Promise<AgentCheckpoint | null>;
    completeCheckpoint(runId: string, now?: Date): Promise<AgentCheckpoint>;
}
