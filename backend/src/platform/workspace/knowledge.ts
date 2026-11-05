import { standardModelPlugins } from '@/platform/models/providers';
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
import { createKnowledgeWorkspacePlugin } from '@/knowledge/workspace/plugin';
import { webCapturePlugin } from '@/knowledge/capture/plugin';
import { markItDownPlugin } from '@/connectors/markitdown/plugin';
import { knowledgeLibraryPlugin } from '@/knowledge/library/plugin';
import { libraryRoot } from '@/knowledge/library/service';
import { buildConfig } from '@/core/config';
import { pluginChecksPlugin } from '@/quality/plugin';
import { mcpSetupPlugin } from '@/connectors/mcp-workbench/plugin';
import { createPersonalResearchPlugin } from '@/agents/personal-research/plugin';
import { runRecipesPlugin } from '@/recipes/plugin';

export function workspaceKnowledge(dataPath = buildConfig({}).data_path) {
    const kind = process.env.KNOWLEDGE_KIND || 'sample';
    const selected = kind === 'web' ? {
        plugins: [...standardModelPlugins, knowledgeWebPlugin, knowledgeWebAnswerPlugin, knowledgeWebImpactPlugin, createKnowledgeWorkspacePlugin('web'), webCapturePlugin, markItDownPlugin, knowledgeLibraryPlugin, pluginChecksPlugin, mcpSetupPlugin, createPersonalResearchPlugin('web'), runRecipesPlugin],
        config: { 'knowledge.web': webSourceConfig.parse({ urls: lines(process.env.KNOWLEDGE_URLS || ''), sourceId: 'workspace-web' }) },
    } : {
        plugins: [...standardModelPlugins, knowledgeMarkdownPlugin, knowledgeAnswerPlugin, knowledgeImpactPlugin, createKnowledgeWorkspacePlugin(kind === 'sample' ? 'sample' : kind === 'library' ? 'library' : 'markdown'), webCapturePlugin, markItDownPlugin, knowledgeLibraryPlugin, pluginChecksPlugin, mcpSetupPlugin, createPersonalResearchPlugin(), runRecipesPlugin],
        config: { 'knowledge.markdown': markdownSourceConfig.parse({
            root: kind === 'sample' ? path.join(import.meta.dir, '../../../examples/knowledge-vault') : kind === 'library' ? libraryRoot(dataPath) : process.env.KNOWLEDGE_ROOT,
            sourceId: kind === 'sample' ? 'workspace-sample' : kind === 'library' ? 'workspace-library' : 'workspace-notes',
            vaultName: kind === 'library' ? undefined : process.env.KNOWLEDGE_VAULT_NAME || undefined,
            exclude: kind === 'library' ? [] : lines(process.env.KNOWLEDGE_EXCLUDE || ''),
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
