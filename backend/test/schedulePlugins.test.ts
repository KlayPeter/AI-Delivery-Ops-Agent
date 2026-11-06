import { describe, expect, test } from 'bun:test';
import { InProcessScheduler } from '@/core/scheduler';
import { buildConfig, type GroupConfig } from '@/core/config';
import { dailySummaryPlugin } from '@/agents/plugins/dailySummary';
import { standupPlugin } from '@/agents/plugins/standup';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { ScheduleRegistry, type GroupSchedule, type GroupScheduleContext, type ScheduleContext } from '@/platform/scheduling/registry';

function fixture() {
    const claims = new Set<string>();
    const logs: string[] = [];
    const raw = {
        project: { name: 'Test' }, maintenance: { enabled: false },
        groups: [{ chat_id: 'group-1', schedule: {
            workdays_only: false, standup_push: '09:00', task_standup_template: '09:00', task_standup_enabled: true,
            overdue_scan: '09:00', daily_summary: '09:00', dashboard: '09:00', weekly_report: '09:00',
            standup_push_enabled: true, standup_summary_enabled: true, module_standup_enabled: true,
            daily_summary_enabled: true, module_daily_summary_enabled: true, overdue_scan_enabled: true,
        } }],
    };
    const ctx: any = {
        config: buildConfig(raw), schedules: new ScheduleRegistry(), feishu: {},
        store: Object.assign(new InMemoryPersistentKeyValueStore(), {
            getDynamicConfig: async () => raw,
            claimIdempotencyKey: async (key: string) => { if (claims.has(key)) return false; claims.add(key); return true; },
            setIdempotencyKey: async () => {},
            appendAuditLog: async (event: string) => { logs.push(event); },
            saveTask: async () => { throw new Error('Disabled task plugin cannot write'); },
        }),
    };
    const scheduler = (agents?: any) => new InProcessScheduler(() => ({ ctx }) as any, 30, 0, agents, 0);
    const host = (plugins: FeaturePlugin[]) => new AgentHost(() => ctx, 10, undefined, [], { plugins, schedules: ctx.schedules });
    return { ctx, claims, logs, scheduler, host };
}

describe('Plugin-owned group scheduling', () => {
    test('rejects invalid and ambiguous schedule registrations and disposes safely', () => {
        const registry = new ScheduleRegistry();
        const schedule: GroupSchedule = { id: 'example.first', priority: 1, kind: 'timed', plan: () => null, run: async () => ({}) };
        const dispose = registry.register(schedule);
        expect(() => registry.register(schedule)).toThrow('Duplicate group schedule');
        expect(() => registry.register({ ...schedule, id: 'example.second' })).toThrow('priority');
        expect(() => registry.register({ ...schedule, id: 'example.invalid', plan: undefined } as any)).toThrow('Invalid');
        dispose();
        registry.register(schedule);
        dispose();
        expect(registry.list()).toHaveLength(1);
    });

    test('an empty registry has no implicit business schedules despite configured times', async () => {
        const { scheduler, claims, ctx } = fixture();
        expect(await scheduler().tick(new Date(2026, 6, 10, 9, 0))).toEqual({});
        delete ctx.schedules;
        expect(await scheduler().tick(new Date(2026, 6, 10, 9, 0))).toEqual({});
        expect(claims.size).toBe(0);
    });

    test('global polls run without groups once per interval and isolate failures', async () => {
        const { ctx, logs } = fixture();
        ctx.store.getDynamicConfig = async () => ({ groups: [] as GroupConfig[], maintenance: { enabled: false } });
        let calls = 0;
        ctx.schedules.register({ id: 'test.global-failure', priority: 2, kind: 'global-poll', run: async () => { throw new Error('Unavailable'); } });
        ctx.schedules.register({ id: 'test.global-success', priority: 1, kind: 'global-poll', run: async (context: ScheduleContext) => {
            expect('group' in context).toBe(false); calls++; return { 'test.global-success': 'completed' };
        } });
        const clock = new InProcessScheduler(() => ({ ctx }) as any, 30, 60);
        try {
            expect(await clock.tick(new Date('2026-11-06T00:00:00Z'))).toEqual({ 'test.global-failure': 'failed', 'test.global-success': 'completed' });
            expect(await clock.tick(new Date('2026-11-06T00:00:30Z'))).toEqual({});
            await clock.tick(new Date('2026-11-06T00:01:00Z'));
            expect(calls).toBe(2); expect(logs.filter(event => event === 'scheduler_poll_failed')).toHaveLength(2);
        } finally { await clock.stop(); }
    });

    test('removing task and standup plugins prevents their scans, prompts and claims', async () => {
        const { ctx, scheduler, host, claims } = fixture();
        let summaries = 0;
        const runtime = host([dailySummaryPlugin]);
        await runtime.initialize();
        try {
            const result = await scheduler({
                flushDeliveries: async () => {}, dailySummary: async () => { summaries++; return { status: 'completed' }; },
            }).tick(new Date(2026, 6, 10, 9, 0));
            expect(result).toEqual({ 'daily-summary:group-1': 'completed' });
            expect(summaries).toBe(1);
            expect(claims.size).toBe(0);
        } finally { await runtime.stop(); }
        expect(ctx.schedules.list()).toEqual([]);
    });

    test('a third-party schedule runs through idempotency and Host stop drains it', async () => {
        const { ctx, host, scheduler, claims } = fixture();
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const finish = new Promise<void>(resolve => { release = resolve; });
        let disposed = false;
        const plugin: FeaturePlugin = {
            manifest: { apiVersion: '1.0', id: 'example.schedule', name: 'Schedule', version: '1.0.0', description: 'Third-party scheduled work' },
            schedules: [{
                id: 'example.schedule', priority: 1, kind: 'timed',
                plan: context => ({ day: context.now, date: '2026-07-10', time: '09:00' }),
                async run() { entered(); await finish; return { ok: true }; },
            }],
            apply(context) { context.effect(() => () => { disposed = true; }); },
        };
        const runtime = host([plugin]);
        await runtime.initialize();
        const engine = scheduler();
        const tick = engine.tick(new Date(2026, 6, 10, 9, 0));
        await started;
        const stopping = runtime.stop();
        let engineStopped = false;
        const engineStopping = engine.stop().then(() => { engineStopped = true; });
        await Promise.resolve();
        expect(disposed).toBe(false);
        expect(engineStopped).toBe(false);
        await expect(ctx.schedules.run(async () => ({}))).rejects.toThrow('stopped');
        release();
        expect(await tick).toEqual({ 'example.schedule:group-1': 'completed' });
        await stopping;
        await engineStopping;
        expect(disposed).toBe(true);
        expect(claims.has('scheduled:example.schedule:group-1:2026-07-10:09:00')).toBe(true);
        expect(ctx.schedules.list()).toEqual([]);
        expect(engineStopped).toBe(true);
        await expect(engine.tick(new Date())).rejects.toThrow('stopped');
    });

    test('a bad plan or polling error does not block other plugin jobs', async () => {
        const { ctx, scheduler, logs, claims } = fixture();
        ctx.schedules.register({ id: 'example.bad', priority: 3, kind: 'timed', plan: () => ({ day: new Date('invalid'), date: '2026-07-10', time: '09:00' }), run: async () => { throw new Error('Must not execute'); } });
        ctx.schedules.register({ id: 'example.poll', priority: 2, kind: 'poll', run: async () => { throw new Error('Polling failed'); } });
        ctx.schedules.register({ id: 'example.good', priority: 1, kind: 'timed', plan: (context: GroupScheduleContext) => ({ day: context.now, date: '2026-07-10', time: '09:00' }), run: async () => ({ ok: true }) });
        expect(await scheduler().tick(new Date(2026, 6, 10, 9, 0))).toEqual({
            'example.bad:group-1': 'failed', 'example.poll:group-1': 'failed', 'example.good:group-1': 'completed',
        });
        expect(logs).toEqual(['job_plan_failed', 'scheduler_poll_failed', 'job_completed']);
        expect(claims.size).toBe(1);
    });

    test('a midnight standup supplement retains the previous business day and its calendar', () => {
        const { ctx } = fixture();
        const group = ctx.config.groups[0];
        group.schedule.standup_summary = '23:30';
        const context: GroupScheduleContext = { ctx, group, now: new Date(2026, 6, 11, 0, 30), resources: new Map() };
        const schedule = standupPlugin.schedules!.find(entry => entry.id === 'standup-supplement-summary')!;
        if (schedule.kind !== 'timed') throw new Error('Expected a timed schedule');
        expect(schedule.plan(context)?.date).toBe('2026-07-10');
        group.schedule.calendar = { mode: 'every_day', dates: { '2026-07-10': false } };
        expect(schedule.plan(context)).toBeNull();
    });
});
