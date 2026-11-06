import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { loadPluginConfiguration, loadPluginConfigurationValue, type PluginSelection } from '@/platform/plugins/configuration';
import { SavedPluginProfiles } from '@/connectors/profile-workbench/saved';
import { parse } from 'yaml';
import path from 'node:path';
import { workspaceKnowledge } from './knowledge';

export async function loadWorkspacePlugins(dataPath: string, file = process.env.AGENT_PLUGINS_FILE): Promise<PluginSelection> {
    // The explicit file owns extra plugins, including when it extends the personal base.
    const saved = file ? null : await new SavedPluginProfiles(dataPath).read();
    const selected = file ? await loadPluginConfiguration(file, deliveryTeamPlugins, () => workspaceKnowledge(dataPath, false))
        : saved?.record.enabled ? await loadPluginConfigurationValue(parse(saved.profile.yaml), path.resolve(import.meta.dir, '../../..'), deliveryTeamPlugins, () => workspaceKnowledge(dataPath, false)) : workspaceKnowledge(dataPath);
    if (selected.plugins.some(plugin => plugin.manifest.id === 'plugins.compose')) selected.config['plugins.compose'] = { ...selected.config['plugins.compose'], appliedRevision: saved?.revision ?? null, externalFile: Boolean(file) };
    return { ...selected, composition: { source: file ? 'file' : saved?.record.enabled ? 'saved' : 'default', ...(saved ? { revision: saved.revision } : {}) } };
}
