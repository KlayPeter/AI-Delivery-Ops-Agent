import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Elysia } from 'elysia';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { weeklyReportPlugin } from '@/agents/plugins/weeklyReport';
import { meetingSummaryPlugin } from '@/agents/plugins/meetingSummary';
import { createPluginApi } from '@/platform/workspace/api';
import { createApiDocumentation } from '@/platform/observability/apiDocumentation';
import { buildConfig } from '@/core/config';

const request = (url: string, method = 'GET', body?: unknown) => new Request('http://localhost' + url, { method,
    headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function fixture() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'report-web-'));
    await mkdir(path.join(dir, 'weekly-reports')); await mkdir(path.join(dir, 'summaries/archive'), { recursive: true });
    await writeFile(path.join(dir, 'weekly-reports/weekly.html'), '<h1>Historical weekly report</h1>');
    await writeFile(path.join(dir, 'summaries/archive/summary.md'), '# Summary');
    await writeFile(path.join(dir, 'summaries/archive/timeline.md'), '# Timeline');
    await writeFile(path.join(dir, 'private.md'), 'PRIVATE');
    const weekly: any[] = [
        { id: 'weekly-one', status: 'succeeded', group_id: 'oc_one', facts: { group: { name: 'Team one' }, private: 'PRIVATE' }, period_start: '2026-11-02', period_end: '2026-11-06', version: 1, html_path: path.join(dir, 'weekly-reports/weekly.html') },
        { id: 'weekly-failed', status: 'failed', group_id: 'oc_one', html_path: path.join(dir, 'weekly-reports/weekly.html') },
    ];
    const records: any[] = Array.from({ length: 20 }, (_, i) => ({ id: `meeting-${i}`, group_id: i % 2 ? 'oc_two' : 'oc_one', theme: `Meeting ${i}`, date: '2026-11-05', created_at: '2026-11-05T01:00:00Z',
        summary_file: 'archive/summary.md', timeline_file: 'archive/timeline.md', email_sent: false, source_message_id: 'original-message-id', internal_metadata: 'PRIVATE',
    }));
    const queries: any[] = [], emails: any[] = [], updates: any[] = [], audits: any[] = [];
    const subset = (where: any) => records.filter(record => !where?.group_id || record.group_id === where.group_id);
    const store: any = Object.assign(new InMemoryPersistentKeyValueStore(), {
        listWeeklyReports: async (groupId?: string) => { queries.push({ weekly: groupId }); return weekly.filter(record => !groupId || record.group_id === groupId); },
        getWeeklyReport: async (id: string) => { queries.push({ weeklyId: id }); return weekly.find(record => record.id === id); },
        appendAuditLog: async (...args: any[]) => { audits.push(args); },
        prisma: { meetingSummaryRecord: {
            findUnique: async ({ where }: any) => { queries.push({ id: where.id }); return records.find(record => record.id === where.id); },
            findMany: async (query: any) => { queries.push(query); return subset(query.where).slice(query.skip, query.skip + query.take); },
            count: async ({ where }: any) => subset(where).length,
            update: async ({ where, data }: any) => { updates.push(where.id); return Object.assign(records.find(record => record.id === where.id), data); },
        } },
    });
    const ctx: any = { store, config: buildConfig({}), feishu: {}, tapd: {}, email: { dryRun: false,
        sendEmail: async (...args: unknown[]) => { emails.push(args); return { ok: true }; },
    } };
    ctx.config.data_path = dir; ctx.config.groups = [{ chat_id: 'oc_one', name: 'Team one', members: [] }];
    Object.assign(ctx.config.email, { enabled: true, host: 'smtp.example.test', user: 'sender@example.test', to_addresses: ['recipient@example.test'] });
    const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [weeklyReportPlugin, meetingSummaryPlugin] }), empty = new AgentHost(() => ctx);
    await host.initialize(); await empty.initialize();
    return { dir, ctx, weekly, records, queries, emails, updates, audits, host, empty,
        app: new Elysia().use(createApiDocumentation()).use(createPluginApi(host)), absent: createPluginApi(empty),
        cleanup: async () => { await host.stop(); await empty.stop(); await rm(dir, { recursive: true, force: true }); },
    };
}

test('report plugins own routes and metadata; hidden archive pages remain addressable without appearing in navigation', async () => {
    const f = await fixture();
    try {
        expect(f.host.web.pages()).toMatchObject([{ path: '/weekly-reports' }, { path: '/meeting-summaries', navigation: false }]);
        for (const [url, method] of [['/api/weekly-reports', 'GET'], ['/api/weekly-reports/weekly-one', 'GET'], ['/api/meeting-summaries', 'GET'], ['/api/meeting-summaries/file/archive/summary.md', 'GET'], ['/api/meeting-summaries/meeting-0/send-email', 'POST']]) expect((await f.absent.handle(request(url!, method))).status).toBe(404);
        expect(f.queries).toEqual([]); expect(f.emails).toEqual([]); expect(f.updates).toEqual([]);
        const spec: any = await (await f.app.handle(request('/api/swagger/json'))).json();
        expect(spec.paths['/api/weekly-reports/{id}'].get).toBeDefined();
        expect(spec.paths['/api/meeting-summaries/{id}/send-email'].post).toBeDefined();
        const forbidden = new Request('http://localhost/api/meeting-summaries/meeting-0/send-email', { method: 'POST', headers: { origin: 'https://foreign.example' } });
        expect((await f.app.handle(forbidden)).status).toBe(403); expect(f.emails).toEqual([]);
    } finally { await f.cleanup(); }
});

test('weekly APIs expose only successful metadata and confined HTML, keeping group filters and file headers', async () => {
    const f = await fixture();
    try {
        const listed = await f.app.handle(request('/api/weekly-reports?groupId=oc_one')); expect(listed.status).toBe(200);
        const text = await listed.text(); expect(text).not.toContain('PRIVATE'); expect(text).not.toContain(f.dir);
        expect(JSON.parse(text).reports.map((report: any) => report.id)).toEqual(['weekly-one']);
        expect(f.queries[0]).toEqual({ weekly: 'oc_one' });
        const html = await f.app.handle(request('/api/weekly-reports/weekly-one'));
        expect(html.headers.get('content-type')).toContain('text/html'); expect(html.headers.get('cache-control')).toBe('private, max-age=60'); expect(await html.text()).toContain('Historical weekly report');
        expect((await f.app.handle(request('/api/weekly-reports/weekly-failed'))).status).toBe(404);
        expect((await f.app.handle(request('/api/weekly-reports/missing'))).status).toBe(404);
        await symlink(path.join(f.dir, 'private.md'), path.join(f.dir, 'weekly-reports/linked.html'));
        for (const file of [path.join(f.dir, 'private.md'), path.join(f.dir, 'weekly-reports/linked.html'), path.join(f.dir, 'weekly-reports/missing.html')]) {
            f.weekly[0].html_path = file;
            const response = await f.app.handle(request('/api/weekly-reports/weekly-one')); expect(response.status).toBe(404); expect(await response.text()).not.toContain('PRIVATE');
        }
        f.ctx.store.listWeeklyReports = async () => { throw new Error('PRIVATE database'); };
        const failed = await f.app.handle(request('/api/weekly-reports')); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain('PRIVATE');
    } finally { await f.cleanup(); }
});

test('meeting history applies group and bounded pagination and excludes internal record fields', async () => {
    const f = await fixture();
    try {
        const response = await f.app.handle(request('/api/meeting-summaries?groupId=oc_one&skip=2&limit=3'));
        const data: any = await response.json(); expect(response.status).toBe(200); expect(data.total).toBe(10);
        expect(data.summaries.map((record: any) => record.id)).toEqual(['meeting-4', 'meeting-6', 'meeting-8']);
        expect(data.summaries[0]).toMatchObject({ date: '2026-11-05', source_message_id: 'original-message-id' });
        expect(JSON.stringify(data)).not.toContain('PRIVATE'); expect(data.email).toEqual({ ready: true, recipients: ['recipient@example.test'] });
        const before = f.queries.length;
        for (const query of ['skip=-1', 'limit=201', 'skip=1.5', 'limit=0', 'limit=abc', 'unknown=true']) expect((await f.app.handle(request('/api/meeting-summaries?' + query))).status).toBe(400);
        expect(f.queries).toHaveLength(before);
    } finally { await f.cleanup(); }
});

test('nested Markdown reads reject path escape and both file and directory symlinks to other data', async () => {
    const f = await fixture();
    try {
        const response = await f.app.handle(request('/api/meeting-summaries/file/archive/summary.md'));
        expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/markdown'); expect(await response.text()).toBe('# Summary');
        await symlink(path.join(f.dir, 'private.md'), path.join(f.dir, 'summaries/linked.md'));
        await symlink(f.dir, path.join(f.dir, 'summaries/linked-dir'));
        for (const file of ['..%2fprivate.md', '..%5cprivate.md', '%252e%252e%252fprivate.md', 'linked.md', 'linked-dir/private.md', 'archive/summary.html', 'bad%00.md']) {
            const rejected = await f.app.handle(request('/api/meeting-summaries/file/' + file)); expect(rejected.status).toBe(404); expect(await rejected.text()).not.toContain('PRIVATE');
        }
    } finally { await f.cleanup(); }
});

test('email uses archived attachment contents and configured recipients; successful repeats do not send again', async () => {
    const f = await fixture(), url = '/api/meeting-summaries/meeting-0/send-email';
    try {
        expect((await f.app.handle(request(url, 'POST', { to: 'other@example.test' }))).status).toBe(400); expect(f.emails).toEqual([]);
        f.records[0].theme = 'Meeting\r\nBcc: injected';
        const response = await f.app.handle(request(url, 'POST')); expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
        expect(f.emails).toHaveLength(1); expect(f.emails[0]).toHaveLength(3); expect(f.emails[0][0]).not.toMatch(/[\r\n]/);
        expect(f.emails[0][2]).toEqual([{ filename: 'summary.md', content: '# Summary' }, { filename: 'timeline.md', content: '# Timeline' }]);
        expect(f.updates).toEqual(['meeting-0']); expect(f.records[0].email_sent).toBe(true); expect(f.audits[0][0]).toBe('meeting_summary_email_accepted');
        expect(await (await f.app.handle(request(url, 'POST'))).json()).toEqual({ success: true, alreadySent: true }); expect(f.emails).toHaveLength(1);
    } finally { await f.cleanup(); }
});

test('email rejects missing configuration, simulation, missing records or invalid attachments without marking success', async () => {
    const f = await fixture(), url = '/api/meeting-summaries/meeting-0/send-email';
    try {
        f.ctx.config.email.enabled = false; expect((await f.app.handle(request(url, 'POST'))).status).toBe(400); f.ctx.config.email.enabled = true;
        f.ctx.email.dryRun = true; expect((await f.app.handle(request(url, 'POST'))).status).toBe(400); f.ctx.email.dryRun = false;
        expect((await f.app.handle(request('/api/meeting-summaries/missing/send-email', 'POST'))).status).toBe(404);
        for (const filename of ['../private.md', 'archive/missing.md']) { f.records[0].timeline_file = filename; expect((await f.app.handle(request(url, 'POST'))).status).toBe(404); }
        expect(f.emails).toEqual([]); expect(f.updates).toEqual([]);
        f.records[0].timeline_file = 'archive/timeline.md'; f.ctx.email.sendEmail = async () => ({ ok: false, error: 'PRIVATE SMTP credentials' });
        const failed = await f.app.handle(request(url, 'POST')); expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('PRIVATE');
        expect(f.records[0].email_sent).toBe(false); expect(f.updates).toEqual([]); expect(f.audits.at(-1)[0]).toBe('meeting_summary_email_unconfirmed');
    } finally { await f.cleanup(); }
});

test('concurrent email requests share one submission and accepted-but-unrecorded outcomes are not resent in this process', async () => {
    const f = await fixture(), url = '/api/meeting-summaries/meeting-0/send-email';
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    try {
        f.ctx.email.sendEmail = async () => { f.emails.push('sent'); started(); await gate; return { ok: true }; };
        const first = f.app.handle(request(url, 'POST')), second = f.app.handle(request(url, 'POST'));
        await entered; release(); const responses = await Promise.all([first, second]);
        for (const response of responses) { expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true }); }
        expect(f.emails).toHaveLength(1); expect(f.updates).toHaveLength(1);
        f.ctx.store.prisma.meetingSummaryRecord.update = async () => { throw new Error('PRIVATE storage'); };
        const secondUrl = '/api/meeting-summaries/meeting-1/send-email';
        for (let i = 0; i < 2; i++) { const failed = await f.app.handle(request(secondUrl, 'POST')); expect(failed.status).toBe(502); const data: any = await failed.json(); expect(data.accepted).toBe(true); expect(data.error).not.toContain('PRIVATE'); }
        expect(f.emails).toHaveLength(2); expect(f.records[1].email_sent).toBe(false);
    } finally { release(); await f.cleanup(); }
});
