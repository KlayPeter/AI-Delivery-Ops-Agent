import { KNOWLEDGE_WEB_VERSIONS_TOOL } from '../web/plugin';
import { createKnowledgeImpactPlugin } from './plugin';

export const knowledgeWebImpactPlugin = createKnowledgeImpactPlugin({ pluginId: 'knowledge.web', versionsTool: KNOWLEDGE_WEB_VERSIONS_TOOL, kind: 'web' });
export default knowledgeWebImpactPlugin;
