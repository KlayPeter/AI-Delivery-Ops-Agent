import { z } from 'zod';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { requirePersonalScope, requirePersonalVersionScope } from '../scope';
import { knowledgeSearchInput } from '../search';
import { fetchPublicPage } from './network';
import { WebKnowledgeSource, webSourceConfig } from './source';
import { versionRequest } from '../versions';

export const KNOWLEDGE_WEB_CAPABILITY = 'knowledge.web.retrieve';
export const KNOWLEDGE_WEB_SEARCH_TOOL = 'knowledge.web.search';
export const KNOWLEDGE_WEB_VERSIONS_TOOL = 'knowledge.web.versions';
export const knowledgeWebManifest: AgentManifest = {
    schemaVersion: '1.1', id: 'native.knowledge-web', name: 'Public web knowledge', version: '1.0.0',
    description: 'Read configured public pages with bounded network access and return versioned keyword evidence; no crawling or generation.',
    runtime: { type: 'native' }, capabilities: [KNOWLEDGE_WEB_CAPABILITY], triggers: ['manual', 'agent'],
    inputSchema: { type: 'object', required: ['operation'], properties: { operation: { type: 'string', enum: ['sync', 'search'] }, query: { type: 'string' }, limit: { type: 'integer' } } },
    outputSchema: { type: 'object' }, requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 60, maxSteps: 1, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 512 * 1024 },
    delivery: { allowedArtifactTypes: ['json'], directDelivery: false },
};

export function createKnowledgeWebPlugin(loadPage: typeof fetchPublicPage = fetchPublicPage): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'knowledge.web', name: 'Public web knowledge', version: '1.1.0', description: knowledgeWebManifest.description },
        Config: webSourceConfig,
        agents: [{ manifest: knowledgeWebManifest, installationId: 'install-knowledge-web' }],
        apply(ctx, config) {
            const source = new WebKnowledgeSource(webSourceConfig.parse(config), loadPage);
            ctx.delivery.tools.register({
                id: KNOWLEDGE_WEB_VERSIONS_TOOL, version: '1.1.0', description: 'Check supplied version references using only configured public URLs. Returns document status, not page bodies; an unreadable page is unavailable, not proven deleted.',
                inputSchema: { type: 'object', required: ['documents'], properties: { documents: { type: 'array' } } }, outputSchema: { type: 'object' },
                sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 45,
            }, async (input, execution) => {
                requirePersonalVersionScope(execution.scope);
                return source.versions(versionRequest.parse(input), execution.signal);
            });
            ctx.delivery.tools.register({
                id: KNOWLEDGE_WEB_SEARCH_TOOL, version: '1.0.0', description: 'Refresh and search only configured public pages. Returns untrusted excerpts, original URLs and content versions; line numbers refer to extracted text.',
                inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } },
                outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 45,
            }, async (input, execution) => {
                requirePersonalScope(execution.scope);
                const search = knowledgeSearchInput.parse(input);
                return source.search(search.query, search.limit, execution.signal);
            });
            ctx.delivery.nativeAgents.register(knowledgeWebManifest.id, knowledgeWebManifest.version, async (request, _resolved, signal) => {
                requirePersonalScope(request.scope);
                const input = z.object({ operation: z.enum(['sync', 'search']), query: z.string().optional(), limit: z.number().optional() }).strict().parse(request.input);
                const search = input.operation === 'search' ? knowledgeSearchInput.parse({ query: input.query, limit: input.limit }) : undefined;
                const data = search ? await source.search(search.query, search.limit, signal) : await source.sync(signal);
                return { status: 'succeeded', data, artifacts: [{ type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: data,
                    metadata: { sourceId: source.config.sourceId, retrieval: 'keyword', privateKnowledge: true } }] };
            });
        },
    };
}

export const knowledgeWebPlugin = createKnowledgeWebPlugin();
export default knowledgeWebPlugin;
