import { loadConfig } from '@/core/config';
import { SavedPluginProfiles } from '@/connectors/profile-workbench/saved';

try {
    const saved = new SavedPluginProfiles(loadConfig().data_path), state = await saved.snapshot();
    if (state.enabled) await saved.activate({ expectedRevision: state.revision, confirmed: true, enabled: false });
    console.log('已停用保存的插件组合，配置与历史保留。重新运行 bun run local 使用个人预设；显式 AGENT_PLUGINS_FILE 仍优先。');
} catch {
    console.error('无法停用保存的组合；请检查显式 AGENT_PLUGINS_FILE 与数据目录中的 plugin-profile.json，未自动删除配置。');
    process.exitCode = 1;
}
