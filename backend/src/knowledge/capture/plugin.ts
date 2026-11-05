import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';
import { fetchPublicPage, publicPageUrl } from '@/knowledge/web/network';
import { parsePage } from '@/knowledge/web/parser';
import { requirePersonalScope } from '@/knowledge/scope';
import { RunToolCallBudget } from '@/platform/tools/budget';

export const CAPTURE_CAPABILITY = 'knowledge.page.capture';
const tool = 'web.page.capture';
const inputSchema = z.object({ url: z.string().trim().min(1).max(1024).transform(value => publicPageUrl(value).href) }).strict();
const schema = { type: 'object', required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 1024 } }, additionalProperties: false };
const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.web-capture', name: '网页资料收集', version: '1.0.0', description: '把一篇公开网页转成带来源和内容版本的 Markdown；无需模型，不改写个人笔记。',
    runtime: { type: 'native' }, capabilities: [CAPTURE_CAPABILITY], triggers: ['manual', 'agent'], inputSchema: schema, outputSchema: { type: 'object' },
    requirements: { tools: [tool], secrets: [], networkHosts: [] }, limits: { timeoutSeconds: 30, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 2 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['json', 'markdown'], directDelivery: false },
};
const escape = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}()#!|]/g, '\\$&');

export function createWebCapturePlugin(loadPage = fetchPublicPage): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'knowledge.capture', name: '网页资料收集', version: '1.0.0', description: manifest.description },
        agents: [{ manifest, installationId: 'install-web-capture' }],
        apply(ctx) {
            ctx.delivery.web.register({ id: 'knowledge.capture', pages: [{ path: '/capture', label: '网页收集', section: 'workspace', view: { kind: 'builtin', id: 'web-capture', capability: CAPTURE_CAPABILITY } }] });
            ctx.delivery.tools.register({ id: tool, version: '1.0.0', description: 'Read one explicitly requested public webpage with bounded network access and extract its text; no crawling, model calls or private-network access.', inputSchema: schema, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 20 }, async (input, execution) => {
                requirePersonalScope(execution.scope);
                const { url } = inputSchema.parse(input);
                const page = await loadPage(url, 512 * 1024, 10_000, execution.signal);
                execution.signal?.throwIfAborted();
                const parsed = parsePage(url, page);
                if (Buffer.byteLength(parsed.text) > 256 * 1024) throw new Error('网页正文超过 256 KiB，请选择较短的单篇文章');
                return { url, finalUrl: page.url, title: parsed.note.title, text: parsed.text, rawVersion: parsed.rawVersion, documentVersion: parsed.note.version, mediaType: parsed.mediaType, extraction: parsed.extraction, fetchedAt: new Date().toISOString() };
            });
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope);
                const input = inputSchema.parse(request.input);
                const captured = await ctx.delivery.toolGateway.execute(tool, input, { runId: request.runId, agentId: manifest.id, scope: request.scope, signal,
                    allowedTools: manifest.requirements.tools, budget: new RunToolCallBudget(1), idempotencyKey: `${request.runId}:capture` }) as { url: string; finalUrl: string; title: string; text: string; documentVersion: string; rawVersion: string; fetchedAt: string; mediaType: string; extraction: string };
                const markdown = [`# ${escape(captured.title)}`, '', `来源：[原始网页](<${captured.url.replace(/>/g, '%3E')}>)`, `采集时间：${captured.fetchedAt}`, `内容版本：${captured.documentVersion}`, '', '---', '', captured.text, ''].join('\n');
                const data = { ...captured, markdown };
                return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: 1 }, artifacts: [
                    { type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { privateKnowledge: true, title: '网页来源', statusPanels: [{ schemaVersion: '1.0', tone: 'neutral', title: '网页正文已收集', description: '可下载 Markdown 后放入选定的知识目录。本次未调用模型，也未自动写入个人笔记。', checkedAt: captured.fetchedAt,
                        items: [{ label: captured.title, value: '单页正文提取' }, { label: '来源', value: new URL(captured.url).hostname, detail: captured.url }, { label: '内容版本', value: captured.documentVersion }] }] } },
                    { type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: markdown, metadata: { title: captured.title, privateKnowledge: true } },
                ] };
            });
        },
    };
}
export const webCapturePlugin = createWebCapturePlugin();
export default webCapturePlugin;
