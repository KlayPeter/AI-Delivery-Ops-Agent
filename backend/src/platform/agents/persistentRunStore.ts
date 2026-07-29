import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { interruptedByRestart } from '@/platform/runtime/interruption';
import type { AgentRun, AgentRunStatus, AgentStep, Artifact } from './contracts';
import type { AgentRunStore } from './runStore';

const RUN_PREFIX = 'agent:run:';
const STEP_PREFIX = 'agent:step:';
const ARTIFACT_PREFIX = 'agent:artifact:';
const transitions: Record<AgentRunStatus, AgentRunStatus[]> = {
    queued: ['running', 'cancelled'], running: ['waiting_human', 'succeeded', 'failed', 'cancelled'],
    waiting_human: ['running', 'cancelled'], succeeded: [], failed: [], cancelled: [],
};

export class PersistentAgentRunStore implements AgentRunStore {
    constructor(private readonly store: PersistentKeyValueStore) {}

    async create(run: AgentRun): Promise<void> {
        if (!await this.store.claimIdempotencyKey(this.runKey(run.id), run)) throw new Error(`AgentRun exists: ${run.id}`);
    }

    async transition(id: string, status: AgentRunStatus, patch: Partial<AgentRun> = {}): Promise<AgentRun> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.get(id);
            if (!current) throw new Error(`AgentRun not found: ${id}`);
            if (!transitions[current.status].includes(status)) throw new Error(`Invalid AgentRun transition: ${current.status} -> ${status}`);
            const next = { ...current, ...patch, status };
            if (await this.store.compareAndSetIdempotencyKey(this.runKey(id), current, next)) return next;
        }
        throw new Error(`AgentRun transition conflicted: ${id}`);
    }

    get(id: string): Promise<AgentRun | null> { return this.store.getIdempotencyValue<AgentRun>(this.runKey(id)); }

    async listChildren(parentRunId: string): Promise<AgentRun[]> {
        return (await this.store.listIdempotencyEntries<AgentRun>(RUN_PREFIX))
            .map(entry => entry.value)
            .filter(run => run.parentRunId === parentRunId)
            .map(run => structuredClone(run));
    }

    saveStep(step: AgentStep): Promise<void> { return this.store.setIdempotencyKey(this.stepKey(step.runId, step.id), step); }

    async listSteps(runId: string): Promise<AgentStep[]> {
        return (await this.store.listIdempotencyEntries<AgentStep>(this.stepPrefix(runId))).map(entry => entry.value);
    }

    async saveArtifacts(artifacts: readonly Artifact[]): Promise<void> {
        for (const artifact of artifacts) await this.store.setIdempotencyKey(this.artifactKey(artifact.runId, artifact.id), artifact);
    }

    async listArtifacts(runId: string): Promise<Artifact[]> {
        return (await this.store.listIdempotencyEntries<Artifact>(this.artifactPrefix(runId))).map(entry => entry.value);
    }

    async recoverInterrupted(now: Date = new Date()): Promise<{ runs: number; steps: number }> {
        const timestamp = now.toISOString();
        let runs = 0;
        let steps = 0;
        for (const entry of await this.store.listIdempotencyEntries<AgentRun>(RUN_PREFIX)) {
            const current = entry.value;
            if (current.status !== 'queued' && current.status !== 'running') continue;
            const next: AgentRun = {
                ...current,
                status: 'failed',
                completedAt: timestamp,
                error: interruptedByRestart(),
            };
            if (await this.store.compareAndSetIdempotencyKey(entry.key, current, next)) runs++;
        }
        for (const entry of await this.store.listIdempotencyEntries<AgentStep>(STEP_PREFIX)) {
            const current = entry.value;
            if (current.status !== 'running') continue;
            const next: AgentStep = {
                ...current,
                status: 'failed',
                completedAt: timestamp,
                error: interruptedByRestart(),
            };
            if (await this.store.compareAndSetIdempotencyKey(entry.key, current, next)) steps++;
        }
        return { runs, steps };
    }

    private runKey(id: string): string { return `${RUN_PREFIX}${encodeURIComponent(id)}`; }
    private stepPrefix(runId: string): string { return `${STEP_PREFIX}${encodeURIComponent(runId)}:`; }
    private stepKey(runId: string, id: string): string { return `${this.stepPrefix(runId)}${encodeURIComponent(id)}`; }
    private artifactPrefix(runId: string): string { return `${ARTIFACT_PREFIX}${encodeURIComponent(runId)}:`; }
    private artifactKey(runId: string, id: string): string { return `${this.artifactPrefix(runId)}${encodeURIComponent(id)}`; }
}
