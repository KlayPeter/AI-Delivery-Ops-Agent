import { expect, test } from 'bun:test';
import { StandupService } from '@/services/standupService';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { standupPlugin } from '@/agents/plugins/standup';
import { createPluginApi } from '@/platform/workspace/api';
import { buildConfig } from '@/core/config';

test('statistics excludes inactive members and keeps unique-group legacy submissions and configured group scope', async () => {
    const config = { groups: [
        { chat_id: 'oc_a', members: [{ open_id: 'active', name: 'Active' }, { open_id: 'inactive', name: 'Inactive', is_active: false }, { open_id: 'shared', name: 'Shared' }, { open_id: '', name: 'Unbound' }] },
        { chat_id: 'oc_b', members: [{ open_id: 'shared', name: 'Shared' }] },
    ] };
    const rows = [{ open_id: 'active' }, { open_id: 'inactive', source_group_id: 'oc_a' }, { open_id: 'shared' }, { open_id: 'shared', source_group_id: 'oc_removed' }];
    const store = { listStandups: async (_date: string, groupId: string | null) => rows.filter(row => !groupId || row.source_group_id === groupId) };
    const result = await StandupService.statistics(config, store, '2026-11-05', 'oc_a');
    expect(result.stats).toEqual({ total: 2, submitted: 1, missing: 1 });
    expect(result.members).toHaveLength(2); expect(result.members!.find(member => member.open_id === 'shared')!.submitted).toBe(false);
    expect((await StandupService.statistics(config, store, '2026-11-05')).stats).toEqual(result.stats);
});

test('latest summary uses exact group and business date and continues past unrelated or malformed audit rows', async () => {
    const date = '2026-11-05', groupId = 'oc_a';
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: 200 - index, payload: index % 2 ? '{broken' : JSON.stringify({ date, group_id: 'oc_a_other', summary: 'wrong group' }) }));
    rows.push({ id: 99, payload: JSON.stringify({ date: '2026-11-04', group_id: groupId, summary: 'wrong day' }) }, { id: 98, payload: JSON.stringify({ date, group_id: groupId, summary: 'correct business-day summary' }) });
    let queries = 0;
    const store = { prisma: { auditLog: { findMany: async ({ where }: any) => { queries++; return rows.filter(row => where.id === undefined || row.id < where.id.lt).slice(0, 100); } } } };
    expect(await StandupService.latestSummary(store, date, groupId)).toBe('correct business-day summary'); expect(queries).toBe(2);
});

test('plugin owns standup API paths and rejects invalid queries without exposing internal failures', async () => {
    const config = buildConfig({}); config.groups = [{ chat_id: 'oc_a', members: [], schedule: {} } as any];
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), { listStandups: async () => [] as any[], listTasks: async () => [] as any[], listTaskUpdates: async () => [] as any[], prisma: { auditLog: { findMany: async () => [] as any[] } } });
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [standupPlugin] });
    await host.initialize(); const app = createPluginApi(host);
    const request = (query: string) => app.handle(new Request('http://localhost/api/standups' + query));
    try {
        const normal = await request('?date=2026-11-05&groupId=oc_a'); expect(normal.status).toBe(200); expect(await normal.json()).toMatchObject({ type: 'normal', stats: { total: 0, submitted: 0, missing: 0 } });
        expect(await (await request('?date=2026-11-05&type=task')).json()).toMatchObject({ type: 'task', stats: { total: 0, unreported: 0 } });
        expect((await request('?date=2026-02-30')).status).toBe(400);
        expect((await request('?type=unknown')).status).toBe(400);
        expect((await request('?groupId=oc_unknown')).status).toBe(404);
        expect((await request('/summary?date=2026-11-05')).status).toBe(400);
        expect(await (await request('/summary?date=2026-11-05&groupId=oc_a')).json()).toEqual({ summary: null });
        store.listStandups = async () => { throw new Error('private database details'); };
        const failed = await request('?date=2026-11-05'); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain('private database details');
    } finally { await host.stop(); }
    expect(host.web.pages()).toEqual([]); expect(host.web.manualJobs()).toEqual([]);
});
