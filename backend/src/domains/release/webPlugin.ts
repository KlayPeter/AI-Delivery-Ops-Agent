import { KNOWLEDGE_WEB_SEARCH_TOOL } from '@/knowledge/web/plugin';
import { createReleasePlugin } from './plugin';

export const webReleasePlugin = createReleasePlugin({ pluginId: 'knowledge.web', searchTool: KNOWLEDGE_WEB_SEARCH_TOOL });
export default webReleasePlugin;
