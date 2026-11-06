import { expect, test } from 'bun:test';
import { buildConfig } from '@/core/config';
import { InProcessScheduler } from '@/core/scheduler';
import { directoryPlugin } from '@/agents/plugins/directory';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { ScheduleRegistry } from '@/platform/scheduling/registry';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createPluginApi } from '@/platform/workspace/api';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

function fixture() {
    let raw: any = { maintenance: { enabled: false }, groups: ['oc_a', 'oc_b'].map(chat_id => ({ chat_id, members: [{ open_id: 'ou_old', name: 'Previous', is_active: true }], schedule: {} })) };
    let company = [{ open_id: 'ou_old', name: 'Previous', is_active: true }];
    const calls = { groups: 0, members: 0, company: 0, reloads: 0, writes: 0 };
    const logs: string[] = [];
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), {
        getDynamicConfig: async () => raw,
        saveDynamicConfig: async (next: any) => { calls.writes++; raw = next; },
        listCompanyMembers: async () => company,
        reconcileCompanyMembers: async (next: any) => { company = next; return { deactivated: 1 }; },
        appendAuditLog: async (event: string) => { logs.push(event); },
    });
    const ctx: any = { config: buildConfig(raw), store, schedules: new ScheduleRegistry(), feishu: {
        listGroups: async () => { calls.groups++; return [{ chat_id: 'oc_a', name: 'Example group' }]; },
        listGroupMembers: async () => { calls.members++; return [{ open_id: 'ou_current', name: 'Current' }]; },
        fetchAllCompanyMembers: async () => { calls.company++; return [{ open_id: 'ou_current', name: 'Current', is_active: true }]; },
    }, tapd: {} };
    const reloadConfiguration = async () => {
        calls.reloads++; ctx.config = buildConfig(raw);
        ctx.config.feishu.app_secret = 'test-feishu-secret'; ctx.config.tapd.api_token = 'test-tapd-secret';
        ctx.config.ai.api_key = 'test-model-secret'; ctx.config.email.pass = 'test-mail-secret';
    };
    const host = (plugins: readonly FeaturePlugin[], canReload = true) => new AgentHost(() => ctx, 1000, undefined, [], { plugins, schedules: ctx.schedules, ...(canReload ? { reloadConfiguration } : {}) });
    const scheduler = () => new InProcessScheduler(() => ({ ctx }) as any, 30, 6 * 60 * 60);
    return { ctx, calls, logs, host, scheduler };
}
const request = (path: string, method = 'GET', origin = 'http://localhost:15173') => new Request('http://localhost' + path, { method, headers: { origin } });

test('directory owns existing APIs, reloads changed membership and keeps configuration secrets masked', async () => {
    const { ctx, calls, host } = fixture();
    const runtime = host([directoryPlugin]); await runtime.initialize();
    const app = createPluginApi(runtime);
    try {
        expect(await (await app.handle(request('/api/feishu/groups'))).json()).toEqual({ groups: [{ chat_id: 'oc_a', name: 'Example group' }] });
        expect((await app.handle(request('/api/feishu/groups/oc_a/members'))).status).toBe(200);
        const company = await app.handle(request('/api/feishu/company-members/sync', 'POST'));
        expect(company.status).toBe(200); expect(await company.json()).toMatchObject({ ok: true, result: { group_members_deactivated: 2 } });
        expect(ctx.config.groups.every((group: any) => group.members[0].is_active === false)).toBe(true);
        expect((await (await app.handle(request('/api/feishu/company-members'))).json() as any).members[0].open_id).toBe('ou_current');
        const sync = await app.handle(request('/api/feishu/groups/oc_a/members/sync', 'POST'));
        expect(sync.status).toBe(200);
        const body: any = await sync.json();
        expect(body.result.changed).toBe(true); expect(body.config.groups[0].members[0].open_id).toBe('ou_current');
        expect([body.config.feishu.app_secret, body.config.tapd.api_token, body.config.ai.api_key, body.config.email.pass]).toEqual(Array(4).fill('******'));
        expect(ctx.config.feishu.app_secret).toBe('test-feishu-secret'); expect(calls.reloads).toBe(2);
        const before = { ...calls };
        expect((await app.handle(request('/api/feishu/company-members/sync', 'POST', 'https://foreign.example'))).status).toBe(403);
        expect((await app.handle(request('/api/feishu/company-members/sync', 'DELETE'))).status).toBe(404);
        expect(calls).toEqual(before);
    } finally { await runtime.stop(); }
    expect(runtime.web.routes()).toEqual([]); expect(ctx.schedules.list()).toEqual([]);
});

test('an absent directory has no APIs or automatic remote reads, and unsupported reload blocks manual writes', async () => {
    const f = fixture(), empty = f.host([]); await empty.initialize();
    try {
        expect((await empty.handlePluginRequest(request('/api/feishu/groups'))).status).toBe(404);
        expect((await empty.handlePluginRequest(request('/api/feishu/company-members/sync', 'POST'))).status).toBe(404);
        await f.scheduler().tick(new Date('2026-11-06T00:00:00Z'));
        expect(f.calls).toEqual({ groups: 0, members: 0, company: 0, reloads: 0, writes: 0 });
    } finally { await empty.stop(); }
    const sdk = fixture(), enabled = sdk.host([directoryPlugin], false); await enabled.initialize();
    try {
        expect((await enabled.handlePluginRequest(request('/api/feishu/groups'))).status).toBe(200);
        expect((await enabled.handlePluginRequest(request('/api/feishu/groups/oc_a/members/sync', 'POST'))).status).toBe(503);
        expect(sdk.calls.members).toBe(0); expect(sdk.calls.writes).toBe(0);
    } finally { await enabled.stop(); }
});

test('directory sync runs once before group jobs, retains its interval and preserves members on failed reads', async () => {
    const { ctx, calls, logs, host, scheduler } = fixture();
    const observed: string[] = [];
    const observer: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'test.directory-observer', name: 'Observer', version: '1.0.0', description: 'Observes current group members' },
        schedules: [{ id: 'test.directory-observer', priority: 1, kind: 'poll', run: async ({ group }) => { observed.push(group.members[0]!.open_id); return {}; } }], apply() {} };
    const runtime = host([directoryPlugin, observer]); await runtime.initialize();
    const clock = scheduler();
    try {
        await clock.tick(new Date('2026-11-06T00:00:00Z'));
        expect(calls.members).toBe(2); expect(observed).toEqual(['ou_current', 'ou_current']);
        await clock.tick(new Date('2026-11-06T00:00:30Z')); expect(calls.members).toBe(2);
        ctx.feishu.listGroupMembers = async () => { calls.members++; throw new Error('Unavailable'); };
        await clock.tick(new Date('2026-11-06T06:00:00Z'));
        expect(calls.members).toBe(4); expect(calls.writes).toBe(1);
        expect(observed.every(id => id === 'ou_current')).toBe(true); expect(logs.filter(event => event === 'group_members_sync')).toHaveLength(2);
        await clock.tick(new Date('2026-11-06T06:00:30Z')); expect(calls.members).toBe(4);
    } finally { await clock.stop(); await runtime.stop(); }
});

test('Host stop waits for accepted directory synchronization before releasing its API and schedule', async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.ctx.feishu.listGroupMembers = async () => { entered(); await gate; return [{ open_id: 'ou_old', name: 'Previous' }]; };
    const runtime = f.host([directoryPlugin]); await runtime.initialize();
    const clock = f.scheduler(); const pending = clock.tick(new Date('2026-11-06T00:00:00Z')); await started;
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    try {
        await Promise.resolve(); expect(stopped).toBe(false); expect(runtime.web.routes()).toHaveLength(5);
    } finally { release(); await pending; await stopping; await clock.stop(); }
    expect(stopped).toBe(true); expect(runtime.web.routes()).toEqual([]); expect(f.ctx.schedules.list()).toEqual([]);
});
