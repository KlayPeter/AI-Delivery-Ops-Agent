import { createKnowledgeImpactPlugin } from '../impact/plugin';
import { mixedSourcePort, MIXED_VERSIONS_TOOL } from './plugin';
export const knowledgeMixedImpactPlugin = createKnowledgeImpactPlugin({ pluginId: mixedSourcePort.pluginId, versionsTool: MIXED_VERSIONS_TOOL, kind: 'mixed' });
export default knowledgeMixedImpactPlugin;
