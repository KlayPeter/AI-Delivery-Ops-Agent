import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { loadPluginConfiguration, type PluginSelection } from '@/platform/plugins/configuration';
import { workspaceKnowledge } from './knowledge';

export async function loadWorkspacePlugins(dataPath: string, file = process.env.AGENT_PLUGINS_FILE): Promise<PluginSelection> {
    return file ? loadPluginConfiguration(file, deliveryTeamPlugins, () => workspaceKnowledge(dataPath)) : workspaceKnowledge(dataPath);
}
