import { expect, test } from 'bun:test';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createMcpPlugin, mcpConfig } from '@/connectors/mcp/plugin';
import { createMcpHttpFetch, type McpHttpNetwork } from '@/connectors/mcp/http';
import { mcpReaderPlugin } from '../examples/plugins/mcp-reader';

const endpoint = 'https://mcp.example.com/mcp';
const binding = { alias: 'read', name: 'read_note', description: 'Reviewed remote read', readOnly: true };
const tool = { name: 'read_note', inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } };

function fixture(mode = 'json', tokenRef?: string) {
    const events: Array<{ method: string; rpc?: string; authorization: string | null; session: string | null }> = [];
    const pinned: Array<{ hostname: unknown; servername: unknown; host: unknown }> = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const message = request.method === 'POST' ? await request.json() as { id?: number; method: string; params?: { arguments?: { path: string } } } : undefined;
        events.push({ method: request.method, rpc: message?.method, authorization: request.headers.get('authorization'), session: request.headers.get('mcp-session-id') });
        if (request.method === 'GET') return new Response(null, { status: 405 });
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        if (message?.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1.0.0' },
        } }, { headers: { 'mcp-session-id': 'fixture-session' } });
        if (message?.method === 'notifications/initialized' || message?.method === 'notifications/cancelled') return new Response(null, { status: 202 });
        if (message?.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [tool, { name: 'unselected_write', inputSchema: { type: 'object' } }] } });
        if (message?.method !== 'tools/call') return new Response(null, { status: 400 });
        if (mode === 'redirect') return new Response(null, { status: 307, headers: { location: 'https://other.example.com/stolen' } });
        if (mode === 'hang') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
        const path = message.params?.arguments?.path;
        const result = { content: [{ type: 'text', text: mode === 'oversize' ? 'x'.repeat(3 * 1024 * 1024) : `Remote: ${path}` }],
            structuredContent: { path: mode === 'invalid' ? 42 : path }, ...(mode === 'error' ? { isError: true } : {}) };
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (mode === 'oversize-stream') return new Response(new ReadableStream({ start(controller) {
            for (let chunk = 0; chunk < 3; chunk++) controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
        } }), { headers: { 'content-type': 'application/json' } });
        return mode === 'sse' ? new Response(`event: message\ndata: ${payload}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : new Response(payload, { headers: { 'content-type': 'application/json' } });
    } });
    const network: McpHttpNetwork = {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        request(options, callback) {
            pinned.push({ hostname: options.hostname, servername: options.servername, host: (options.headers as Record<string, unknown>).host });
            return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.port }, callback);
        },
    };
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'test', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: [mcpReaderPlugin, createMcpPlugin(network)], pluginConfig: { 'connector.mcp': { servers: [{ id: 'files', transport: 'http', url: endpoint,
            tokenRef, timeoutMs: mode === 'hang' ? 300 : 2000, tools: [binding] }] } },
    });
    return { host, events, pinned, network, server, async close() { try { await host.stop(); } finally { await server.stop(true); } } };
}

test('keeps legacy stdio configuration and accepts only explicit public HTTPS endpoints and credential references', () => {
    const server = { id: 'files', transport: 'http', url: endpoint, tools: [binding] };
    expect(mcpConfig.parse({ servers: [{ id: 'files', command: 'node', tools: [binding] }] }).servers[0]?.transport).toBe('stdio');
    expect(mcpConfig.safeParse({ servers: [server] }).success).toBe(true);
    for (const url of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://127.0.0.1/mcp', 'https://[::1]/mcp',
        'https://service.local/mcp', 'https://example.com:8443/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#fragment']) {
        expect(mcpConfig.safeParse({ servers: [{ ...server, url }] }).success).toBe(false);
    }
    for (const extra of [{ tokenRef: 'literal-secret' }, { command: 'node' }, { envRefs: { SECRET: 'env://TOKEN' } }]) {
        expect(mcpConfig.safeParse({ servers: [{ ...server, ...extra }] }).success).toBe(false);
    }
});

test('rejects private or mixed DNS answers, changed endpoints and pre-cancelled requests before opening a connection', async () => {
    let requests = 0;
    for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
        const fetch = createMcpHttpFetch(endpoint, 300, { resolve: async () => addresses, request() { requests++; throw new Error('must not connect'); } });
        await expect(fetch(endpoint)).rejects.toThrow('exclusively public');
        await expect(fetch('https://other.example.com/mcp')).rejects.toThrow('fixed endpoint');
        await expect(fetch(endpoint, { method: 'PUT' })).rejects.toThrow('protocol methods');
        await expect(fetch(endpoint, { signal: AbortSignal.abort() })).rejects.toThrow();
    }
    expect(requests).toBe(0);
});

test('bounds DNS waiting and never opens a connection after timeout', async () => {
    let requests = 0;
    const fetch = createMcpHttpFetch(endpoint, 100, { resolve: () => new Promise(() => {}), request() { requests++; throw new Error('must not connect'); } });
    await expect(fetch(endpoint)).rejects.toThrow('timed out');
    expect(requests).toBe(0);
});

for (const mode of ['json', 'sse']) test(`runs a real HTTP ${mode} MCP exchange with pinned routing, selected tools and session cleanup`, async () => {
    const saved = process.env.MCP_HTTP_TEST_TOKEN; process.env.MCP_HTTP_TEST_TOKEN = 'dummy-http-token';
    const f = fixture(mode, 'env://MCP_HTTP_TEST_TOKEN');
    try {
        const result = await f.host.runLocal('example.mcp.read', { prompt: 'notes/demo.md' }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded');
        expect(result.execution?.artifacts[0]?.content).toBe('Remote: notes/demo.md');
        expect(result.execution?.result.metrics).toEqual({ modelCalls: 0, toolCalls: 1 });
        expect(f.host.toolRegistry.list().map(tool => tool.id)).toEqual(['mcp.files.read']);
        expect((await f.host.getLocalRunDetails(result.execution!.run.id))?.steps.map(step => step.kind).sort()).toEqual(['agent', 'tool']);
        expect(f.pinned.every(request => request.hostname === '93.184.216.34' && request.servername === 'mcp.example.com' && request.host === 'mcp.example.com')).toBe(true);
        expect(f.events.every(event => event.authorization === 'Bearer dummy-http-token')).toBe(true);
        expect(f.events.find(event => event.rpc === 'tools/call')?.session).toBe('fixture-session');
    } finally {
        await f.close();
        if (saved === undefined) delete process.env.MCP_HTTP_TEST_TOKEN; else process.env.MCP_HTTP_TEST_TOKEN = saved;
    }
    expect(f.events.filter(event => event.method === 'DELETE')).toHaveLength(1);
    expect(f.host.toolRegistry.list()).toEqual([]);
});

test('HTTP tool errors, invalid output, byte overflow, redirects and stalled streams never publish success or repeat calls', async () => {
    for (const mode of ['error', 'invalid', 'oversize', 'oversize-stream', 'redirect', 'hang']) {
        const f = fixture(mode);
        try {
            const result = await f.host.runLocal('example.mcp.read', { prompt: 'notes/demo.md' }, randomUUID());
            expect(result.execution?.run.status).toBe('failed');
            expect(result.execution?.artifacts).toEqual([]);
            expect(f.events.filter(event => event.rpc === 'tools/call')).toHaveLength(1);
            if (mode === 'hang') expect(result.execution?.run.error?.code).toBe('MCP_TIMEOUT');
        } finally { await f.close(); }
    }
});

test('cancelling a streaming response releases the actual HTTP request without waiting for its timeout', async () => {
    const f = fixture('hang');
    try {
        const fetch = createMcpHttpFetch(endpoint, 3000, f.network);
        const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ id: 1, method: 'tools/call', params: { arguments: { path: 'notes/a.md' } } }) });
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
        const deadline = Date.now() + 1000;
        while (f.server.pendingRequests) { if (Date.now() > deadline) throw new Error('Cancelled MCP HTTP request remained open'); await Bun.sleep(10); }
        expect(f.server.pendingRequests).toBe(0);
    } finally { await f.close(); }
});

test('a missing bearer-token reference fails before contacting the HTTP service', async () => {
    const f = fixture('json', `env://MCP_MISSING_${randomUUID().replaceAll('-', '').toUpperCase()}`);
    try { await expect(f.host.initialize()).rejects.toThrow('Secret is not configured'); expect(f.events).toEqual([]); }
    finally { await f.close(); }
});
