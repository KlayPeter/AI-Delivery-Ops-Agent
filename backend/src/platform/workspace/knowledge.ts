import * as path from 'node:path';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { knowledgeAnswerPlugin } from '@/knowledge/answer/plugin';
import { knowledgeWebPlugin } from '@/knowledge/web/plugin';
import { knowledgeWebAnswerPlugin } from '@/knowledge/web/answerPlugin';
import { markdownSourceConfig } from '@/knowledge/markdown/source';
import { webSourceConfig } from '@/knowledge/web/source';
import { lines } from './connections';

export function workspaceKnowledge() {
    const kind = process.env.KNOWLEDGE_KIND || 'sample';
    if (kind === 'web') return {
        plugins: [knowledgeWebPlugin, knowledgeWebAnswerPlugin],
        config: { 'knowledge.web': webSourceConfig.parse({ urls: lines(process.env.KNOWLEDGE_URLS || ''), sourceId: 'workspace-web' }) },
    };
    return {
        plugins: [knowledgeMarkdownPlugin, knowledgeAnswerPlugin],
        config: { 'knowledge.markdown': markdownSourceConfig.parse({
            root: kind === 'sample' ? path.join(import.meta.dir, '../../../examples/knowledge-vault') : process.env.KNOWLEDGE_ROOT,
            sourceId: kind === 'sample' ? 'workspace-sample' : 'workspace-notes',
            vaultName: process.env.KNOWLEDGE_VAULT_NAME || undefined,
            exclude: lines(process.env.KNOWLEDGE_EXCLUDE || ''),
        }) },
    };
}
