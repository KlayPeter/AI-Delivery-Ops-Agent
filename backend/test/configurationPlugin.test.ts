import { afterEach, expect, test } from 'bun:test';
import { buildConfig } from '@/core/config';
import { configurationPlugin } from '@/agents/plugins/configuration';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createPluginApi } from '@/platform/workspace/api';

const hosts: AgentHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.stop(); });
function fixture() {
    let raw: any = { runtime: {}, schedule: {}, groups: [{ chat_id: 'oc_demo', name: 'Demo', members: [{ open_id: 'ou_demo', name: 'Demo member' }], schedule: {} }] };
    let writes = 0, reloads = 0, failReload = false;
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), { saveDynamicConfig: async (value: unknown) => { writes++; raw = structuredClone(value); } });
    const ctx: any = { config: buildConfig(raw), store, feishu: {}, tapd: {} };
    const secrets = () => { ctx.config.feishu.app_secret = 'PRIVATE_FEISHU'; ctx.config.tapd.api_token = 'PRIVATE_TAPD'; ctx.config.ai.api_key = 'PRIVATE_MODEL'; ctx.config.email.pass = 'PRIVATE_MAIL'; };
    secrets();
    const create = (installed = true, canReload = true) => {
        const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: installed ? [configurationPlugin] : [], ...(canReload ? { reloadConfiguration: async () => { reloads++; if (failReload) throw new Error('PRIVATE_RELOAD'); ctx.config = buildConfig(raw); secrets(); } } : {}) });
        hosts.push(host); return host;
    };
    return { ctx, create, current: () => structuredClone(raw), counts: () => ({ writes, reloads }), failReload: () => { failReload = true; } };
}
const request = (method = 'GET', value?: unknown, origin = 'http://localhost:15173') => new Request('http://localhost/api/config', { method, headers: { origin, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });

test('configuration owns its existing page and API, saves reviewed fields and masks credentials after reload', async () => {
    const f = fixture(), host = f.create(); await host.initialize(); const app = createPluginApi(host);
    expect(host.web.pages()).toEqual([{ path: '/config', label: '定时与团队配置', section: 'team', view: { kind: 'builtin', id: 'team-configuration' } }]);
    const initial = await (await app.handle(request())).json() as any;
    expect([initial.feishu.app_secret, initial.tapd.api_token, initial.ai.api_key, initial.email.pass]).toEqual(Array(4).fill('******'));
    expect((await app.handle(request('HEAD'))).status).toBe(200); expect(f.counts()).toEqual({ writes: 0, reloads: 0 });
    const payload = f.current(); payload.groups[0].schedule.module_standup_enabled = true;
    const response = await app.handle(request('POST', payload)); expect(response.status).toBe(200);
    const saved = await response.json() as any; expect(saved.ok).toBe(true); expect(saved.config.groups[0].members[0].open_id).toBe('ou_demo'); expect(saved.config.groups[0].schedule.module_standup_enabled).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_'); expect(f.counts()).toEqual({ writes: 1, reloads: 1 });
    expect((await app.handle(request('POST', payload, 'https://foreign.example'))).status).toBe(403);
    expect((await app.handle(request('DELETE'))).status).toBe(404); expect(f.counts()).toEqual({ writes: 1, reloads: 1 });
});

test('removal closes configuration while SDK hosts without reload reject before writing or consuming a body', async () => {
    const f = fixture(), empty = f.create(false); await empty.initialize();
    expect(empty.web.pages()).toEqual([]); expect((await empty.handlePluginRequest(request())).status).toBe(404); expect((await empty.handlePluginRequest(request('POST', f.current()))).status).toBe(404);
    const sdk = f.create(true, false); await sdk.initialize(); const input = request('POST', f.current());
    expect((await sdk.handlePluginRequest(request())).status).toBe(200); expect((await sdk.handlePluginRequest(input)).status).toBe(503); expect(input.bodyUsed).toBe(false); expect(f.counts()).toEqual({ writes: 0, reloads: 0 });
    await sdk.stop(); expect(sdk.web.pages()).toEqual([]); expect(sdk.web.routes()).toEqual([]);
});

test('malformed and oversized requests cannot replace existing groups', async () => {
    const f = fixture(), host = f.create(); await host.initialize(); const before = f.current();
    for (const invalid of [{}, [], { ...before, groups: 'invalid' }, { ...before, groups: [{ name: 'Missing ID' }] }, { ...before, groups: [{ chat_id: 'oc_demo', members: [{ name: 'Missing member ID' }] }] }]) {
        expect((await host.handlePluginRequest(request('POST', invalid))).status).toBe(400);
    }
    expect((await host.handlePluginRequest(new Request('http://localhost/api/config', { method: 'POST', body: '{invalid' }))).status).toBe(400);
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
    expect((await host.handlePluginRequest(new Request('http://localhost/api/config', { method: 'POST', body }))).status).toBe(413); expect(cancelled).toBe(true);
    expect(f.current()).toEqual(before); expect(f.counts()).toEqual({ writes: 0, reloads: 0 });
});

test('storage failure and reload failure report whether the new configuration was actually saved', async () => {
    const f = fixture(), host = f.create(); await host.initialize(); const before = f.current(), save = f.ctx.store.saveDynamicConfig;
    f.ctx.store.saveDynamicConfig = async () => { throw new Error('PRIVATE_STORAGE'); };
    const failed = await host.handlePluginRequest(request('POST', before)); expect(failed.status).toBe(500); expect(await failed.json()).toMatchObject({ saved: false }); expect(f.current()).toEqual(before);
    f.ctx.store.saveDynamicConfig = save; f.failReload(); const next = { ...before, groups: [] };
    const partial = await host.handlePluginRequest(request('POST', next)); expect(partial.status).toBe(500);
    const text = await partial.text(); expect(JSON.parse(text)).toMatchObject({ saved: true }); expect(text).toContain('配置已保存'); expect(text).not.toContain('PRIVATE_'); expect(f.current()).toEqual(next);
});

test('accepted configuration writes drain before plugin teardown and saved data survives a new host', async () => {
    const f = fixture(), host = f.create(); await host.initialize();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const save = f.ctx.store.saveDynamicConfig; f.ctx.store.saveDynamicConfig = async (value: unknown) => { entered(); await gate; await save(value); };
    const input = f.current(); input.groups[0].name = 'Updated'; const pending = host.handlePluginRequest(request('POST', input)); await ready;
    let stopped = false; const stopping = host.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false); expect(host.web.routes()).toHaveLength(2);
    release(); expect((await pending).status).toBe(200); await stopping; expect(host.web.routes()).toEqual([]);
    const restored = f.create(); await restored.initialize(); expect((await (await restored.handlePluginRequest(request())).json() as any).groups[0].name).toBe('Updated');
});

test('aborted request streams stop reading without any configuration write', async () => {
    const f = fixture(), host = f.create(); await host.initialize(); let entered!: () => void, cancelled = false;
    const ready = new Promise<void>(resolve => { entered = resolve; }), signal = new AbortController();
    const body = new ReadableStream({ pull() { entered(); }, cancel() { cancelled = true; } });
    const pending = host.handlePluginRequest(new Request('http://localhost/api/config', { method: 'POST', body, signal: signal.signal }));
    await ready; signal.abort(); expect((await pending).status).toBe(400); expect(cancelled).toBe(true); expect(f.counts()).toEqual({ writes: 0, reloads: 0 });
});
