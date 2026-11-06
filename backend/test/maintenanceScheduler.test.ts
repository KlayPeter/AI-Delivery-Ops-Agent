import { describe, expect, test } from 'bun:test';
import { InProcessScheduler } from '@/core/scheduler';
import { maintenancePlugin } from '@/agents/plugins/maintenance';
import { ScheduleRegistry } from '@/platform/scheduling/registry';

function fixture(failCleanup: boolean = false) {
    const claims = new Set<string>();
    const logs: Array<{ event: string; payload: any }> = [];
    const values = new Map<string, any>();
    let cleanupCalls = 0;
    const store: any = {
        getDynamicConfig: async (): Promise<{ runtime: Record<string, never>; schedule: Record<string, never>; groups: any[] }> => ({
            runtime: {},
            schedule: {},
            groups: [],
        }),
        claimIdempotencyKey: async (key: string, value: any) => {
            if (claims.has(key)) return false;
            claims.add(key);
            values.set(key, value);
            return true;
        },
        setIdempotencyKey: async (key: string, value: any) => values.set(key, value),
        appendAuditLog: async (event: string, payload: any) => logs.push({ event, payload }),
        deleteAuditLogsBefore: async () => {
            cleanupCalls++;
            if (failCleanup) throw new Error('cleanup unavailable');
            return 0;
        },
        countAuditLogsBefore: async () => 0,
        listRawIdempotencyRecords: async (): Promise<Array<{ key: string; value: string }>> => [],
        deleteIdempotencyKeys: async () => 0,
    };
    const schedules = new ScheduleRegistry();
    for (const schedule of maintenancePlugin.schedules!) schedules.register(schedule);
    const handler: any = {
        ctx: {
            store,
            schedules,
            config: {},
            feishu: {},
            tapd: {},
        },
    };
    const scheduler = new InProcessScheduler(() => handler, 30, 0, undefined, 0);
    return { scheduler, logs, values, cleanupCalls: () => cleanupCalls };
}

describe('maintenance scheduling', () => {
    test('runs once at the configured Shanghai time', async () => {
        const { scheduler, logs, cleanupCalls } = fixture();
        const due = new Date('2026-07-28T19:30:00.000Z');
        await scheduler.tick(due);
        await scheduler.tick(due);

        expect(cleanupCalls()).toBe(1);
        expect(logs.filter(log => log.event === 'maintenance_cleanup_completed')).toHaveLength(1);
    });

    test('does not block normal scheduler completion when cleanup fails', async () => {
        const { scheduler, logs, values } = fixture(true);
        await expect(scheduler.tick(new Date('2026-07-28T19:30:00.000Z'))).resolves.toEqual({});

        expect(logs.some(log => log.event === 'maintenance_cleanup_failed')).toBeTrue();
        expect(values.get('maintenance:cleanup:2026-07-29')).toMatchObject({
            status: 'failed',
            error: 'cleanup unavailable',
        });
    });
});
