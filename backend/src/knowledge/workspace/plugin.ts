import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { KNOWLEDGE_MARKDOWN_CAPABILITY } from '@/knowledge/markdown/plugin';
import { KNOWLEDGE_WEB_CAPABILITY } from '@/knowledge/web/plugin';

export function createKnowledgeWorkspacePlugin(kind: 'sample' | 'markdown' | 'web' | 'library' = 'markdown'): FeaturePlugin {
    const sourceKind = z.enum(['sample', 'markdown', 'web', 'library']).parse(kind);
    const source = Object.freeze({ kind: sourceKind, pluginId: sourceKind === 'web' ? 'knowledge.web' : 'knowledge.markdown',
        capability: sourceKind === 'web' ? KNOWLEDGE_WEB_CAPABILITY : KNOWLEDGE_MARKDOWN_CAPABILITY });
    return {
        manifest: { apiVersion: '1.0', id: 'knowledge.workspace', name: 'Personal knowledge workspace', version: '1.0.0',
            description: 'Local knowledge search and source settings for one explicitly selected knowledge plugin.', requires: [source.pluginId, ...(sourceKind === 'library' ? ['knowledge.library'] : [])] },
        apply(ctx) {
            ctx.delivery.web.register({ id: 'knowledge.workspace',
                pages: [{ path: '/knowledge', label: '知识库', section: 'workspace', view: { kind: 'builtin', id: 'knowledge' } }],
                api: { prefix: '/api/knowledge-workspace', routes: [{ method: 'GET', path: '/api/knowledge-workspace' }],
                    handle: request => request.method === 'GET' && new URL(request.url).pathname === '/api/knowledge-workspace'
                        ? Response.json(source) : Response.json({ error: '当前插件未提供此接口' }, { status: 404 }),
                },
            });
        },
    };
}

export const knowledgeWorkspacePlugin = createKnowledgeWorkspacePlugin();
export default knowledgeWorkspacePlugin;
