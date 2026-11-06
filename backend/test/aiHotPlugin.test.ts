import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';
import { createAiHotInstallHandler } from '@/agents/external/aiHotApi';
import { aiHotSchedulePlugin } from '@/agents/plugins/aiHotSchedule';
import { createPluginApi } from '@/platform/workspace/api';

const url = 'http://localhost/api/agents/ai-hot/install';
const request = (input: unknown) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
function fixture() {
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), { appendAuditLog: async () => {} });
    const ctx: any = { store, config: buildConfig({}), feishu: {}, tapd: {} };
    return { store, create: (enabled = true) => new AgentHost(() => ctx, 1000, undefined, [], { plugins: enabled ? [aiHotSchedulePlugin] : [] }) };
}

test('the dedicated external installer is owned by its plugin, keeps its URL and preserves installed packages on removal', async () => {
    const f = fixture(); let host = f.create(false); await host.initialize();
    try {
        const absent = request({ endpoint: 'https://agent.example.com/run' });
        expect((await host.handlePluginRequest(absent)).status).toBe(404); expect(absent.bodyUsed).toBe(false); expect(await host.listAgents()).toEqual([]);
    } finally { await host.stop(); }
    host = f.create(); await host.initialize();
    try {
        const api = new Elysia().get('/api/agents', () => ({ core: true })).post('/api/agents/install', () => ({ core: true }));
        api.use(createPluginApi(host, api.routes));
        const result = await api.handle(request({ endpoint: 'https://agent.example.com/run', apiTokenRef: 'env://FIXTURE_AI_HOT_TOKEN', priority: 120 }));
        expect(result.status).toBe(200); expect(await result.json()).toEqual({ ok: true, agent: { agentId: 'external.ai-hot', installationId: 'install-external.ai-hot', capabilities: ['knowledge.ai.hot.fetch'] } });
        expect(await (await api.handle(new Request('http://localhost/api/agents'))).json()).toEqual({ core: true });
        expect(host.canDispatch('knowledge.ai.hot.fetch')).toBe(true); expect(host.schedules.list()).toHaveLength(1);
    } finally { await host.stop(); }
    host = f.create(false); await host.initialize();
    try { expect((await host.handlePluginRequest(request({ endpoint: 'https://agent.example.com/run' }))).status).toBe(404); expect(host.canDispatch('knowledge.ai.hot.fetch')).toBe(true); expect(host.schedules.list()).toEqual([]); }
    finally { await host.stop(); }
    host = f.create(); await host.initialize();
    try { expect((await host.handlePluginRequest(request({ endpoint: 'https://agent.example.com/run', apiTokenRef: 'env://FIXTURE_AI_HOT_TOKEN', priority: 120 }))).status).toBe(200); expect(await host.listAgents()).toHaveLength(1); }
    finally { await host.stop(); }
});

test('invalid, overlarge and foreign installer requests fail before package persistence', async () => {
    const f = fixture(), host = f.create(); await host.initialize();
    try {
        for (const input of [{}, [], { endpoint: 'http://agent.example.com/run' }, { endpoint: 'https://user:secret@agent.example.com/run' }, { endpoint: 'https://agent.example.com/run', apiTokenRef: 'literal-secret' }, { endpoint: 'https://agent.example.com/run', unexpected: true }]) {
            expect((await host.handlePluginRequest(request(input))).status).toBe(400);
        }
        const huge = new Request(url, { method: 'POST', body: ' '.repeat(16 * 1024 + 1) }); expect((await host.handlePluginRequest(huge)).status).toBe(413);
        expect((await host.handlePluginRequest(new Request(url, { method: 'POST', headers: { origin: 'https://foreign.example' }, body: '{}' }))).status).toBe(403);
        expect((await host.handlePluginRequest(request({ endpoint: 'https://agent.example.com/run', workspaceId: 'foreign-workspace' }))).status).toBe(500);
        expect(await host.listAgents()).toEqual([]);
    } finally { await host.stop(); }
});

test('Host stop waits for an accepted plugin installation before releasing the API', async () => {
    const f = fixture(), host = f.create(); await host.initialize();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const persist = f.store.setIdempotencyKey.bind(f.store); f.store.setIdempotencyKey = async (key, value) => { if (key.startsWith('agent:catalog:')) { entered(); await gate; } return persist(key, value); };
    const pending = host.handlePluginRequest(request({ endpoint: 'https://agent.example.com/run' })); await ready;
    let stopped = false; const stopping = host.stop().then(() => { stopped = true; });
    try { await Promise.resolve(); expect(stopped).toBe(false); }
    finally { release(); expect((await pending).status).toBe(200); await stopping; }
    expect(host.web.routes()).toEqual([]); expect((await host.handlePluginRequest(request({ endpoint: 'https://agent.example.com/run' }))).status).toBe(503);
});


test('a host without an installer port rejects before reading a request', async () => {
    const input = request({ endpoint: 'https://agent.example.com/run' });
    expect((await createAiHotInstallHandler(undefined)(input)).status).toBe(503); expect(input.bodyUsed).toBe(false);
});
