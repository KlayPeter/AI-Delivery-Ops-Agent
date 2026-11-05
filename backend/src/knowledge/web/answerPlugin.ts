import { createKnowledgeAnswerPlugin } from '../answer/plugin';
import { KNOWLEDGE_WEB_SEARCH_TOOL } from './plugin';

export const knowledgeWebAnswerPlugin = createKnowledgeAnswerPlugin({ pluginId: 'knowledge.web', searchTool: KNOWLEDGE_WEB_SEARCH_TOOL });
export default knowledgeWebAnswerPlugin;
