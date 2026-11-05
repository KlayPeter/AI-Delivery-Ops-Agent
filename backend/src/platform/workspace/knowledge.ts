import * as path from 'node:path';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { knowledgeAnswerPlugin } from '@/knowledge/answer/plugin';
import { knowledgeWebPlugin } from '@/knowledge/web/plugin';
import { knowledgeWebAnswerPlugin } from '@/knowledge/web/answerPlugin';
import { markdownSourceConfig } from '@/knowledge/markdown/source';
import { webSourceConfig } from '@/knowledge/web/source';
import { lines } from './connections';
import { knowledgeImpactPlugin } from '@/knowledge/impact/plugin';
import { knowledgeWebImpactPlugin } from '@/knowledge/impact/webPlugin';
import { githubPlugin } from '@/connectors/github/plugin';
import { githubConfig } from '@/connectors/github/source';
import { releasePlugin } from '@/domains/release/plugin';
import { webReleasePlugin } from '@/domains/release/webPlugin';

export function workspaceKnowledge() {
    const kind = process.env.KNOWLEDGE_KIND || 'sample';
    const selected = kind === 'web' ? {
        plugins: [knowledgeWebPlugin, knowledgeWebAnswerPlugin, knowledgeWebImpactPlugin],
        config: { 'knowledge.web': webSourceConfig.parse({ urls: lines(process.env.KNOWLEDGE_URLS || ''), sourceId: 'workspace-web' }) },
    } : {
        plugins: [knowledgeMarkdownPlugin, knowledgeAnswerPlugin, knowledgeImpactPlugin],
        config: { 'knowledge.markdown': markdownSourceConfig.parse({
            root: kind === 'sample' ? path.join(import.meta.dir, '../../../examples/knowledge-vault') : process.env.KNOWLEDGE_ROOT,
            sourceId: kind === 'sample' ? 'workspace-sample' : 'workspace-notes',
            vaultName: process.env.KNOWLEDGE_VAULT_NAME || undefined,
            exclude: lines(process.env.KNOWLEDGE_EXCLUDE || ''),
        }) },
    };
    if (!process.env.RELEASE_GITHUB_REPOSITORY) return selected;
    return {
        plugins: [...selected.plugins, githubPlugin, kind === 'web' ? webReleasePlugin : releasePlugin],
        config: { ...selected.config, 'connector.github': githubConfig.parse({
            repository: process.env.RELEASE_GITHUB_REPOSITORY,
            baseBranch: process.env.RELEASE_GITHUB_BRANCH || undefined,
            tokenRef: process.env.RELEASE_GITHUB_TOKEN ? 'env://RELEASE_GITHUB_TOKEN' : undefined,
        }) },
    };
}
