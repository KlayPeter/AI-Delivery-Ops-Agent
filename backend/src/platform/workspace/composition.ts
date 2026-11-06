import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { loadPluginConfiguration, type PluginSelection } from '@/platform/plugins/configuration';
import { workspaceKnowledge } from './knowledge';

export async function loadWorkspacePlugins(dataPath: string, file = process.env.AGENT_PLUGINS_FILE): Promise<PluginSelection> {
    // The explicit file owns extra plugins, including when it extends the personal base.
    return file ? loadPluginConfiguration(file, deliveryTeamPlugins, () => workspaceKnowledge(dataPath, false)) : workspaceKnowledge(dataPath);
}
