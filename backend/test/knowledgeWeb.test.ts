import { standardModelPlugins } from '@/platform/models/providers';
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { KNOWLEDGE_ANSWER_CAPABILITY } from '@/knowledge/answer/plugin';
import { retrievalEvidence } from '@/knowledge/answer/evidence';
import { knowledgeWebAnswerPlugin } from '@/knowledge/web/answerPlugin';
import { createKnowledgeWebPlugin, KNOWLEDGE_WEB_CAPABILITY } from '@/knowledge/web/plugin';
import { fetchPublicPage, isPublicAddress, publicPageUrl, publicWebTransport, type PublicPage, type WebTransport } from '@/knowledge/web/network';
import { parsePage } from '@/knowledge/web/parser';
import { WebKnowledgeSource, webSourceConfig } from '@/knowledge/web/source';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const url = 'https://example.com/rules';
const page = (text = '# Release\nAPI migration notes are mandatory before release.', finalUrl = url): PublicPage => ({ url: finalUrl, body: Buffer.from(text), contentType: 'text/markdown; charset=utf-8' });
const transport = (overrides: Partial<WebTransport> = {}): WebTransport => ({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('API release') }),
    ...overrides,
});

describe('public web knowledge', () => {
    test('blocks private, special, mapped and alternative literal IP representations', () => {
        for (const ip of ['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.31.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:0808:0808::1']) expect(isPublicAddress(ip)).toBe(false);
        for (const ip of ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888']) expect(isPublicAddress(ip)).toBe(true);
        for (const input of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'https://a:b@example.com/', 'http://localhost/', 'https://service.local/', 'https://example.com:8443/']) expect(() => publicPageUrl(input)).toThrow();
        expect(publicPageUrl(`${url}#section`).href).toBe(url);
        expect(() => webSourceConfig.parse({ urls: [url, `${url}#section`] })).toThrow('Duplicate');
    });

    test('checks every DNS answer and pins a vetted IP before making the request', async () => {
        let resolutions = 0, requests = 0;
        const safe = transport({ resolve: async () => { resolutions++; return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; },
            request: async (target, address) => { requests++; expect(target.hostname).toBe('example.com'); expect(address).toBe('8.8.8.8'); return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') }; } });
        await fetchPublicPage(url, 100, 1000, undefined, safe);
        expect(resolutions).toBe(1);
        await expect(fetchPublicPage(url, 100, 1000, undefined, safe)).rejects.toThrow('exclusively public');
        expect(requests).toBe(1);
        await expect(fetchPublicPage(url, 100, 1000, undefined, transport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], request: safe.request }))).rejects.toThrow('exclusively public');
        expect(requests).toBe(1);
    });

    test('revalidates redirect targets and rejects downgrade, loops and metadata redirects', async () => {
        for (const location of ['http://169.254.169.254/latest', 'https://127.0.0.1/', 'http://example.com/', 'https://user:password@example.com/']) {
            let calls = 0;
            await expect(fetchPublicPage(url, 100, 1000, undefined, transport({ request: async () => { calls++; return { status: 302, headers: { location }, body: Buffer.alloc(0) }; } }))).rejects.toThrow();
            expect(calls).toBe(1);
        }
        let loops = 0;
        await expect(fetchPublicPage(url, 100, 1000, undefined, transport({ request: async () => { loops++; return { status: 302, headers: { location: '/loop' }, body: Buffer.alloc(0) }; } }))).rejects.toThrow('redirect limit');
        expect(loops).toBe(4);
        const visits: string[] = [];
        const result = await fetchPublicPage(url, 100, 1000, undefined, transport({ request: async target => {
            visits.push(target.href);
            return visits.length === 1 ? { status: 301, headers: { location: '/current' }, body: Buffer.alloc(0) }
                : { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('current') };
        } }));
        expect(result.url).toBe('https://example.com/current');
        expect(visits).toHaveLength(2);
        let redirectedRequests = 0;
        await expect(fetchPublicPage(url, 100, 1000, undefined, transport({
            resolve: async host => [{ address: host === 'example.com' ? '8.8.8.8' : '10.0.0.1', family: 4 }],
            request: async () => { redirectedRequests++; return { status: 302, headers: { location: 'https://other.example.com/private' }, body: Buffer.alloc(0) }; },
        }))).rejects.toThrow('exclusively public');
        expect(redirectedRequests).toBe(1);
    });

    test('bounds DNS waits, response bytes and cancellation without starting a request', async () => {
        let calls = 0;
        const pending = transport({ resolve: () => new Promise(() => {}), request: async () => { calls++; throw new Error('must not fetch'); } });
        await expect(fetchPublicPage(url, 100, 10, undefined, pending)).rejects.toThrow('timed out');
        const controller = new AbortController();
        controller.abort(new Error('cancel web'));
        await expect(fetchPublicPage(url, 100, 1000, controller.signal, pending)).rejects.toThrow('cancel web');
        expect(calls).toBe(0);
        await expect(fetchPublicPage(url, 1, 1000, undefined, transport())).rejects.toThrow('byte budget');
    });

    test('the real transport preserves Host, rejects compression and caps chunked responses', async () => {
        const seen: string[] = [];
        const server = createServer((request, response) => {
            seen.push(request.headers.host || '');
            expect(request.headers.cookie).toBeUndefined();
            expect(request.headers.authorization).toBeUndefined();
            expect(request.headers['accept-encoding']).toBe('identity');
            if (request.url === '/gzip') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end('compressed'); }
            else if (request.url === '/oversize') { response.writeHead(200, { 'transfer-encoding': 'chunked' }); response.write('12345'); response.end('67890'); }
            else if (request.url === '/slow') { response.writeHead(200); response.write('waiting'); }
            else { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('API release'); }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
        const port = (server.address() as { port: number }).port;
        const target = (route: string) => new URL(`http://page.example:${port}${route}`);
        const signal = AbortSignal.timeout(1000);
        const normal = await publicWebTransport.request(target('/'), '127.0.0.1', 100, signal);
        expect(normal.body.toString()).toBe('API release');
        await expect(publicWebTransport.request(target('/gzip'), '127.0.0.1', 100, signal)).rejects.toThrow('Compressed');
        await expect(publicWebTransport.request(target('/oversize'), '127.0.0.1', 5, signal)).rejects.toThrow('byte budget');
        expect(seen).toEqual(Array(3).fill(`page.example:${port}`));
        await expect(publicWebTransport.request(target('/slow'), '127.0.0.1', 100, AbortSignal.timeout(20))).rejects.toThrow();
    });

    test('extracts article text without executing scripts or returning navigation and hidden text', () => {
        const html = '<html><head><title>发布规范</title></head><body><nav>NAV_SENTINEL</nav><main><h1>API 发布</h1><p>必须提供迁移说明 &amp; 审核记录。</p><p hidden>HIDDEN_SENTINEL</p></main><script>globalThis.WEB_EXECUTED=true;fetch("http://localhost")</script><footer>FOOTER_SENTINEL</footer></body></html>';
        const result = parsePage(url, { url, body: Buffer.from(html), contentType: 'text/html; charset=UTF-8' });
        expect(result.note.title).toBe('发布规范');
        expect(result.note.chunks.map(chunk => chunk.text).join('\n')).toContain('迁移说明 & 审核记录');
        expect(JSON.stringify(result)).not.toMatch(/NAV_SENTINEL|HIDDEN_SENTINEL|FOOTER_SENTINEL|WEB_EXECUTED/);
        expect((globalThis as any).WEB_EXECUTED).toBeUndefined();
        expect(result.rawVersion).toHaveLength(64);
        for (const contentType of ['application/pdf', 'text/html; charset=gbk']) expect(() => parsePage(url, { url, body: Buffer.from(html), contentType })).toThrow();
        expect(() => parsePage(url, { url, body: Buffer.from([0xff]), contentType: 'text/plain' })).toThrow();
        expect(() => parsePage(url, { url, body: Buffer.from('<html><body></body></html>'), contentType: 'text/html' })).toThrow();
    });

    test('syncs source versions and removes failed pages rather than serving old content', async () => {
        let current = page(), fail = false;
        const source = new WebKnowledgeSource({ urls: [url] }, async () => { if (fail) throw new Error('HTTP 404'); return current; });
        const first = await source.search('API migration');
        expect(first.source.added).toEqual([url]);
        expect(first.hits[0]).toMatchObject({ path: url, openUri: url, sourceKind: 'web', lineBasis: 'extracted_text' });
        expect((await source.search('API migration')).hits[0]!.citationId).toBe(first.hits[0]!.citationId);
        current = page('# Release\nAPI migration policy now requires human review.');
        const changed = await source.search('API migration');
        expect(changed.source.changed).toEqual([url]);
        expect(changed.hits[0]!.citationId).not.toBe(first.hits[0]!.citationId);
        fail = true;
        const removed = await source.search('API migration');
        expect(removed.source).toMatchObject({ removed: [url], partial: true, failed: 1, indexed: 0 });
        expect(removed.hits).toEqual([]);
    });

    test('validates queries before IO and fails a whole scan on aggregate budgets', async () => {
        let calls = 0;
        const source = new WebKnowledgeSource({ urls: [url, 'https://example.com/other'], maxTotalBytes: 10 }, async () => { calls++; return page('123456'); });
        await expect(source.search('!!!')).rejects.toThrow('searchable');
        await expect(source.search('API', 11)).rejects.toThrow();
        expect(calls).toBe(0);
        await expect(source.sync()).rejects.toThrow('total byte budget');
        const stopped = new AbortController(); stopped.abort(new Error('stop scan'));
        await expect(source.sync(stopped.signal)).rejects.toThrow('stop scan');
    });

    test('profile loading, real Host and RAG reuse the governed web Tool and preserve source metadata', async () => {
        const selection = await loadPluginConfiguration(`${import.meta.dir}/../profiles/agents/knowledge-web-answer-demo.yaml`);
        expect(selection.plugins.map(plugin => plugin.manifest.id).sort()).toEqual(['knowledge.answer', 'knowledge.web', 'model.google', 'model.ollama', 'model.openai']);
        let reads = 0;
        const modelRequests: any[] = [];
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            const body = await request.json() as any;
            modelRequests.push(body);
            const supplied = JSON.parse(body.messages.find((message: any) => message.role === 'user').content);
            const evidence = supplied.evidence[0];
            return Response.json({ id: 'web-fixture', object: 'chat.completion', created: 0, model: 'fixture',
                choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ status: 'answered', claims: [{ text: 'Migration notes are required.', citations: [{ citationId: evidence.citationId, quote: evidence.excerpt }] }] }) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
        } });
        cleanup.push(() => server.stop(true));
        const store = new InMemoryPersistentKeyValueStore();
        const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Web test' }, groups: [], ai: { provider: 'openai-compatible', model: 'fixture', api_key: 'local-fixture', api_base: `${server.url}v1` } } }) as any,
            10, undefined, [], { plugins: [...standardModelPlugins, knowledgeWebAnswerPlugin, createKnowledgeWebPlugin(async () => { reads++; return page(); })], pluginConfig: { 'knowledge.web': { urls: [url] } } });
        cleanup.push(() => host.stop());
        const input = { question: 'API migration' };
        const trigger = (id: string, extra = {}) => createTriggerEnvelope({ scope: createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: id, ...extra }), occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } });
        const result = await host.dispatch(trigger('web-answer'), KNOWLEDGE_ANSWER_CAPABILITY, input);
        expect(result.status).not.toBe('failed');
        const data = result.execution!.result.data as any;
        expect(data.status).toBe('answered');
        expect(data.evidence[0]).toMatchObject({ path: url, sourceKind: 'web', lineBasis: 'extracted_text' });
        expect(data.evidence[0].fetchedAt).toBeTruthy();
        expect(data.verification.semanticSupport).toBe('not_verified');
        expect(JSON.stringify(modelRequests[0])).not.toContain(url);
        expect(modelRequests[0].tools || []).toEqual([]);
        expect((await new PersistentAgentRunStore(store).listSteps(result.execution!.run.id)).some(step => step.kind === 'tool' && step.name === 'knowledge.web.search')).toBe(true);
        expect((await host.dispatch(trigger('web-answer'), KNOWLEDGE_ANSWER_CAPABILITY, input)).status).toBe('duplicate');
        const rejected = await host.dispatch(trigger('private', { chatId: 'group' }), KNOWLEDGE_WEB_CAPABILITY, { operation: 'search', query: 'API' });
        expect(rejected.status).toBe('failed');
        expect(reads).toBe(1);
        expect(modelRequests).toHaveLength(1);
        expect(retrievalEvidence.parse({ source: { sourceId: 'web', version: 'a'.repeat(64), syncedAt: '', indexed: 1, partial: false }, retrieval: 'keyword', hits: data.evidence }).hits[0]!.lineBasis).toBe('extracted_text');
    });

    test('CLI rejects ambiguous sources, private URLs and folder-only options', async () => {
        for (const args of [['--root', '.', '--url', url], ['--url', 'http://127.0.0.1/'], ['--url', url, '--exclude', 'private']]) {
            const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../src/scripts/knowledge.ts`, ...args], { stdout: 'pipe', stderr: 'pipe' });
            const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            expect(exit).toBe(1); expect(stdout).toBe(''); expect(stderr).toBeTruthy();
        }
    });
});
