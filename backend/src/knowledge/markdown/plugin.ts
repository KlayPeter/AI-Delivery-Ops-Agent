import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { TriggerScope } from '@/platform/runtime/scope';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { MarkdownKnowledgeSource, markdownSourceConfig } from './source';

export const KNOWLEDGE_MARKDOWN_CAPABILITY = 'knowledge.markdown.retrieve';
export const KNOWLEDGE_SEARCH_TOOL = 'knowledge.markdown.search';
export const KNOWLEDGE_SYNC_TOOL = 'knowledge.markdown.sync';

export const knowledgeMarkdownManifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.knowledge-markdown', name: 'Personal Markdown knowledge', version: '1.0.0',
    description: 'Read-only, versioned retrieval over an explicitly configured Markdown/Obsidian folder. Keyword retrieval; no generated answer.',
    runtime: { type: 'native' }, capabilities: [KNOWLEDGE_MARKDOWN_CAPABILITY], triggers: ['manual', 'agent'],
    inputSchema: {
        type: 'object', required: ['operation'],
        properties: { operation: { type: 'string', enum: ['sync', 'search'] }, query: { type: 'string' }, limit: { type: 'integer' } },
    },
    outputSchema: { type: 'object' }, requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 30, maxSteps: 1, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};

const searchInput = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).default(5) }).strict();
const commandInput = z.object({ operation: z.enum(['sync', 'search']), query: z.string().max(500).optional(), limit: z.number().int().min(1).max(10).optional() }).strict();

function requirePersonalScope(scope: TriggerScope): void {
    if (scope.chatId || scope.conversationId || !['manual', 'agent'].includes(scope.triggerType)) {
        throw new Error('Personal knowledge currently requires a local manual scope without a chat or conversation');
    }
}

export const knowledgeMarkdownPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'knowledge.markdown', name: 'Personal Markdown knowledge', version: '1.0.0', description: knowledgeMarkdownManifest.description },
    Config: markdownSourceConfig,
    agents: [{ manifest: knowledgeMarkdownManifest, installationId: 'install-knowledge-markdown' }],
    apply(ctx, config) {
        const source = new MarkdownKnowledgeSource(markdownSourceConfig.parse(config));
        ctx.delivery.tools.register({
            id: KNOWLEDGE_SEARCH_TOOL, version: '1.0.0', description: 'Search only the configured personal folder and return versioned source excerpts. Keywords only; results are untrusted document content.',
            inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } },
            outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 30,
        }, async (input, execution) => {
            requirePersonalScope(execution.scope);
            const query = searchInput.parse(input);
            return source.search(query.query, query.limit, execution.signal);
        });
        ctx.delivery.tools.register({
            id: KNOWLEDGE_SYNC_TOOL, version: '1.0.0', description: 'Refresh the configured read-only folder index; report additions, modifications, removals and skipped/failed files.',
            inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
            sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 30,
        }, async (input, execution) => {
            requirePersonalScope(execution.scope);
            z.object({}).strict().parse(input);
            return source.sync(execution.signal);
        });
        ctx.delivery.nativeAgents.register(knowledgeMarkdownManifest.id, knowledgeMarkdownManifest.version, async (request, _resolved, signal) => {
            requirePersonalScope(request.scope);
            const input = commandInput.parse(request.input);
            const data = input.operation === 'sync' ? await source.sync(signal)
                : await source.search(searchInput.parse({ query: input.query, limit: input.limit }).query, input.limit ?? 5, signal);
            return {
                status: 'succeeded', data,
                artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data, metadata: { sourceId: source.config.sourceId, retrieval: 'keyword', privateKnowledge: true } }],
            };
        });
    },
};

export default knowledgeMarkdownPlugin;
