import { afterEach, expect, test } from 'bun:test';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { buildConfig } from '@/core/config';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { standardModelPlugins } from '@/platform/models/providers';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { knowledgeAnswerPlugin } from '@/knowledge/answer/plugin';
import { knowledgeImpactPlugin } from '@/knowledge/impact/plugin';
import { webCapturePlugin } from '@/knowledge/capture/plugin';
import { createPersonalResearchPlugin } from '@/agents/personal-research/plugin';
import { createResearchRequests } from '@/agents/personal-research/externalRequests';
import { createMcpPlugin } from '@/connectors/mcp/plugin';
import { mcpRunnerPlugin } from '@/connectors/mcp-workbench/runner';
import { createOpenApiConnectorPlugin } from '@/connectors/openapi/plugin';
import type { McpHttpNetwork } from '@/connectors/mcp/http';
import type { WebTransport } from '@/knowledge/web/network';
import { RunCheckService } from '@/quality/service';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
type Mode = 'mixed' | 'knowledge' | 'pause' | 'alter' | 'plain';
async function fixture(mode: Mode = 'mixed') {
    const root = await mkdtemp(path.join(tmpdir(), 'research-requests-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    await writeFile(path.join(root, 'vault/Migration.md'), '# Migration\nPRIVATE_SOURCE: API migration requires an explicit checklist.');
    const modelRequests: any[] = [], remoteCalls: any[] = []; let modelCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (new URL(request.url).pathname === '/mcp') {
            if (request.method === 'GET') return new Response(null, { status: 405 });
            if (request.method === 'DELETE') return new Response(null, { status: 204 });
            const message = await request.json() as any;
            if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });
            let result;
            if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'research fixture', version: '1.0.0' } };
            else if (message.method === 'tools/list') result = { tools: ['read', 'extra'].map(name => ({ name, inputSchema: { type: 'object', required: ['library'], properties: { library: { type: 'string' } }, additionalProperties: false } })) };
            else { remoteCalls.push(message.params); result = { content: [{ type: 'text', text: 'PUBLIC_MCP: React documentation candidate' }] }; }
            return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: message.method === 'initialize' ? { 'mcp-session-id': 'research-fixture' } : {} });
        }
        if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response(null, { status: 404 });
        const body = await request.json() as any; modelRequests.push(body); modelCalls++;
        expect(body.tools.every((tool: any) => tool.function.parameters.type === 'object')).toBe(true);
        const constant = (name: string) => body.tools?.find((tool: any) => tool.function.name === name)?.function.parameters.allOf[1].oneOf[0].const;
        const choose = (name: string, args: unknown) => [{ id: 'call-' + modelCalls, type: 'function', function: { name, arguments: JSON.stringify(args) } }];
        let toolCalls: unknown[] | undefined;
        if (mode === 'mixed' && modelCalls === 1) toolCalls = choose('agent_mcp_tools_run', constant('agent_mcp_tools_run'));
        else if (mode === 'mixed' && modelCalls === 2) toolCalls = choose('agent_openapi_tools_run', constant('agent_openapi_tools_run'));
        else if ((mode === 'mixed' && modelCalls === 3) || (mode === 'knowledge' && modelCalls === 1)) toolCalls = choose('agent_knowledge_markdown_retrieve', { operation: 'search', query: 'API migration', limit: 5 });
        else if (mode === 'pause' && modelCalls === 1) toolCalls = choose('request_human_input', { question: '请确认整理方式', fields: ['format'] });
        else if (mode === 'pause' && modelCalls === 2) toolCalls = choose('agent_mcp_tools_run', constant('agent_mcp_tools_run'));
        else if (mode === 'alter' && modelCalls === 1) toolCalls = choose('agent_mcp_tools_run', { ...constant('agent_mcp_tools_run'), arguments: { library: 'PRIVATE_SOURCE' } });
        return Response.json({ id: 'chatcmpl-' + modelCalls, object: 'chat.completion', created: 0, model: 'research-request-fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : '模型整理：受控协议样例，请核对保存的子任务资料。', ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    } });
    cleanup.push(() => server.stop(true));
    const mcpNetwork: McpHttpNetwork = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], request: (options, callback) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.port }, callback) };
    const apiNetwork: WebTransport = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], async request(url) { remoteCalls.push({ url: url.href }); return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"temperature":18}') }; } };
    const store = new InMemoryPersistentKeyValueStore();
    const config = { ...buildConfig({}), data_path: path.join(root, 'data'), ai: { provider: 'openai-compatible', model: 'research-request-fixture', api_key: 'local-fixture-key', api_base: `${server.url}v1` } };
    const createHost = (endpoint = 'https://mcp.fixture.example/mcp') => {
        const host = new AgentHost(() => ({ config, store, feishu: {}, tapd: {} } as any), 1000, undefined, [], {
            plugins: [...standardModelPlugins, createPersonalResearchPlugin(), knowledgeMarkdownPlugin, knowledgeAnswerPlugin, knowledgeImpactPlugin, webCapturePlugin, createMcpPlugin(mcpNetwork), mcpRunnerPlugin, createOpenApiConnectorPlugin(apiNetwork)],
            pluginConfig: {
                'knowledge.markdown': { root: path.join(root, 'vault'), sourceId: 'research-vault' },
                'connector.mcp': { servers: [{ id: 'docs', transport: 'http', url: endpoint, tools: ['read', 'extra'].map(name => ({ alias: name, name, description: 'Reviewed read tool', readOnly: true })) }] },
                'mcp.runner': { allowedTools: ['mcp.docs.read'] },
                'connector.openapi': { serviceId: 'weather', reviewedReadOnly: true, source: { url: 'https://spec.fixture.example/openapi.json', sha256: 'c'.repeat(64), openapi: '3.1.0', title: 'Weather fixture' }, operations: [{ key: 'GET /weather', alias: 'read', method: 'GET', path: '/weather', summary: 'Read weather', serverUrl: 'https://api.fixture.example', parameters: [{ name: 'city', in: 'query', required: true, explode: true, description: 'City', schema: { type: 'string' } }] }] },
            },
        });
        cleanup.push(() => host.stop()); return host;
    };
    const host = createHost(); await host.initialize();
    const catalogue = async (target = host) => (await (await target.web.handle(new Request('http://localhost/api/research/tools'))).json() as any).tools as any[];
    const entries = await catalogue();
    const selected = entries.map(tool => ({ toolId: tool.id, contractSha256: tool.contractSha256, arguments: tool.capability === 'mcp.tools.run' ? { library: 'React' } : { query: { city: 'Berlin' } } }));
    return { host, createHost, catalogue, selected, store, modelRequests, remoteCalls,
        call: (extra: Record<string, unknown> = { externalRequests: selected, confirmedExternalRequests: true }) => host.runLocal('personal.research', { prompt: 'Research API migration with the fixed public requests', ...extra }, randomUUID()) };
}

test('real model SDK delegates approved MCP and OpenAPI calls alongside private knowledge and records only actual evidence', async () => {
    const f = await fixture(), result = await f.call();
    expect(result.execution?.run.error).toBeUndefined();
    expect(result.execution?.run.status).toBe('succeeded');
    const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
    expect(details.children.map(child => child.capability).sort()).toEqual(['mcp.tools.run', 'openapi.tools.run', 'knowledge.markdown.retrieve'].sort());
    expect(f.remoteCalls).toEqual([{ name: 'read', arguments: { library: 'React' } }, { url: 'https://api.fixture.example/weather?city=Berlin' }]);
    expect(JSON.stringify(f.remoteCalls)).not.toContain('PRIVATE_SOURCE');
    for (const child of details.children.filter(child => child.capability !== 'knowledge.markdown.retrieve')) expect((await f.host.getLocalRunDetails(child.id))?.steps.map(step => step.kind).sort()).toEqual(['agent', 'tool', 'tool']);
    const approval = details.artifacts.find(artifact => artifact.metadata.artifactRole === 'personal.research.requests')!;
    expect(approval.metadata).toMatchObject({ privateKnowledge: true, verification: 'recorded_not_executed' });
    expect(approval.metadata.statusPanels).toMatchObject([{ tone: 'neutral', title: '已记录本次固定请求' }]);
    expect((approval.content as any).bindings.map((item: any) => item.destination)).toEqual(['https://mcp.fixture.example/mcp', 'https://api.fixture.example']);
    const ledger = details.artifacts.find(artifact => artifact.metadata.artifactRole === 'personal.research.evidence')!;
    expect((ledger.content as any).evidence.map((item: any) => item.runId).sort()).toEqual(details.children.map(child => child.id).sort());
    expect((ledger.content as any).summaryVerification).toBe('not_verified');
    const check = await new RunCheckService(f.store, f.host.checks).check({ workspaceId: 'workspace-default', botInstanceId: 'bot-default' }, { contractId: 'personal.research.evidence', runId: details.run.id });
    expect(check.current.verdict).toBe('passed');
});

test('catalog is local, only lists current runner grants and disappears on teardown', async () => {
    const f = await fixture();
    expect((await f.catalogue()).map(tool => tool.id)).toEqual(['mcp.docs.read', 'openapi.weather.read']);
    const response = await f.host.web.handle(new Request('http://localhost/api/research/tools', { headers: { origin: 'https://external.example' } }));
    expect(response.status).toBe(403); expect(f.remoteCalls).toEqual([]);
    await f.host.stop(); expect((await f.host.web.handle(new Request('http://localhost/api/research/tools'))).status).toBe(404);
});

test('unselected tools stay absent from legacy research model calls', async () => {
    const f = await fixture('knowledge'), result = await f.call({});
    expect(result.execution?.run.status).toBe('succeeded'); expect(f.remoteCalls).toEqual([]);
    expect(f.modelRequests.every(body => !body.tools.some((tool: any) => ['agent_mcp_tools_run', 'agent_openapi_tools_run'].includes(tool.function.name)))).toBe(true);
});

test('unconfirmed, stale, ungranted, invalid, duplicate or oversized requests fail before any model or remote call', async () => {
    const f = await fixture();
    const selected = f.selected[0]!;
    for (const extra of [
        { externalRequests: [selected] },
        { externalRequests: [{ ...selected, contractSha256: '0'.repeat(64) }], confirmedExternalRequests: true },
        { externalRequests: [{ ...selected, toolId: 'mcp.docs.extra' }], confirmedExternalRequests: true },
        { externalRequests: [{ ...selected, arguments: { unknown: true } }], confirmedExternalRequests: true },
        { externalRequests: [selected, selected], confirmedExternalRequests: true },
        { externalRequests: [{ ...selected, arguments: { library: 'x'.repeat(32769) } }], confirmedExternalRequests: true },
    ]) expect((await f.call(extra)).execution?.run.status).toBe('failed');
    expect(f.modelRequests).toEqual([]); expect(f.remoteCalls).toEqual([]);
    const input = { prompt: 'agent cannot invent user confirmation', externalRequests: [selected], confirmedExternalRequests: true };
    const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'agent', triggerId: randomUUID() });
    expect((await f.host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), 'personal.research', input)).execution?.run.status).toBe('failed');
    expect(f.modelRequests).toEqual([]);
});

test('model cannot replace fixed parameters or count a recorded but unused request as evidence', async () => {
    for (const mode of ['alter', 'plain'] as const) {
        const f = await fixture(mode), result = await f.call();
        expect(result.execution?.run.status).toBe('failed'); expect(f.remoteCalls).toEqual([]);
        const details = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
        expect(details.artifacts.some(artifact => artifact.metadata.artifactRole === 'personal.research.requests')).toBe(true);
        expect(details.artifacts.some(artifact => artifact.metadata.artifactRole === 'personal.research.summary')).toBe(false);
    }
});

test('paused research restores its original approvals after Host restart and cannot add new ones', async () => {
    const f = await fixture('pause'), first = await f.call({ externalRequests: [f.selected[0]], confirmedExternalRequests: true });
    expect(first.execution?.run.status).toBe('waiting_human'); await f.host.stop();
    const restored = f.createHost(); await restored.initialize();
    const resumed = await restored.resumeLocal(first.execution!.run.id, { prompt: 'continue with concise format', text: 'continue with concise format' }, randomUUID());
    expect(resumed.execution?.run.error).toBeUndefined();
    expect(resumed.execution?.run.status).toBe('succeeded'); expect(resumed.execution?.run.id).toBe(first.execution!.run.id);
    expect(f.remoteCalls).toEqual([{ name: 'read', arguments: { library: 'React' } }]);
    const second = await fixture('pause'), waiting = await second.call({});
    expect(waiting.execution?.run.status).toBe('waiting_human');
    const rejected = await second.host.resumeLocal(waiting.execution!.run.id, { prompt: 'continue', externalRequests: [second.selected[0]], confirmedExternalRequests: true }, randomUUID());
    expect(rejected.execution?.run.status).toBe('failed'); expect(second.modelRequests).toHaveLength(1); expect(second.remoteCalls).toEqual([]);
});

test('changed endpoints and tampered approval artifacts reject continuation before model contact', async () => {
    const f = await fixture('pause'), first = await f.call({ externalRequests: [f.selected[0]], confirmedExternalRequests: true });
    await f.host.stop(); const changed = f.createHost('https://changed.fixture.example/mcp'); await changed.initialize();
    const rejected = await changed.resumeLocal(first.execution!.run.id, { prompt: 'continue' }, randomUUID());
    expect(rejected.execution?.run.status).toBe('failed'); expect(f.modelRequests).toHaveLength(1); expect(f.remoteCalls).toEqual([]);
    const second = await fixture('pause'), waiting = await second.call();
    const runs = new PersistentAgentRunStore(second.store), artifacts = await runs.listArtifacts(waiting.execution!.run.id);
    const approval = artifacts.find(artifact => artifact.metadata.artifactRole === 'personal.research.requests')!;
    await runs.saveArtifacts([{ ...approval, content: { requests: [], bindings: [] } }]);
    expect((await second.host.resumeLocal(waiting.execution!.run.id, { prompt: 'continue' }, randomUUID())).execution?.run.status).toBe('failed');
    expect(second.modelRequests).toHaveLength(1); expect(second.remoteCalls).toEqual([]);
});

test('legacy waiting runs cannot acquire new approval even when their model provider saved no model trace', async () => {
    const requests = createResearchRequests({} as any, {
        get: async () => ({ triggerType: 'manual' }), listArtifacts: async (): Promise<never[]> => [],
        listSteps: async () => [{ kind: 'agent', name: 'personal.research-agent', status: 'succeeded' }, { kind: 'agent', name: 'personal.research-agent', status: 'running' }],
    } as any);
    await expect(requests.prepare({ runId: 'old-waiting', input: { externalRequests: [{ toolId: 'mcp.docs.read', arguments: {}, contractSha256: 'a'.repeat(64) }], confirmedExternalRequests: true } } as any, new AbortController().signal)).rejects.toMatchObject({ code: 'RESEARCH_REQUESTS_NOT_APPROVED' });
});
