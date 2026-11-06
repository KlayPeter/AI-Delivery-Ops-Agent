import { expect, test } from 'bun:test';
import { buildConfig } from '@/core/config';
import { InProcessScheduler } from '@/core/scheduler';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { ScheduleRegistry } from '@/platform/scheduling/registry';
import { maintenancePlugin } from '@/agents/plugins/maintenance';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

const due = new Date('2026-11-06T03:30:00Z');
function fixture() {
    let deletes = 0;
    let onDelete: (() => Promise<void>) | undefined;
    const rows = [...Array(75).fill('2026-01-01T00:00:00Z'), '2026-11-01T00:00:00Z'];
    const logs: Array<{ event: string; payload: any }> = [];
    const raw: any = { maintenance: { enabled: true, cleanup_time: '03:30', cleanup_timezone: 'UTC', cleanup_batch_size: 50, cleanup_max_batches: 1 }, groups: [] };
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), {
        getDynamicConfig: async () => raw,
        deleteAuditLogsBefore: async (cutoff: string, limit: number) => { deletes++; await onDelete?.(); const expired = rows.filter(row => row < cutoff).slice(0, limit); for (const row of expired) rows.splice(rows.indexOf(row), 1); return expired.length; },
        countAuditLogsBefore: async (cutoff: string) => rows.filter(row => row < cutoff).length,
        listRawIdempotencyRecords: async (): Promise<Array<{ key: string; value: string }>> => [], deleteIdempotencyKeys: async () => 0,
        appendAuditLog: async (event: string, payload: unknown) => { logs.push({ event, payload }); },
    });
    const ctx: any = { config: buildConfig(raw), store, schedules: new ScheduleRegistry(), feishu: {}, tapd: {} };
    const create = (plugins: FeaturePlugin[] = [maintenancePlugin]) => {
        ctx.schedules = new ScheduleRegistry();
        return new AgentHost(() => ctx, 1000, undefined, [], { plugins, schedules: ctx.schedules });
    };
    const scheduler = (interval = 3600) => new InProcessScheduler(() => ({ ctx }) as any, 30, interval);
    return { raw, ctx, store, create, scheduler, rows, logs, deletes: () => deletes, onDelete: (callback: () => Promise<void>) => { onDelete = callback; } };
}

test('an empty plugin composition never attempts audit cleanup at the configured due time', async () => {
    const f = fixture(), host = f.create([]), scheduler = f.scheduler();
    try { await host.initialize(); await scheduler.tick(due); expect(f.deletes()).toBe(0); expect(f.rows).toHaveLength(76); }
    finally { await scheduler.stop(); await host.stop(); }
});

test('retention keeps its due clock, batch limit and durable daily receipt across host replacement', async () => {
    const f = fixture(), host = f.create(), clock = f.scheduler();
    try {
        await host.initialize(); expect(host.schedules.list()[0]?.kind).toBe('global-tick'); expect(await host.listAgents()).toEqual([]);
        await clock.tick(new Date('2026-11-06T03:29:00Z')); expect(f.deletes()).toBe(0);
        await clock.tick(due); expect(f.deletes()).toBe(1); expect(f.rows).toHaveLength(26);
        expect(f.logs.find(log => log.event === 'maintenance_cleanup_completed')?.payload).toMatchObject({ auditLogsDeleted: 50, remainingExpiredAuditLogs: 25, batches: 1 });
        await clock.tick(new Date('2026-11-06T03:30:30Z')); expect(f.deletes()).toBe(1);
    } finally { await clock.stop(); await host.stop(); }
    const restored = f.create(), next = f.scheduler();
    try {
        await restored.initialize(); await next.tick(due); expect(f.deletes()).toBe(1);
        await next.tick(new Date('2026-11-07T03:30:00Z')); expect(f.deletes()).toBe(2); expect(f.rows).toEqual(['2026-11-01T00:00:00Z']);
    } finally { await next.stop(); await restored.stop(); }
});

test('the disabled maintenance flag prevents deletion even when its plugin is installed', async () => {
    const f = fixture(); f.raw.maintenance.enabled = false;
    const host = f.create(), clock = f.scheduler();
    try { await host.initialize(); await clock.tick(due); expect(f.deletes()).toBe(0); expect(f.logs).toEqual([]); }
    finally { await clock.stop(); await host.stop(); }
});

test('cleanup failure retains a failed receipt, does not erase rows and does not block other global work', async () => {
    const f = fixture(); f.onDelete(async () => { throw new Error('Fixture cleanup unavailable'); });
    const probe: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'example.global', name: 'Probe', version: '1.0.0', description: 'Global fixture' }, schedules: [{ id: 'example.global', priority: 1, kind: 'global-tick', run: async () => ({ probe: 'completed' }) }], apply() {} };
    const host = f.create([maintenancePlugin, probe]), clock = f.scheduler();
    try {
        await host.initialize(); expect(await clock.tick(due)).toEqual({ probe: 'completed' });
        expect(f.rows).toHaveLength(76); expect(f.logs[0]?.event).toBe('maintenance_cleanup_failed');
        expect(await f.store.getIdempotencyValue('maintenance:cleanup:2026-11-06')).toMatchObject({ status: 'failed' });
        await clock.tick(due); expect(f.deletes()).toBe(1);
    } finally { await clock.stop(); await host.stop(); }
});

test('Host stop drains accepted cleanup before releasing its schedule', async () => {
    const f = fixture(); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.onDelete(async () => { entered(); await gate; });
    const host = f.create(), clock = f.scheduler(); await host.initialize();
    const pending = clock.tick(due); await ready;
    let stopped = false; const stopping = host.stop().then(() => { stopped = true; });
    try { await Promise.resolve(); expect(stopped).toBe(false); expect(host.schedules.list()).toHaveLength(1); }
    finally { release(); await pending; await stopping; await clock.stop(); }
    expect(stopped).toBe(true); expect(host.schedules.list()).toEqual([]); expect(f.rows).toHaveLength(26);
});

test('global ticks run once before group work and independently of the global-poll interval', async () => {
    const f = fixture(), observed: string[] = [];
    f.raw.groups = [{ chat_id: 'oc_a' }, { chat_id: 'oc_b' }];
    const plugin: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'example.phases', name: 'Phases', version: '1.0.0', description: 'Global phase fixture' }, schedules: [
        { id: 'example.poll', priority: 1, kind: 'global-poll', run: async () => { observed.push('global-poll'); return {}; } },
        { id: 'example.tick', priority: 2, kind: 'global-tick', run: async () => { observed.push('global-tick'); return {}; } },
        { id: 'example.group', priority: 3, kind: 'poll', run: async ({ group }) => { observed.push(group.chat_id); return {}; } },
    ], apply() {} };
    const host = f.create([plugin]), clock = f.scheduler();
    try {
        await host.initialize(); await clock.tick(due); await clock.tick(new Date(due.getTime() + 30000));
        expect(observed).toEqual(['global-poll', 'global-tick', 'oc_a', 'oc_b', 'global-tick', 'oc_a', 'oc_b']);
        observed.length = 0; const noPoll = f.scheduler(0); await noPoll.tick(due); await noPoll.stop();
        expect(observed).toEqual(['global-tick', 'oc_a', 'oc_b']); expect(f.deletes()).toBe(0);
    } finally { await clock.stop(); await host.stop(); }
});
