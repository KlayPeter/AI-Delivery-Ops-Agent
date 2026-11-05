import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { createExecutionScope, createTriggerScope } from '@/platform/runtime/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { ToolGateway } from '@/platform/tools/gateway';
import { InMemoryToolCallStore } from '@/platform/tools/callStore';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { mcpConfig, mcpPlugin } from '@/connectors/mcp/plugin';
import { mcpReaderPlugin } from '../examples/plugins/mcp-reader';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'agent-mcp-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture(options: { mode?: string; delayMs?: number; timeoutMs?: number; maxOutputBytes?: number; envRefs?: Record<string, string> } = {}) {
    const prefix = path.join(directory, randomUUID()), pidFile = prefix + '.pid', eventsFile = prefix + '.jsonl';
    await writeFile(prefix + '.json', JSON.stringify({ ...options, pidFile, eventsFile }));
    const server = { id: 'files', command: process.execPath, args: [path.join(import.meta.dir, 'helpers/mcpServer.ts'), prefix + '.json'],
        tools: [{ alias: 'read', name: 'read_note', description: 'Reviewed read access', readOnly: true }],
        timeoutMs: options.timeoutMs || 2000, maxOutputBytes: options.maxOutputBytes || 32768, envRefs: options.envRefs,
    };
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'test', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: [mcpReaderPlugin, mcpPlugin], pluginConfig: { 'connector.mcp': { servers: [server] } },
    });
    const events = async () => (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const exited = async () => {
        const pid = Number(await readFile(pidFile, 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
    };
    return { host, store, server, events, exited };
}

test('loads a YAML MCP composition, selects only reviewed tools and records a real no-model Run', async () => {
    const f = await fixture();
    await f.host.stop();
    const profile = path.join(directory, 'plugins.yaml');
    await writeFile(profile, JSON.stringify({ apiVersion: '1.0', plugins: [
        { module: fileURLToPath(new URL('../examples/plugins/mcp-reader.ts', import.meta.url)) },
        { module: fileURLToPath(new URL('../src/connectors/mcp/plugin.ts', import.meta.url)), config: { servers: [f.server] } },
    ] }));
    const selected = await loadPluginConfiguration(profile), store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'test', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
    let runId = '';
    try {
        const result = await host.runLocal('example.mcp.read', { prompt: 'notes/demo.md' }, randomUUID());
        runId = result.execution!.run.id;
        expect(result.execution!.run.status).toBe('succeeded');
        expect(result.execution!.artifacts[0]!.content).toBe('Note: notes/demo.md');
        expect(result.execution!.result.metrics).toEqual({ modelCalls: 0, toolCalls: 1 });
        expect(host.toolRegistry.list().map(tool => tool.id)).toEqual(['mcp.files.read']);
        expect(host.toolRegistry.resolve('mcp.files.read').definition.description).toBe('Reviewed read access');
        const detail = await host.getLocalRunDetails(runId);
        expect(detail!.steps.map(step => step.kind).sort()).toEqual(['agent', 'tool']);
        expect((await f.events()).filter(event => event.event === 'tools/list')).toHaveLength(2);
    } finally { await host.stop(); }
    expect(host.toolRegistry.list()).toEqual([]); await f.exited();
    expect((await new PersistentAgentRunStore(store).listArtifacts(runId))[0]!.content).toBe('Note: notes/demo.md');
});

test('validates explicit read grants and rejects duplicate configuration before spawning a server', () => {
    const server = { id: 'files', command: 'node', tools: [{ alias: 'read', name: 'read_note', description: 'Reviewed access', readOnly: true }] };
    expect(mcpConfig.safeParse({ servers: [server] }).success).toBe(true);
    for (const value of [{ servers: [server, server] }, { servers: [{ ...server, tools: [server.tools[0], server.tools[0]] }] },
        { servers: [{ ...server, tools: [{ ...server.tools[0], readOnly: false }] }] }, { servers: [{ ...server, envRefs: { TOKEN: 'literal-secret' } }] },
    ]) expect(mcpConfig.safeParse(value).success).toBe(false);
});

test('missing tools, task-only tools and initialization failures clean up their child and registrations', async () => {
    for (const mode of ['missing', 'task', 'bad_schema', 'duplicate', 'exit_init', 'hang_init']) {
        const f = await fixture({ mode, timeoutMs: mode === 'hang_init' ? 300 : 2000 });
        try { await expect(f.host.initialize()).rejects.toThrow(); }
        finally { await f.host.stop(); }
        expect(f.host.toolRegistry.list()).toEqual([]); await f.exited();
    }
});

test('remote tool errors, malformed structured output, oversized output and process exit cannot become successful artifacts', async () => {
    for (const mode of ['error', 'invalid_output', 'oversize', 'oversize_frame', 'exit_call']) {
        const f = await fixture({ mode, maxOutputBytes: 1024 });
        try {
            const result = await f.host.runLocal('example.mcp.read', { prompt: 'notes/demo.md' }, randomUUID());
            expect(result.execution!.run.status).toBe('failed'); expect(result.execution!.artifacts).toEqual([]);
            expect(JSON.stringify(await f.host.getLocalRunDetails(result.execution!.run.id))).not.toContain('private-failure-detail');
            expect((await f.events()).filter(event => event.event === 'tools/call')).toHaveLength(1);
        } finally { await f.host.stop(); }
        await f.exited();
    }
});

function execution() {
    return { runId: randomUUID(), agentId: 'example.mcp-reader',
        scope: createExecutionScope(createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: randomUUID() }), 'install-example-mcp-reader'),
        allowedTools: ['mcp.files.read'], budget: new RunToolCallBudget(10),
    };
}

test('full schema, allowed-tools, scope and budgets reject calls before they reach the MCP server', async () => {
    const f = await fixture(); await f.host.initialize();
    try {
        const context = execution(), gateway = new ToolGateway(f.host.toolRegistry, new InMemoryToolCallStore());
        await expect(gateway.execute('mcp.files.read', { path: 'notes/a.md', extra: true }, context)).rejects.toThrow('additional properties');
        await expect(gateway.execute('mcp.files.read', { path: '' }, context)).rejects.toThrow();
        await expect(gateway.execute('mcp.files.read', { path: 'notes/a.md' }, { ...context, allowedTools: [] })).rejects.toThrow('not allowed');
        await expect(gateway.execute('mcp.files.read', { path: 'notes/a.md' }, { ...context, budget: new RunToolCallBudget(0) })).rejects.toThrow('limit');
        await expect(gateway.execute('mcp.files.read', { path: 'notes/a.md' }, { ...context, scope: { ...context.scope, chatId: 'foreign-chat' } })).rejects.toThrow('local manual');
        expect((await f.events()).filter(event => event.event === 'tools/call')).toHaveLength(0);
        expect(await gateway.execute('mcp.files.read', { path: 'notes/a.md', tag: null }, context)).toMatchObject({ structuredContent: { path: 'notes/a.md' } });
    } finally { await f.host.stop(); }
});

test('cancellation reaches the MCP transport and timeouts do not retry the selected tool', async () => {
    const f = await fixture({ delayMs: 1000 }); await f.host.initialize();
    try {
        const controller = new AbortController(), context = execution();
        const gateway = new ToolGateway(f.host.toolRegistry, new InMemoryToolCallStore());
        const pending = gateway.execute('mcp.files.read', { path: 'notes/a.md' }, { ...context, signal: controller.signal });
        const settled = pending.then((): null => null, (error: unknown) => error);
        const deadline = Date.now() + 2000;
        while (!(await f.events()).some(event => event.event === 'tools/call')) { if (Date.now() > deadline) throw new Error('MCP fixture never received the call'); await Bun.sleep(10); }
        controller.abort(); expect(await settled).toBeInstanceOf(Error);
        const cancelDeadline = Date.now() + 2000;
        while (!(await f.events()).some(event => event.event === 'notifications/cancelled')) { if (Date.now() > cancelDeadline) throw new Error('MCP fixture never received cancellation'); await Bun.sleep(10); }
    } finally { await f.host.stop(); }
    await f.exited();
    const timeout = await fixture({ delayMs: 1500, timeoutMs: 500 });
    try {
        const result = await timeout.host.runLocal('example.mcp.read', { prompt: 'notes/a.md' }, randomUUID());
        expect(result.execution!.run).toMatchObject({ status: 'failed', error: { code: 'MCP_TIMEOUT' } });
        expect((await timeout.events()).filter(event => event.event === 'tools/call')).toHaveLength(1);
    } finally { await timeout.host.stop(); }
});

test('passes only explicitly referenced credentials to the child environment', async () => {
    const original = { source: process.env.MCP_EXPLICIT_SOURCE, unrelated: process.env.MCP_UNRELATED_SECRET };
    process.env.MCP_EXPLICIT_SOURCE = 'dummy-visible'; process.env.MCP_UNRELATED_SECRET = 'dummy-hidden';
    const f = await fixture({ envRefs: { MCP_EXPLICIT_SECRET: 'env://MCP_EXPLICIT_SOURCE' } });
    try {
        await f.host.initialize();
        expect((await f.events())[0]).toMatchObject({ explicitSecret: 'dummy-visible' });
        expect((await f.events())[0].unrelatedSecret).toBeUndefined();
        const missing = await fixture({ envRefs: { TOKEN: `env://MCP_MISSING_${randomUUID().replaceAll('-', '').toUpperCase()}` } });
        try { await expect(missing.host.initialize()).rejects.toThrow('Secret is not configured'); }
        finally { await missing.host.stop(); }
        await expect(missing.events()).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        await f.host.stop();
        if (original.source === undefined) delete process.env.MCP_EXPLICIT_SOURCE; else process.env.MCP_EXPLICIT_SOURCE = original.source;
        if (original.unrelated === undefined) delete process.env.MCP_UNRELATED_SECRET; else process.env.MCP_UNRELATED_SECRET = original.unrelated;
    }
});

test('Host drains an in-flight MCP Run before closing the server', async () => {
    const f = await fixture({ delayMs: 100 });
    const pending = f.host.runLocal('example.mcp.read', { prompt: 'notes/a.md' }, randomUUID());
    const deadline = Date.now() + 2000;
    while (true) {
        const received = await f.events().catch((): never[] => []);
        if (received.some(event => event.event === 'tools/call')) break;
        if (Date.now() > deadline) throw new Error('MCP fixture never received the call');
        await Bun.sleep(10);
    }
    const stopping = f.host.stop();
    expect((await pending).execution!.run.status).toBe('succeeded');
    await stopping; await f.exited();
});
