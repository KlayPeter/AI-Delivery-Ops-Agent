import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Elysia } from 'elysia';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { dashboardPlugin } from '@/agents/plugins/dashboard';
import { createPluginApi } from '@/platform/workspace/api';
import { createApiDocumentation } from '@/platform/observability/apiDocumentation';
import { buildConfig } from '@/core/config';

const request = (url: string, method = 'GET', body?: unknown) => new Request('http://localhost' + url, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function fixture() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'project-visibility-api-'));
    const task: any = { id: 'task-demo', creator_open_id: 'ou_demo', assignee_open_ids: ['ou_demo'], trace: {} };
    const audits: any[] = []; let reads = 0, writes = 0;
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), {
        listTasks: async (): Promise<unknown[]> => { reads++; return []; }, listCompanyMembers: async (): Promise<unknown[]> => [],
        findTask: async (id: string) => id === task.id ? task : null,
        saveTask: async () => { writes++; }, appendAuditLog: async (...args: unknown[]) => { audits.push(args); },
    });
    const ctx: any = { config: buildConfig({}), store, feishu: {}, tapd: {} }; ctx.config.data_path = dir;
    const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [dashboardPlugin] });
    const empty = new AgentHost(() => ctx);
    await host.initialize(); await empty.initialize();
    return { dir, ctx, task, audits, host, empty, counts: () => ({ reads, writes }),
        app: new Elysia().use(createApiDocumentation()).use(createPluginApi(host)), absent: createPluginApi(empty),
        cleanup: async () => { await host.stop(); await empty.stop(); await rm(dir, { recursive: true, force: true }); },
    };
}

test('dashboard plugin owns both pages, file routes and Gantt reads/writes; removal preserves files and blocks execution', async () => {
    const f = await fixture();
    try {
        expect(f.host.web.pages().map(page => page.path)).toEqual(['/dashboard', '/human-gantt']);
        expect(f.empty.web.pages()).toEqual([]);
        for (const [url, method, body] of [
            ['/api/dashboards', 'GET'], ['/api/dashboards/old.html', 'GET'], ['/api/human-gantt', 'GET'],
            ['/api/human-gantt/tasks/task-demo/plan', 'POST', {}], ['/api/human-gantt/tasks/task-demo/plan', 'DELETE', {}],
        ] as const) expect((await f.absent.handle(request(url, method, body))).status).toBe(404);
        expect(f.counts()).toEqual({ reads: 0, writes: 0 });
        expect(await (await f.app.handle(request('/api/dashboards'))).json()).toEqual({ dashboards: [] });
        const response = await f.app.handle(request('/api/human-gantt?from=2026-07-01&to=2026-07-31&sync=false'));
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ range: { from: '2026-07-01', to: '2026-07-31' }, rows: [], sync: null });
        const openapi: any = await (await f.app.handle(request('/api/swagger/json'))).json();
        expect(openapi.paths['/api/dashboards/{filename}'].get).toBeDefined();
        expect(openapi.paths['/api/human-gantt/tasks/{taskId}/plan'].post).toBeDefined();
        expect(openapi.paths['/api/human-gantt/tasks/{taskId}/plan'].delete).toBeDefined();
    } finally { await f.cleanup(); }
});

test('dashboard files stay inside the artifact directory and symlinks or malformed names never expose another file', async () => {
    const f = await fixture();
    try {
        const artifacts = path.join(f.dir, 'dashboards'); await mkdir(artifacts);
        await writeFile(path.join(f.dir, 'private.html'), 'PRIVATE');
        await writeFile(path.join(artifacts, '中文快照.html'), '<h1>历史快照</h1>');
        await writeFile(path.join(artifacts, 'stats.json'), '{}');
        await mkdir(path.join(artifacts, 'directory.html'));
        await symlink(path.join(f.dir, 'private.html'), path.join(artifacts, 'linked.html'));
        expect(await (await f.app.handle(request('/api/dashboards'))).json()).toEqual({ dashboards: ['中文快照.html'] });
        const response = await f.app.handle(request('/api/dashboards/' + encodeURIComponent('中文快照.html')));
        expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/html'); expect(await response.text()).toContain('历史快照');
        for (const filename of ['..%2fprivate.html', '..%5cprivate.html', '%252e%252e%252fprivate.html', 'linked.html', 'directory.html', 'stats.json', 'bad%00.html']) {
            const rejected = await f.app.handle(request('/api/dashboards/' + filename));
            expect(rejected.status).toBe(404); expect(await rejected.text()).not.toContain('PRIVATE');
        }
        await f.host.stop();
        expect((await f.app.handle(request('/api/dashboards'))).status).toBe(503);
        expect(await readFile(path.join(artifacts, '中文快照.html'), 'utf8')).toContain('历史快照');
    } finally { await f.cleanup(); }
});

test('Gantt plan API keeps domain membership, half-day validation and audits while rejecting malformed inputs before changes', async () => {
    const f = await fixture(), url = '/api/human-gantt/tasks/task-demo/plan';
    const plan = { employee_open_id: 'ou_demo', role: 'development', start: '2026-11-05-AM', end: '2026-11-06-PM' };
    try {
        const saved = await f.app.handle(request(url, 'POST', plan));
        expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ ok: true, plan });
        expect(f.audits[0][0]).toBe('task_gantt_plan_updated');
        const removed = await f.app.handle(request(url, 'DELETE', { employee_open_id: plan.employee_open_id, role: plan.role }));
        expect(removed.status).toBe(200); expect(f.task.trace.gantt_plans).toEqual([]); expect(f.audits[1][0]).toBe('task_gantt_plan_deleted');
        for (const body of [null, [], {}, { ...plan, employee_open_id: 'ou_outsider' }, { ...plan, role: 'admin' }, { ...plan, end: '2026-11-04-PM' }, { ...plan, start: 'invalid' }, { ...plan, extra: true }]) expect((await f.app.handle(request(url, 'POST', body))).status).toBe(400);
        expect((await f.app.handle(request('/api/human-gantt/tasks/missing/plan', 'POST', plan))).status).toBe(400);
        expect(f.counts().writes).toBe(2);
        for (const query of ['from=2026-02-30', 'from=2026-11-06&to=2026-11-05', 'sync=maybe', 'includeImplemented=1']) expect((await f.app.handle(request('/api/human-gantt?' + query))).status).toBe(400);
        expect(f.counts().reads).toBe(0);
        f.ctx.store.listTasks = async () => { throw new Error('PRIVATE database path'); };
        const failed = await f.app.handle(request('/api/human-gantt?sync=false'));
        expect(failed.status).toBe(500); expect(await failed.text()).not.toContain('PRIVATE');
    } finally { await f.cleanup(); }
});
