import * as path from 'node:path';
import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { requirePersonalScope } from '@/knowledge/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { DocumentUploads, formats, MAX_DOCUMENT_BYTES } from './uploads';
import { runMarkItDown } from './process';

export const DOCUMENT_CAPABILITY = 'knowledge.document.convert';
const tool = 'document.convert.markitdown';
const configuration = z.object({ python: z.string().min(1).default(path.resolve('.data/markitdown/bin/python')) }).strict();
const inputSchema = z.object({ documentId: z.string().uuid() }).strict();
const schema = { type: 'object', required: ['documentId'], properties: { documentId: { type: 'string', format: 'uuid' } }, additionalProperties: false };
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.document-convert', name: '文档转 Markdown', version: '1.0.0', description: '使用 Microsoft MarkItDown 在本机转换 PDF、Word、PPT、Excel 和文本资料；不调用模型或 OCR。',
    runtime: { type: 'native' }, capabilities: [DOCUMENT_CAPABILITY], triggers: ['manual', 'agent'], inputSchema: schema, outputSchema: { type: 'object' },
    requirements: { tools: [tool], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 60, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['json', 'markdown'], directDelivery: false },
};
async function uploadedBody(request: Request) {
    if (Number(request.headers.get('content-length')) > MAX_DOCUMENT_BYTES) throw new Error('文件超过 10 MiB');
    if (!request.body || (request.headers.get('content-encoding') && request.headers.get('content-encoding') !== 'identity')) throw new Error('请上传原始文件内容');
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    const active = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const abort = () => { void reader.cancel().catch(() => {}); };
    active.addEventListener('abort', abort, { once: true });
    let size = 0;
    try {
        active.throwIfAborted();
        while (true) {
            const chunk = await reader.read(); active.throwIfAborted(); if (chunk.done) break;
            size += chunk.value.length; if (size > MAX_DOCUMENT_BYTES) throw new Error('文件超过 10 MiB'); chunks.push(chunk.value);
        }
        return Buffer.concat(chunks);
    } finally { active.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}

export const markItDownPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'community.markitdown', name: 'MarkItDown 文档导入', version: '1.0.0', description: manifest.description },
    Config: configuration, agents: [{ manifest, installationId: 'install-document-convert' }],
    checks: [{ id: 'community.markitdown.result', title: '文档转换与来源凭证', version: '1.0.0', agentId: manifest.id, capability: DOCUMENT_CAPABILITY,
        artifacts: [{ id: 'document', type: 'json', schema: { type: 'object', required: ['mediaType', 'metadata', 'content'], properties: {
            mediaType: { const: 'application/json' }, metadata: { type: 'object', required: ['privateKnowledge'], properties: { privateKnowledge: { const: true } } },
            content: { type: 'object', required: ['markdown', 'version', 'source', 'convertedAt'], properties: {
            markdown: { type: 'string', minLength: 1 }, version: { const: '0.1.9' }, convertedAt: { type: 'string', format: 'date-time' }, source: { type: 'object', required: ['name', 'size', 'sha256'], properties: {
                name: { type: 'string', minLength: 1 }, size: { type: 'integer', minimum: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            } },
        } } } } }, { id: 'markdown', type: 'markdown', schema: { type: 'object', required: ['mediaType', 'metadata', 'content'], properties: {
            mediaType: { const: 'text/markdown' }, content: { type: 'string', minLength: 1 }, metadata: { type: 'object', required: ['privateKnowledge'], properties: { privateKnowledge: { const: true } } },
        } } }], steps: [{ id: 'convert', kind: 'tool', name: tool }],
    }],
    apply(ctx, value) {
        const config = configuration.parse(value);
        const uploads = new DocumentUploads(path.join(ctx.delivery.getContext().config.data_path, 'document-uploads'));
        ctx.delivery.web.register({ id: 'community.markitdown', pages: [{ path: '/documents', label: '文档导入', section: 'workspace', view: { kind: 'builtin', id: 'documents', capability: DOCUMENT_CAPABILITY } }],
            api: { prefix: '/api/documents', routes: [{ method: 'GET', path: '/api/documents/status' }, { method: 'POST', path: '/api/documents/uploads' }],
                async handle(request) {
                    const pathname = new URL(request.url).pathname;
                    if (request.method === 'GET' && pathname === '/api/documents/status') {
                        try { const probe = await runMarkItDown(config.python); return Response.json({ available: true, version: probe.version, formats }); }
                        catch { return Response.json({ available: false, formats }); }
                    }
                    if (request.method === 'POST' && pathname === '/api/documents/uploads') {
                        try {
                            const name = decodeURIComponent(request.headers.get('x-document-name') || '');
                            const saved = await uploads.save(name, await uploadedBody(request));
                            return Response.json({ documentId: saved.id, name: saved.name, size: saved.size, sha256: saved.sha256 }, { status: 201 });
                        } catch { return Response.json({ error: '上传失败，请选择 10 MiB 以内的受支持文件，并检查本地暂存目录' }, { status: 400 }); }
                    }
                    return Response.json({ error: '当前插件未提供此接口' }, { status: 404 });
                },
            },
        });
        ctx.delivery.tools.register({ id: tool, version: '1.0.0', description: 'Convert one previously uploaded document in the current local workspace using pinned MarkItDown. Accepts an opaque upload ID, never a file path or remote URL; consumes the temporary upload.', inputSchema: schema, outputSchema: { type: 'object' }, sideEffect: 'write', riskLevel: 'low', idempotent: true, timeoutSeconds: 50 }, async (input, execution) => {
            requirePersonalScope(execution.scope);
            const { documentId } = inputSchema.parse(input);
            const document = await uploads.load(documentId, execution.scope);
            try {
                const output = await runMarkItDown(config.python, document.bytes, document.metadata.extension, execution.signal);
                if (!('markdown' in output)) throw new Error('文档转换没有返回正文');
                const convertedAt = new Date().toISOString();
                const name = document.metadata.name.replace(/[&<>\\`*_[\]{}()#!|]/g, character => `&#${character.charCodeAt(0)};`);
                const markdown = [`# ${name}`, '', `来源文件：${name}`, `原文件 SHA-256：${document.metadata.sha256}`, `转换时间：${convertedAt}`, `转换引擎：MarkItDown ${output.version}`, '', '---', '', output.markdown].join('\n');
                return { ...output, markdown, source: { name: document.metadata.name, size: document.metadata.size, sha256: document.metadata.sha256 }, convertedAt };
            } finally { await uploads.remove(documentId); }
        });
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope);
            const input = inputSchema.parse(request.input);
            const output = await ctx.delivery.toolGateway.execute(tool, input, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal,
                allowedTools: manifest.requirements.tools, budget: new RunToolCallBudget(1), idempotencyKey: `${request.runId}:convert` }) as { markdown: string; version: string; source: { name: string; size: number; sha256: string }; convertedAt: string };
            return { status: 'succeeded', data: output, metrics: { modelCalls: 0, toolCalls: 1 }, artifacts: [
                { type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: output, metadata: { privateKnowledge: true, title: '文档来源', statusPanels: [{ schemaVersion: '1.0', tone: 'neutral', title: '文档已转换', description: '转换在本机完成；可下载 Markdown 后放入你的知识目录。原始上传已从暂存区移除，转换结果保留在运行记录。', checkedAt: output.convertedAt,
                    items: [{ label: output.source.name, value: `${output.source.size} 字节` }, { label: '原文件 SHA-256', value: output.source.sha256 }, { label: '转换引擎', value: `MarkItDown ${output.version}` }] }] } },
                { type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: output.markdown, metadata: { title: output.source.name, privateKnowledge: true } },
            ] };
        });
    },
};
export default markItDownPlugin;
