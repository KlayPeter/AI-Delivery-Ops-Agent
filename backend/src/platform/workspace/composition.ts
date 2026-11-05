import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { workspaceKnowledge } from './knowledge';

export async function loadWorkspacePlugins(dataPath: string, file = process.env.AGENT_PLUGINS_FILE) {
    return file ? loadPluginConfiguration(file, deliveryTeamPlugins) : workspaceKnowledge(dataPath);
}
