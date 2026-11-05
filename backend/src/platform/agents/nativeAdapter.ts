import type { AgentRequest, AgentResult, AgentRuntimeAdapter, ResolvedAgent } from './contracts';

export type NativeAgentHandler = (request: AgentRequest, resolved: ResolvedAgent, signal: AbortSignal) => Promise<AgentResult>;

export class NativeAgentAdapter implements AgentRuntimeAdapter {
    readonly type = 'native' as const;
    private readonly handlers = new Map<string, NativeAgentHandler>();
    register(agentId: string, version: string, handler: NativeAgentHandler): () => void {
        const key = `${agentId}@${version}`;
        if (this.handlers.has(key)) throw new Error(`Native Agent already registered: ${key}`);
        this.handlers.set(key, handler);
        return () => { this.handlers.delete(key); };
    }
    async execute(request: AgentRequest, resolved: ResolvedAgent, signal: AbortSignal): Promise<AgentResult> {
        const handler = this.handlers.get(`${resolved.manifest.id}@${resolved.manifest.version}`);
        if (!handler) throw new Error(`Native Agent handler not found: ${resolved.manifest.id}@${resolved.manifest.version}`);
        return handler(request, resolved, signal);
    }
}
