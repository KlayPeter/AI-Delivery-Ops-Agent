import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { PluginWebRegistry, type WebContribution } from '@/platform/plugins/web';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createPluginApi } from '@/platform/workspace/api';
import { createApiDocumentation } from '@/platform/observability/apiDocumentation';
import { createManualJobsApi } from '@/platform/workspace/jobsApi';
import { buildConfig } from '@/core/config';
import { MANUAL_JOB_NAMES } from '@/services/jobExecution';
import { createDeliveryOpsHost } from '@/agents/host';
import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

const page = { path: '/example-tool', label: 'Example tool', section: 'workspace' as const, view: { kind: 'agent' as const, capability: 'example.run' } };
function plugin(apply: FeaturePlugin['apply']): FeaturePlugin {
    return { manifest: { apiVersion: '1.0', id: 'test.web', name: 'Test Web', version: '1.0.0', description: 'Web test' }, apply };
}
const context = () => ({ store: new InMemoryPersistentKeyValueStore(), config: buildConfig({}), feishu: {}, tapd: {} } as any);
const request = (url: string, body?: unknown, origin = 'http://localhost:15173') => new Request('http://localhost' + url, body === undefined ? undefined : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Web contributions validate ownership boundaries, reject duplicate entries and dispose metadata', () => {
    const registry = new PluginWebRegistry(), entry: WebContribution = { id: 'test.web', pages: [page], manualJobs: ['standup-summary'],
        api: { prefix: '/api/example', routes: [{ method: 'POST', path: '/api/example/input' }], handle: () => Response.json({ ok: true }) },
    };
    const dispose = registry.register(entry);
    expect(() => registry.register(entry)).toThrow('Duplicate');
    expect(() => registry.register({ id: 'test.other', pages: [page] })).toThrow('page');
    expect(() => registry.register({ id: 'test.reserved', pages: [{ ...page, path: '/config' }] })).toThrow('reserved');
    expect(() => registry.register({ id: 'test.jobs', manualJobs: ['standup-summary'] })).toThrow('manual job');
    expect(() => registry.register({ id: 'test.bad', api: { ...entry.api!, prefix: '/api/workspace' } })).toThrow();
    expect(() => registry.register({ id: 'test.bad', api: { ...entry.api!, prefix: '/api/example/nested', routes: [{ method: 'GET', path: '/api/example/nested' }] } })).toThrow('Overlapping');
    expect(() => registry.register({ id: 'test.escape', api: { ...entry.api!, routes: [{ method: 'GET', path: '/api/foreign' }] } })).toThrow('route');
    registry.pages()[0]!.label = 'Changed'; expect(registry.pages()[0]!.label).toBe('Example tool');
    dispose(); dispose(); expect(registry.pages()).toEqual([]); expect(registry.manualJobs()).toEqual([]); expect(registry.routes()).toEqual([]);
});

test('third-party Web API keeps POST bodies, core routes and OpenAPI paths without frontend code changes', async () => {
    const feature = plugin(ctx => {
        const app = new Elysia().post('/api/example/input', ({ body }) => ({ received: body }));
        ctx.delivery.web.register({ id: 'test.web', pages: [page], api: { prefix: '/api/example', routes: [{ method: 'POST', path: '/api/example/input' }], handle: request => app.handle(request) } });
    });
    const host = new AgentHost(context, 1000, undefined, [], { plugins: [feature] }); await host.initialize();
    const app = new Elysia().use(createApiDocumentation()).get('/api/config', () => ({ core: true })).use(createPluginApi(host));
    try {
        expect(() => createPluginApi(host, [{ path: '/api/example/legacy/:id' }])).toThrow('existing application namespace');
        const result = await app.handle(request('/api/example/input', { text: 'body preserved' }));
        expect(result.status).toBe(200); expect(await result.json()).toEqual({ received: { text: 'body preserved' } });
        expect(await (await app.handle(request('/api/config'))).json()).toEqual({ core: true });
        expect((await app.handle(request('/api/example-other/input', {}))).status).toBe(404);
        expect((await app.handle(request('/api/example/input', {}, 'https://foreign.example'))).status).toBe(403);
        const openapi = await (await app.handle(request('/api/swagger/json'))).json() as any;
        expect(openapi.paths['/api/example/input'].post).toBeDefined();
    } finally { await host.stop(); }
    expect(host.web.pages()).toEqual([]);
    expect((await app.handle(request('/api/example/input', {}))).status).toBe(503);
});

test('failed plugin initialization removes its Web pages, routes and manual jobs', async () => {
    const host = new AgentHost(context, 1000, undefined, [], { plugins: [plugin(ctx => {
        ctx.delivery.web.register({ id: 'test.web', pages: [page], manualJobs: ['standup-summary'] });
        throw new Error('setup failed');
    })] });
    await expect(host.initialize()).rejects.toThrow('setup failed');
    expect(host.web.pages()).toEqual([]); expect(host.web.manualJobs()).toEqual([]); expect(host.web.routes()).toEqual([]);
    await host.stop();
});

test('team defaults declare exactly the existing manual jobs and an empty profile declares none', async () => {
    const defaults = createDeliveryOpsHost(context), empty = new AgentHost(context);
    const withoutStandup = createDeliveryOpsHost(context, 1000, undefined, [], { plugins: deliveryTeamPlugins.filter(plugin => !['builtin.standup', 'builtin.orchestrator'].includes(plugin.manifest.id)) });
    try {
        await defaults.initialize(); await empty.initialize(); await withoutStandup.initialize();
        expect(new Set(defaults.web.manualJobs())).toEqual(MANUAL_JOB_NAMES);
        expect(defaults.web.pages()).toMatchObject([{ path: '/standups', view: { id: 'standups' } }]);
        expect(empty.web.pages()).toEqual([]);
        let called = false;
        await expect(empty.executePluginJob('standup-summary', async () => { called = true; })).rejects.toThrow('未启用');
        expect(called).toBe(false);
        expect((await empty.handlePluginRequest(request('/api/standups'))).status).toBe(404);
        expect(new Set(withoutStandup.web.manualJobs())).toEqual(new Set(['overdue-scan', 'daily-summary', 'dashboard']));
        expect(withoutStandup.canDispatch('summary.daily.generate')).toBe(true);
        expect((await withoutStandup.handlePluginRequest(request('/api/standups'))).status).toBe(404);
    } finally { await defaults.stop(); await empty.stop(); await withoutStandup.stop(); }
});

test('manual job HTTP calls require an installed owner and preserve execution and preview rules', async () => {
    const ctx = context(); ctx.config.groups = [{ chat_id: 'oc_demo', members: [], schedule: { workdays_only: false } }];
    const audits: any[] = []; ctx.store.appendAuditLog = async (...args: any[]) => { audits.push(args); };
    const empty = new AgentHost(() => ctx), enabled = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [plugin(services => { services.delivery.web.register({ id: 'test.web', manualJobs: ['standup-summary'] }); })] });
    let calls = 0, send = false;
    const factory = (sendToGroup: boolean) => { send = sendToGroup; calls++; return { standupSummary: async () => ({ generated: true }) } as any; };
    const absentApi = createManualJobsApi(empty, () => ctx, factory), enabledApi = createManualJobsApi(enabled, () => ctx, factory);
    try {
        expect((await absentApi.handle(request('/api/jobs/standup-summary', { groupId: 'oc_demo' }))).status).toBe(404); expect(calls).toBe(0);
        const response = await enabledApi.handle(request('/api/jobs/standup-summary', { groupId: 'oc_demo', day: '2026-11-05', sendToGroup: true }));
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, sendToGroup: true, result: { generated: true } }); expect(send).toBe(true);
        expect(audits[0][0]).toBe('job_completed');
        expect((await enabledApi.handle(request('/api/jobs/standup-summary', { groupId: 'oc_demo', day: '2026-02-30' }))).status).toBe(400);
        expect((await enabledApi.handle(request('/api/jobs/standup-summary', { groupId: 'oc_demo', dryRun: true }))).status).toBe(400);
        expect((await enabledApi.handle(request('/api/jobs/standup-summary', { groupId: 'oc_demo' }, 'https://foreign.example'))).status).toBe(403);
    } finally { await empty.stop(); await enabled.stop(); }
});

test('Host waits for contributed HTTP and manual jobs before releasing plugin resources', async () => {
    let release!: () => void, entered!: () => void, jobEntered!: () => void, disposed = false;
    const finish = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { entered = resolve; });
    const jobReading = new Promise<void>(resolve => { jobEntered = resolve; });
    const host = new AgentHost(context, 1000, undefined, [], { plugins: [plugin(ctx => {
        ctx.effect(() => () => { disposed = true; });
        ctx.delivery.web.register({ id: 'test.web', manualJobs: ['standup-summary'], api: { prefix: '/api/example', routes: [{ method: 'GET', path: '/api/example' }], handle: async () => { entered(); await finish; expect(disposed).toBe(false); return Response.json({ done: true }); } } });
    })] });
    const pending = host.handlePluginRequest(request('/api/example')); await reading;
    const job = host.executePluginJob('standup-summary', async () => { jobEntered(); await finish; expect(disposed).toBe(false); return true; }); await jobReading;
    const stopping = host.stop(); await Promise.resolve(); expect(disposed).toBe(false); release();
    expect((await pending).status).toBe(200); expect(await job).toBe(true); await stopping; expect(disposed).toBe(true);
});
