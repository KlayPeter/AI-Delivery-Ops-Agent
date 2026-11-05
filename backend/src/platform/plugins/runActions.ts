import { z } from 'zod';
import type { AgentRun } from '@/platform/agents/contracts';

export const statusPanelSchema = z.object({
    schemaVersion: z.literal('1.0'), tone: z.enum(['neutral', 'success', 'warning', 'error']),
    title: z.string().min(1).max(160), description: z.string().max(2000).optional(),
    checkedAt: z.string().datetime({ offset: true }).optional(),
    items: z.array(z.object({ label: z.string().min(1).max(1024), value: z.string().min(1).max(160), detail: z.string().max(2000).optional() }).strict()).max(20).optional(),
    relatedRun: z.object({ id: z.string().min(1).max(256), label: z.string().min(1).max(80) }).strict().optional(),
}).strict();
export type StatusPanel = z.infer<typeof statusPanelSchema>;

export interface RunAction {
    id: string; label: string; description?: string; capability: string; appliesTo: readonly string[];
    input: (runId: string) => Record<string, unknown>;
    readState: (run: AgentRun) => StatusPanel | Promise<StatusPanel>;
}
const descriptorSchema = z.object({
    id: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128), label: z.string().trim().min(1).max(80),
    description: z.string().max(2000).optional(), capability: z.string().trim().min(1).max(200),
    appliesTo: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
}).strict();

export class RunActionRegistry {
    private readonly entries = new Map<string, Readonly<RunAction>>();

    register(action: RunAction): () => void {
        const { input, readState, ...descriptor } = action;
        const metadata = descriptorSchema.parse(descriptor);
        if (typeof input !== 'function' || typeof readState !== 'function') throw new Error(`Invalid run action handlers: ${action.id}`);
        if (this.entries.has(action.id)) throw new Error(`Duplicate run action: ${action.id}`);
        const entry = Object.freeze({ ...metadata, appliesTo: Object.freeze([...metadata.appliesTo]), input, readState });
        this.entries.set(entry.id, entry);
        return () => { if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id); };
    }

    forRun(run: AgentRun): Readonly<RunAction>[] {
        return run.status === 'succeeded' ? [...this.entries.values()].filter(action => action.appliesTo.includes(run.capability)) : [];
    }
}
