import type { AgentRun, AgentRunStatus, AgentStep, Artifact } from './contracts';

type MaybePromise<T> = T | Promise<T>;

export interface AgentRunStore {
    create(run: AgentRun): MaybePromise<void>;
    transition(id: string, status: AgentRunStatus, patch?: Partial<AgentRun>): MaybePromise<AgentRun>;
    get(id: string): MaybePromise<AgentRun | null>;
    listChildren(parentRunId: string): MaybePromise<AgentRun[]>;
    saveStep(step: AgentStep): MaybePromise<void>;
    listSteps(runId: string): MaybePromise<AgentStep[]>;
    saveArtifacts(artifacts: readonly Artifact[]): MaybePromise<void>;
    listArtifacts(runId: string): MaybePromise<Artifact[]>;
}

const transitions: Record<AgentRunStatus, AgentRunStatus[]> = {
    queued: ['running', 'cancelled'], running: ['waiting_human', 'succeeded', 'failed', 'cancelled'],
    waiting_human: ['running', 'cancelled'], succeeded: [], failed: [], cancelled: [],
};

export class InMemoryAgentRunStore implements AgentRunStore {
    private readonly runs = new Map<string, AgentRun>();
    private readonly steps = new Map<string, AgentStep>();
    private readonly artifacts = new Map<string, Artifact>();

    create(run: AgentRun): void { if (this.runs.has(run.id)) throw new Error(`AgentRun exists: ${run.id}`); this.runs.set(run.id, { ...run }); }
    transition(id: string, status: AgentRunStatus, patch: Partial<AgentRun> = {}): AgentRun {
        const current = this.runs.get(id); if (!current) throw new Error(`AgentRun not found: ${id}`);
        if (!transitions[current.status].includes(status)) throw new Error(`Invalid AgentRun transition: ${current.status} -> ${status}`);
        const next = { ...current, ...patch, status }; this.runs.set(id, next); return { ...next };
    }
    get(id: string): AgentRun | null { const run = this.runs.get(id); return run ? { ...run } : null; }
    listChildren(parentRunId: string): AgentRun[] { return Array.from(this.runs.values()).filter(run => run.parentRunId === parentRunId).map(run => ({ ...run })); }
    saveStep(step: AgentStep): void { this.steps.set(step.id, { ...step }); }
    listSteps(runId: string): AgentStep[] { return Array.from(this.steps.values()).filter(step => step.runId === runId).map(step => ({ ...step })); }
    saveArtifacts(artifacts: readonly Artifact[]): void { for (const artifact of artifacts) this.artifacts.set(artifact.id, { ...artifact, metadata: { ...artifact.metadata } }); }
    listArtifacts(runId: string): Artifact[] { return Array.from(this.artifacts.values()).filter(artifact => artifact.runId === runId).map(artifact => ({ ...artifact, metadata: { ...artifact.metadata } })); }
}
