import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { EnvironmentSecretResolver } from '@/platform/secrets/resolver';
import { requirePersonalScope } from '@/knowledge/scope';
import type { JsonSchema } from '@/platform/agents/contracts';
import { createMcpHttpFetch, mcpHttpEndpoint, type McpHttpNetwork } from './http';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const secretRef = z.string().regex(/^env:\/\/[A-Z][A-Z0-9_]*$/);
const serverFields = {
    id: identifier,
    tools: z.array(z.object({
        alias: identifier, name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), description: z.string().trim().min(1).max(2000),
        readOnly: z.literal(true),
    }).strict()).min(1).max(50),
    timeoutMs: z.number().int().min(100).max(30000).default(10000),
    maxOutputBytes: z.number().int().min(1024).max(1024 * 1024).default(256 * 1024),
};
export const mcpConfig = z.object({
    servers: z.array(z.union([z.object({ ...serverFields,
        transport: z.literal('stdio').default('stdio'),
        command: z.string().trim().min(1).max(4096), args: z.array(z.string().max(4096)).max(100).default([]),
        cwd: z.string().min(1).max(4096).optional(),
        envRefs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), secretRef).default({}),
    }).strict(), z.object({ ...serverFields, transport: z.literal('http'),
        url: z.string().max(1024).refine(value => { try { mcpHttpEndpoint(value); return true; } catch { return false; } }, 'Use a public HTTPS MCP endpoint without credentials, query or fragment'),
        tokenRef: secretRef.optional(),
    }).strict()])).min(1).max(10),
}).strict().superRefine(({ servers }, context) => {
    if (new Set(servers.map(server => server.id)).size !== servers.length) context.addIssue({ code: 'custom', message: 'Duplicate MCP server id' });
    for (const server of servers) if (new Set(server.tools.map(tool => tool.alias)).size !== server.tools.length) context.addIssue({ code: 'custom', message: `Duplicate MCP tool alias: ${server.id}` });
});

const failure = (code: string, message: string, retryable = false) => Object.assign(new Error(message), { code, retryable });

export const createMcpPlugin = (httpNetwork?: McpHttpNetwork): FeaturePlugin => ({
    manifest: { apiVersion: '1.0', id: 'connector.mcp', name: 'MCP tools', version: '1.1.0',
        description: 'Connect reviewed stdio or public HTTPS MCP servers and expose explicitly selected read tools through the Tool Gateway.' },
    Config: mcpConfig,
    async apply(ctx, value) {
        const config = mcpConfig.parse(value), secrets = new EnvironmentSecretResolver();
        for (const server of config.servers) {
            const client = new Client({ name: 'delivery-ops-agent', version: '1.0.0' }, {
                listMaxPages: 8, jsonSchemaValidator: { getValidator: schema => new AjvJsonSchemaValidator().getValidator(schema) },
            });
            let transport: StdioClientTransport | StreamableHTTPClientTransport;
            if (server.transport === 'stdio') {
                const env: Record<string, string> = {};
                for (const [name, reference] of Object.entries(server.envRefs)) env[name] = await secrets.resolve(reference);
                transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env,
                    stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 });
            } else {
                const token = server.tokenRef ? await secrets.resolve(server.tokenRef) : undefined;
                transport = new StreamableHTTPClientTransport(mcpHttpEndpoint(server.url), {
                    fetch: createMcpHttpFetch(server.url, server.timeoutMs, httpNetwork),
                    requestInit: { redirect: 'error', headers: token ? { authorization: `Bearer ${token}` } : {} },
                });
            }
            // The SDK starts teardown without awaiting it after a failed handshake.
            const close = transport.close.bind(transport);
            let closing: Promise<void> | undefined;
            transport.close = () => closing ??= (async () => {
                // Remote session termination is best effort; local streams must always close.
                if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession().catch(() => {});
                await close();
            })();
            ctx.effect(() => async () => { await client.close(); await transport.close(); });
            const signal = AbortSignal.timeout(server.timeoutMs);
            let tools;
            try {
                await client.connect(transport, { signal, timeout: server.timeoutMs });
                tools = (await client.listTools(undefined, { signal, timeout: server.timeoutMs })).tools;
            } catch {
                throw failure('MCP_CONNECTION_FAILED', `MCP initialization failed: ${server.id}`);
            }
            if (tools.length > 200 || new Set(tools.map(tool => tool.name)).size !== tools.length) throw failure('MCP_INVALID_CATALOG', `MCP tool catalog is too large or has duplicate names: ${server.id}`);
            for (const binding of server.tools) {
                const tool = tools.find(tool => tool.name === binding.name);
                if (!tool) throw failure('MCP_TOOL_NOT_FOUND', `Selected MCP tool is missing: ${server.id}/${binding.name}`);
                if (tool.execution?.taskSupport === 'required') throw failure('MCP_TASK_NOT_SUPPORTED', `MCP task-only tool is not supported: ${server.id}/${binding.name}`);
                const inputSchema = tool.inputSchema as JsonSchema;
                try {
                    new AjvJsonSchemaValidator().getValidator(inputSchema);
                    if (tool.outputSchema) new AjvJsonSchemaValidator().getValidator(tool.outputSchema as JsonSchema);
                } catch { throw failure('MCP_INVALID_SCHEMA', `Selected MCP tool has an invalid or unsupported schema: ${server.id}/${binding.name}`); }
                const toolId = `mcp.${server.id}.${binding.alias}`;
                ctx.delivery.tools.register({
                    id: toolId, version: '1.0.0', description: binding.description,
                    inputSchema, outputSchema: { type: 'object' },
                    sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: Math.ceil(server.timeoutMs / 1000) + 1,
                }, async (input, execution) => {
                    requirePersonalScope(execution.scope);
                    execution.signal.throwIfAborted();
                    if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw failure('INVALID_MCP_INPUT', `MCP input exceeds 32 KiB: ${toolId}`);
                    const active = AbortSignal.any([execution.signal, AbortSignal.timeout(server.timeoutMs)]);
                    let result;
                    try {
                        result = await client.callTool({ name: binding.name, arguments: input as Record<string, unknown> }, {
                            signal: active, timeout: server.timeoutMs + 100, toolDefinition: tool,
                        });
                    } catch {
                        if (execution.signal.aborted) throw execution.signal.reason;
                        if (active.aborted) throw failure('MCP_TIMEOUT', `MCP tool timed out: ${toolId}`, true);
                        throw failure('MCP_REQUEST_FAILED', `MCP tool request failed: ${toolId}`);
                    }
                    active.throwIfAborted();
                    if (result.isError) throw failure('MCP_TOOL_FAILED', `MCP tool returned an error: ${toolId}`);
                    if (Buffer.byteLength(JSON.stringify(result)) > server.maxOutputBytes) throw failure('MCP_OUTPUT_TOO_LARGE', `MCP tool output exceeds the configured limit: ${toolId}`);
                    return result;
                });
            }
        }
    },
});

export const mcpPlugin = createMcpPlugin();
export default mcpPlugin;
