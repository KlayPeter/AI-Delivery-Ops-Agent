import type { GroupConfig } from '@/core/config';
import type { HandlerContext } from '@/services/messageHandler/types';
import type { ScheduledAgentDispatcher } from '@/platform/bootstrap/scheduledAgentDispatcher';

export interface ScheduleContext {
    ctx: HandlerContext;
    now: Date;
    agents?: ScheduledAgentDispatcher;
    resources: Map<unknown, unknown>;
}

export interface GroupScheduleContext extends ScheduleContext { group: GroupConfig }

export interface SchedulePlan { day: Date; date: string; time: string }

export interface ScheduledJobRequest extends GroupScheduleContext { day: Date; retryAttempt: number }

export type GroupSchedule = { id: string; priority: number } & ({
    kind: 'timed';
    agent?: boolean;
    plan: (context: GroupScheduleContext) => SchedulePlan | null;
    run: (context: ScheduledJobRequest) => Promise<any>;
} | {
    kind: 'global-poll';
    run: (context: ScheduleContext) => Promise<Record<string, string>>;
} | {
    kind: 'poll';
    run: (context: GroupScheduleContext) => Promise<Record<string, string>>;
});

export class ScheduleRegistry {
    private readonly entries = new Map<string, GroupSchedule>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private stopped = false;

    register(schedule: GroupSchedule): () => void {
        if (!/^[a-z][a-z0-9.-]*$/.test(schedule.id) || !Number.isFinite(schedule.priority)
            || typeof schedule.run !== 'function' || !['timed', 'poll', 'global-poll'].includes(schedule.kind)
            || (schedule.kind === 'timed' && (typeof schedule.plan !== 'function'
                || (schedule.agent !== undefined && typeof schedule.agent !== 'boolean')))) {
            throw new Error(`Invalid group schedule: ${schedule.id}`);
        }
        if (this.entries.has(schedule.id)) throw new Error(`Duplicate group schedule: ${schedule.id}`);
        if (this.list().some(entry => entry.priority === schedule.priority)) throw new Error(`Duplicate schedule priority: ${schedule.priority}`);
        const entry = Object.freeze({ ...schedule });
        this.entries.set(schedule.id, entry);
        return () => { if (this.entries.get(schedule.id) === entry) this.entries.delete(schedule.id); };
    }

    get(id: string): GroupSchedule | undefined { return this.entries.get(id); }

    list(): GroupSchedule[] { return [...this.entries.values()].sort((a, b) => b.priority - a.priority); }

    run<T>(work: () => Promise<T>): Promise<T> {
        if (this.stopped) return Promise.reject(new Error('Scheduling is stopped'));
        const pending = Promise.resolve().then(work);
        this.inFlight.add(pending);
        return pending.finally(() => { this.inFlight.delete(pending); });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await Promise.allSettled(this.inFlight);
    }
}
