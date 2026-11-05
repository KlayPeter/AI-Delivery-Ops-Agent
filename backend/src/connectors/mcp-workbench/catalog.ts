import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { JsonSchema } from '@/platform/agents/contracts';
import { createMcpHttpFetch, mcpHttpEndpoint, type McpHttpNetwork } from '../mcp/http';
import { mcpConfig } from '../mcp/plugin';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const inspectInput = z.object({ serverId: identifier, url: z.string().max(1024).refine(value => {
    try { mcpHttpEndpoint(value); return true; } catch { return false; }
}, '请使用不含凭据、查询参数或片段的公开 HTTPS MCP 地址') }).strict();
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const profileInput = inspectInput.extend({ reviewedReadOnly: z.literal(true), tools: z.array(z.object({ name: toolName, alias: identifier }).strict()).min(1).max(50) }).strict();

export async function inspectMcp(value: unknown, signal: AbortSignal, network?: McpHttpNetwork) {
    const input = inspectInput.parse(value);
    signal.throwIfAborted();
    const active = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const client = new Client({ name: 'agent-mcp-inspector', version: '1.0.0' }, { listMaxPages: 8 });
    const transport = new StreamableHTTPClientTransport(mcpHttpEndpoint(input.url), {
        fetch: createMcpHttpFetch(input.url, 10_000, network), requestInit: { redirect: 'error' },
    });
    const close = transport.close.bind(transport);
    let closing: Promise<void> | undefined;
    transport.close = () => closing ??= (async () => { await transport.terminateSession().catch(() => {}); await close(); })();
    try {
        await client.connect(transport, { signal: active, timeout: 10_000 });
        const catalog = (await client.listTools(undefined, { signal: active, timeout: 10_000 })).tools;
        if (catalog.length > 200 || new Set(catalog.map(tool => tool.name)).size !== catalog.length || Buffer.byteLength(JSON.stringify(catalog)) > 512 * 1024) throw new Error('工具目录超过限制或存在重名；未生成部分授权列表');
        const aliases = new Set<string>();
        const tools = catalog.map(tool => {
            let alias = tool.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
            if (!/^[a-z]/.test(alias)) alias = `tool-${alias}`;
            const base = alias.slice(0, 58);
            alias = base;
            for (let suffix = 2; aliases.has(alias); suffix++) alias = `${base}-${suffix}`;
            aliases.add(alias);
            let issue: string | undefined;
            if (!toolName.safeParse(tool.name).success) issue = '工具名称不符合连接规范';
            else if (tool.execution?.taskSupport === 'required') issue = '暂不支持 task-only 工具';
            else if (Buffer.byteLength(JSON.stringify([tool.inputSchema, tool.outputSchema])) > 16 * 1024) issue = 'Schema 超过 16 KiB';
            else try {
                new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchema);
                if (tool.outputSchema) new AjvJsonSchemaValidator().getValidator(tool.outputSchema as JsonSchema);
            } catch { issue = 'Schema 无效或暂不支持'; }
            return { name: tool.name, alias, description: tool.description?.slice(0, 2000) || '', readOnlyHint: tool.annotations?.readOnlyHint === true,
                inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), ...(issue ? { issue } : {}) };
        });
        active.throwIfAborted();
        const server = client.getServerVersion();
        return { ...input, checkedAt: new Date().toISOString(), server: { name: server?.name.slice(0, 200) || '', version: server?.version.slice(0, 200) || '' }, tools };
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (active.aborted) throw new Error('MCP 工具发现超时');
        // Upstream errors may echo headers or endpoint data; keep them out of saved runs.
        throw new Error(error instanceof Error && /工具目录/.test(error.message) ? error.message : '无法发现 MCP 工具，请检查匿名访问、服务地址与协议兼容性');
    } finally { await client.close().catch(() => {}); await transport.close(); }
}

export function exportMcpProfile(value: unknown) {
    const input = profileInput.parse(value);
    if (new Set(input.tools.map(tool => tool.name)).size !== input.tools.length) throw new Error('不能重复选择同一工具');
    const config = mcpConfig.parse({ servers: [{ id: input.serverId, transport: 'http', url: input.url, tools: input.tools.map(tool => ({ ...tool, readOnly: true, description: `Reviewed MCP read tool: ${tool.name}` })) }] });
    const allowedTools = input.tools.map(tool => `mcp.${input.serverId}.${tool.alias}`);
    return { filename: `mcp-${input.serverId}.local.yaml`, yaml: '# Save under backend/examples/. Review read grants, then restart with AGENT_PLUGINS_FILE=examples/<filename> bun run dev\n' + stringify({ apiVersion: '1.0', plugins: [
        { module: '../src/connectors/mcp/plugin.ts', config },
        { module: '../src/connectors/mcp-workbench/runner.ts', config: { allowedTools } },
        { module: '../src/connectors/mcp-workbench/plugin.ts' },
    ] }) };
}

export async function profileRequest(request: Request) {
    if (!request.body || Number(request.headers.get('content-length')) > 16 * 1024) throw new Error('配置请求超过 16 KiB 或缺少正文');
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    const active = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const abort = () => { void reader.cancel().catch(() => {}); };
    active.addEventListener('abort', abort, { once: true });
    let bytes = 0;
    try {
        active.throwIfAborted();
        while (true) {
            const chunk = await reader.read(); active.throwIfAborted(); if (chunk.done) break;
            bytes += chunk.value.length; if (bytes > 16 * 1024) throw new Error('配置请求超过 16 KiB'); chunks.push(chunk.value);
        }
        return exportMcpProfile(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally { active.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
