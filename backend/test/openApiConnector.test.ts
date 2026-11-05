import { expect, test } from 'bun:test';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { buildConfig } from '@/core/config';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { createExecutionScope, createTriggerScope } from '@/platform/runtime/scope';
import type { WebTransport } from '@/knowledge/web/network';
import { validateSchema } from '@/platform/agents/schema';
import { readSmallJsonBody } from '@/platform/workspace/request';
import { argumentsSchema, connectorConfig, grantedOperation, operationUrl } from '@/connectors/openapi/contracts';
import { fetchApiData, inspectOpenApi, readCatalog } from '@/connectors/openapi/catalog';
import { createOpenApiSetupPlugin, exportOpenApiProfile, OPENAPI_SETUP_CAPABILITY } from '@/connectors/openapi/setup';
import { createOpenApiConnectorPlugin, OPENAPI_RUN_CAPABILITY } from '@/connectors/openapi/plugin';

const yaml = (value: unknown) => stringify(value, { aliasDuplicateObjects: false });
const sourceUrl = 'https://spec.example.com/api.yaml';
const responses = { '200': { content: { 'application/json': { schema: { type: 'object' } } } } };
const spec = (): any => ({ openapi: '3.1.0', info: { title: 'Read fixture', version: '1' }, servers: [{ url: 'https://api.example.com/v1' }], paths: {
    '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', format: 'int32' } }], get: { operationId: 'read', responses, parameters: [{ name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } }] }, post: { responses } },
} });
const catalog = (document: unknown = spec()) => readCatalog(yaml(document), sourceUrl, 'fixture');
function fixture(document: unknown = spec()) {
    const requests: Array<{ url: string; accept?: string; address: string }> = [];
    let status = 200, mime = 'application/json', body = JSON.stringify({ result: 'fixture response' });
    const network: WebTransport = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], async request(url, address, _maxBytes, _signal, accept) {
        requests.push({ url: url.href, address, accept });
        return url.href === sourceUrl ? { status: 200, headers: { 'content-type': 'application/yaml' }, body: Buffer.from(yaml(document)) }
            : { status, headers: { 'content-type': mime }, body: Buffer.from(body) };
    } };
    return { network, requests, response(next: { status?: number; mime?: string; body?: string }) { status = next.status ?? status; mime = next.mime ?? mime; body = next.body ?? body; } };
}
function host(plugins: any[], pluginConfig: Record<string, Record<string, unknown>> = {}, store = new InMemoryPersistentKeyValueStore()) {
    return new AgentHost(() => ({ store, config: { feishu: { bot_name: 'test', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins, pluginConfig });
}

test('catalog supports 3.0/3.1 local refs and overrides, fingerprints source and visibly omits optional credentials', () => {
    for (const openapi of ['3.0.3', '3.1.0']) {
        const doc = spec(); doc.openapi = openapi;
        doc.components = { schemas: { Tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }, parameters: { Tags: { name: 'tags', in: 'query', schema: { $ref: '#/components/schemas/Tags' } } } };
        doc.paths['/items/{id}'].parameters.push({ name: 'tags', in: 'query', schema: { type: 'number' } });
        doc.paths['/items/{id}'].get.parameters = [{ $ref: '#/components/parameters/Tags' }, { name: 'apikey', in: 'query', schema: { type: 'string' } }];
        const result = catalog(doc), op = result.operations[0]!;
        expect(op.issue).toBeUndefined(); expect(op.parameters).toHaveLength(2); expect(op.warnings[0]).toContain('apikey');
        expect(op.parameters[1].schema.items.enum).toEqual(['a', 'b']);
        expect(op.parameters[0].schema).toEqual({ type: 'integer', minimum: -2147483648, maximum: 2147483647 });
        expect(result.source.sha256).toBe(createHash('sha256').update(yaml(doc)).digest('hex')); expect(result.operations[1]!.issue).toContain('GET');
    }
});

test('auth, writes, unsupported schemas, remote/cyclic refs and invalid servers stay visibly unavailable', () => {
    const patches: Record<string, unknown>[] = [{ security: [{ bearer: [] }] }, { requestBody: {} }, { parameters: [{ name: 'token', in: 'header', schema: { type: 'string' } }] }, { parameters: [{ name: 'password', in: 'query', required: true, schema: { type: 'string' } }] },
        ...[{ type: 'object' }, { type: ['string', 'null'] }, { type: 'string', pattern: '.*' }, { type: 'array', items: { type: 'array', items: { type: 'string' } } }, { $ref: 'https://evil.example/schema' }, { $ref: '#/components/schemas/Cycle' }, { type: 'integer', format: 'uuid' }, { type: 'integer', format: 'int32', minimum: '1' }].map(schema => ({ parameters: [{ name: 'q', in: 'query', schema }] })),
        ...['http://api.example.com', 'https://localhost', 'https://{host}.example.com'].map(url => ({ servers: [{ url }] }))];
    for (const patch of patches) { const doc = spec(); doc.components = { schemas: { Cycle: { $ref: '#/components/schemas/Cycle' } } }; Object.assign(doc.paths['/items/{id}'].get, patch); expect(catalog(doc).operations[0]!.issue).toBeTruthy(); }
    const doc = spec(); doc.security = [{ bearer: [] }]; doc.paths['/items/{id}'].get.security = []; doc.servers.push({ url: 'http://api.example.com' });
    expect(catalog(doc).operations[0]!.issue).toBeUndefined(); expect(catalog(doc).operations[0]!.serverWarning).toBeTruthy();
    for (const text of ['openapi: 2.0\npaths: {}', 'a: &a [x]\nb: *a', yaml({ ...spec(), paths: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`/${i}`, {}])) }), 'x'.repeat(1024 * 1024 + 1)]) expect(() => readCatalog(text, sourceUrl, 'fixture')).toThrow();
});

test('pinned inputs enforce type, safe integers, extra keys, array bounds and fixed path/query serialization', () => {
    const entry = catalog().operations[0]!;
    const operation = grantedOperation.parse({ ...Object.fromEntries(['key', 'alias', 'method', 'path', 'summary', 'parameters'].map(key => [key, entry[key]])), serverUrl: entry.servers[0] });
    const schema = argumentsSchema(operation), args = { path: { id: 42 }, query: { tags: ['a b', 'c&d'] } };
    expect(validateSchema(args, schema)).toEqual([]); expect(operationUrl(operation, args).href).toBe('https://api.example.com/v1/items/42?tags=a+b&tags=c%26d');
    for (const invalid of [{}, { path: { id: '42' } }, { path: { id: 2147483648 } }, { ...args, token: 'x' }, { ...args, query: { tags: Array(101).fill('a') } }, { ...args, query: { apikey: 'x' } }]) expect(validateSchema(invalid, schema).length).toBeGreaterThan(0);
    const stringOp = structuredClone(operation); stringOp.parameters[0]!.schema = { type: 'string' };
    for (const id of ['..', '.', '../admin', 'a/b', '%2F', 'a?b']) expect(() => operationUrl(stringOp, { path: { id } })).toThrow();
    const csv = structuredClone(operation); csv.parameters[1]!.explode = false;
    expect(operationUrl(csv, args).searchParams.get('tags')).toBe('a b,c&d'); expect(() => operationUrl(csv, { path: { id: 42 }, query: { tags: ['a,b'] } })).toThrow();
    const integer = structuredClone(operation); integer.parameters[0]!.schema = { type: 'integer' };
    expect(validateSchema({ path: { id: Number.MAX_SAFE_INTEGER + 1 } }, argumentsSchema(integer)).length).toBeGreaterThan(0);
});

test('transport blocks private/mixed DNS, redirects, oversize data, credentials and cancellation', async () => {
    const f = fixture();
    for (const url of ['http://api.example.com', 'https://localhost', 'https://127.0.0.1', 'https://u:p@api.example.com', 'https://api.example.com/#x']) await expect(fetchApiData(url, new AbortController().signal, f.network)).rejects.toThrow();
    expect(f.requests).toEqual([]);
    await expect(fetchApiData(sourceUrl, new AbortController().signal, { ...f.network, resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] })).rejects.toThrow('DNS'); expect(f.requests).toEqual([]);
    f.response({ status: 302 }); await expect(fetchApiData('https://api.example.com/v1', new AbortController().signal, f.network)).rejects.toThrow('重定向'); expect(f.requests).toHaveLength(1);
    f.response({ status: 200, body: 'x'.repeat(1024 * 1024 + 1) }); await expect(fetchApiData('https://api.example.com/v1', new AbortController().signal, f.network)).rejects.toThrow('byte budget');
    await expect(inspectOpenApi({ url: sourceUrl + '?token=x', serviceId: 'fixture' }, new AbortController().signal, f.network)).rejects.toThrow();
    const abort = new AbortController(); setTimeout(() => abort.abort(new Error('cancelled')), 10);
    await expect(fetchApiData(sourceUrl, abort.signal, { ...f.network, resolve: () => new Promise(() => {}) })).rejects.toThrow('cancelled');
});

test('inspection to scope-bound export to loaded profile executes through gateway and unloads without deleting history', async () => {
    const f = fixture(), store = new InMemoryPersistentKeyValueStore(), setup = host([createOpenApiSetupPlugin(f.network)], {}, store);
    const filename = `${import.meta.dir}/../examples/openapi-test-${randomUUID()}.local.yaml`; let runner: AgentHost | undefined;
    try {
        const result = await setup.runLocal(OPENAPI_SETUP_CAPABILITY, { serviceId: 'fixture', url: sourceUrl }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded'); expect(f.requests.map(request => request.url)).toEqual([sourceUrl]); expect(result.execution?.result.metrics).toEqual({ modelCalls: 0, toolCalls: 1 });
        const detail = (await setup.getLocalRunDetails(result.execution!.run.id))!;
        expect(detail.steps.map(step => step.kind).sort()).toEqual(['agent', 'tool']); expect(detail.artifacts[0]!.metadata.artifactRole).toBe('openapi.catalog');
        const input = { inspectionRunId: detail.run.id, reviewedReadOnly: true, selections: [{ key: 'GET /items/{id}', serverUrl: 'https://api.example.com/v1' }] };
        for (const patch of [{ reviewedReadOnly: false }, { selections: [] }, { selections: [input.selections[0], input.selections[0]] }, { selections: [{ ...input.selections[0], serverUrl: 'https://evil.example.com' }] }, { selections: [{ ...input.selections[0], key: 'POST /items/{id}' }] }, { module: '/tmp/evil.ts' }, { inspectionRunId: randomUUID() }]) await expect(exportOpenApiProfile(store, { ...input, ...patch })).rejects.toThrow();
        const key = `agent:run:${detail.run.id}`;
        for (const patch of [{ workspaceId: 'another' }, { botInstanceId: 'another' }, { parentRunId: randomUUID() }, { capability: 'other' }, { status: 'failed' }]) { await store.setIdempotencyKey(key, { ...detail.run, ...patch }); await expect(exportOpenApiProfile(store, input)).rejects.toThrow('成功发现'); }
        await store.setIdempotencyKey(key, detail.run);
        const exported = await exportOpenApiProfile(store, input); expect(exported.filename).toBe('openapi-fixture.local.yaml'); expect(parse(exported.yaml).plugins).toHaveLength(2); await writeFile(filename, exported.yaml);
        expect(await exportOpenApiProfile(store, { ...input, includePersonalWorkspace: false })).toEqual(exported);
        await expect(exportOpenApiProfile(store, { ...input, includePersonalWorkspace: 'true' })).rejects.toThrow();
        const selected = await loadPluginConfiguration(filename); expect(selected.plugins.map(plugin => plugin.manifest.id)).toEqual(['connector.openapi', 'openapi.setup']);
        runner = host(selected.plugins.map(plugin => plugin.manifest.id === 'connector.openapi' ? createOpenApiConnectorPlugin(f.network) : plugin), selected.config, store); await runner.initialize();
        expect((await (await runner.web.handle(new Request('http://localhost/api/openapi-runner/tools'))).json()).tools[0].id).toBe('openapi.fixture.get-read');
        const request = { toolId: 'openapi.fixture.get-read', arguments: { path: { id: 42 }, query: { tags: ['a', 'b'] } } };
        const run = await runner.runLocal(OPENAPI_RUN_CAPABILITY, request, randomUUID()); expect(run.execution?.run.status).toBe('succeeded'); expect(run.execution?.result.metrics).toEqual({ modelCalls: 0, toolCalls: 2 });
        expect((await runner.getLocalRunDetails(run.execution!.run.id))!.steps.map(step => step.kind).sort()).toEqual(['agent', 'tool', 'tool']); expect(run.execution?.artifacts.find(item => item.type === 'text')?.content).toContain('fixture response');
        expect((run.execution?.result.data as any).source.sha256).toBe((result.execution?.result.data as any).source.sha256);
        expect(f.requests[1]).toEqual({ url: 'https://api.example.com/v1/items/42?tags=a&tags=b', address: '93.184.216.34', accept: 'application/json, application/yaml, text/yaml, text/plain' }); const count = f.requests.length;
        for (const invalid of [{ ...request, toolId: 'openapi.fixture.write' }, { ...request, arguments: { path: { id: '../admin' } } }, { ...request, arguments: { path: { id: 42 }, query: { apikey: 'secret' } } }]) expect((await runner.runLocal(OPENAPI_RUN_CAPABILITY, invalid, randomUUID())).execution?.run.status).toBe('failed');
        const scope = createExecutionScope(createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: 'budget' }), 'install-openapi-runner');
        const execution = { scope, runId: run.execution!.run.id, agentId: 'native.openapi-runner', allowedTools: ['openapi-runner.invoke'], budget: new RunToolCallBudget(1) };
        await expect(runner['toolGateway']!.execute('openapi-runner.invoke', request, execution)).rejects.toMatchObject({ code: 'TOOL_CALL_LIMIT_EXCEEDED' });
        await expect(runner['toolGateway']!.execute('openapi-runner.invoke', request, { ...execution, scope: { ...scope, chatId: 'group' }, budget: new RunToolCallBudget(2) })).rejects.toThrow(); expect(f.requests).toHaveLength(count);
        for (const response of [{ mime: 'text/html' }, { mime: 'application/json', body: 'bad json' }, { status: 500 }]) { f.response(response); const failed = await runner.runLocal(OPENAPI_RUN_CAPABILITY, request, randomUUID()); expect(failed.execution?.run.status).toBe('failed'); expect(failed.execution?.artifacts).toEqual([]); }
        f.response({ status: 200, mime: 'application/json', body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }) }); const large = await runner.runLocal(OPENAPI_RUN_CAPABILITY, request, randomUUID()); expect(large.execution?.run.status).toBe('succeeded'); expect(String(large.execution?.artifacts.find(item => item.type === 'text')?.content)).toContain('预览已截断');
        const post = (body: string, origin?: string) => setup.web.handle(new Request('http://localhost/api/openapi-setup/profile', { method: 'POST', body, headers: origin ? { origin } : {} }));
        expect((await post(JSON.stringify(input))).status).toBe(200); expect((await post(JSON.stringify(input), 'https://evil.example')).status).toBe(403); expect((await post('x'.repeat(17000))).status).toBe(400);
        await runner.stop(); expect(runner.web.pages()).toEqual([]); expect(runner.toolRegistry.list()).toEqual([]); expect((await new PersistentAgentRunStore(store).get(detail.run.id))?.status).toBe('succeeded'); expect(connectorConfig.safeParse({ ...selected.config['connector.openapi'], reviewedReadOnly: false }).success).toBe(false);
    } finally { await setup.stop(); await runner?.stop(); await rm(filename, { force: true }); }
});

test('a personal OpenAPI export retains the actual knowledge workbench and only grants the reviewed fixed GET', async () => {
    const f = fixture(), directory = await mkdtemp(path.join(tmpdir(), 'personal-openapi-'));
    const file = `${import.meta.dir}/../examples/openapi-personal-${randomUUID()}.local.yaml`;
    const keys = ['KNOWLEDGE_KIND', 'KNOWLEDGE_EXCLUDE', 'KNOWLEDGE_VAULT_NAME', 'RELEASE_GITHUB_REPOSITORY'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.KNOWLEDGE_KIND = 'sample'; for (const key of keys.slice(1)) delete process.env[key];
    const store = new InMemoryPersistentKeyValueStore(), setup = host([createOpenApiSetupPlugin(f.network)], {}, store); let runner: AgentHost | undefined;
    try {
        const inspection = await setup.runLocal(OPENAPI_SETUP_CAPABILITY, { serviceId: 'fixture', url: sourceUrl }, randomUUID());
        const exported = await exportOpenApiProfile(store, { inspectionRunId: inspection.execution!.run.id, reviewedReadOnly: true, selections: [{ key: 'GET /items/{id}', serverUrl: 'https://api.example.com/v1' }], includePersonalWorkspace: true });
        expect(exported.filename).toBe('openapi-fixture.personal.local.yaml'); expect(parse(exported.yaml).base).toBe('personal'); expect(parse(exported.yaml).plugins).toHaveLength(2);
        await writeFile(file, exported.yaml); await expect(loadPluginConfiguration(file)).rejects.toThrow('本机工作台');
        const selection = await loadWorkspacePlugins(directory, file); expect(selection.base).toBe('personal'); expect(selection.plugins).toHaveLength(16);
        const config = { ...buildConfig({}), data_path: directory };
        runner = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selection.plugins.map(plugin => plugin.manifest.id === 'connector.openapi' ? createOpenApiConnectorPlugin(f.network) : plugin), pluginConfig: selection.config });
        await runner.initialize(); expect(await runner.listAgents()).toHaveLength(11);
        expect(runner.web.pages().map(page => page.path)).toEqual(expect.arrayContaining(['/knowledge', '/research', '/recipes', '/openapi-setup', '/openapi-runner']));
        const knowledge = await runner.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, randomUUID());
        expect((knowledge.execution!.result.data as any).hits.length).toBeGreaterThan(0);
        const result = await runner.runLocal(OPENAPI_RUN_CAPABILITY, { toolId: 'openapi.fixture.get-read', arguments: { path: { id: 42 } } }, randomUUID());
        expect(result.execution!.run.status).toBe('succeeded'); expect(result.execution!.result.metrics).toEqual({ modelCalls: 0, toolCalls: 2 });
        expect(f.requests.map(request => request.url)).toEqual([sourceUrl, 'https://api.example.com/v1/items/42']);
        expect((await (await runner.web.handle(new Request('http://localhost/api/openapi-runner/tools'))).json()).tools.map((tool: any) => tool.id)).toEqual(['openapi.fixture.get-read']);
        await runner.stop(); expect((await new PersistentAgentRunStore(store).get(knowledge.execution!.run.id))?.status).toBe('succeeded');
    } finally {
        for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
        await setup.stop(); await runner?.stop(); await rm(file, { force: true }); await rm(directory, { recursive: true, force: true });
    }
});

test('bounded JSON reader cancels a stalled stream on caller abort', async () => {
    const controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } }); const request = new Request('http://localhost/api/profile', { method: 'POST', body, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop reading')), 10); await expect(readSmallJsonBody(request)).rejects.toThrow('stop reading'); expect(cancelled).toBe(true);
});
