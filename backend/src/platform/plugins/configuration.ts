import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import type { FeaturePlugin } from './contracts';
import { orderPlugins } from './runtime';

const configurationSchema = z.object({
    apiVersion: z.literal('1.0'),
    base: z.literal('personal').optional(),
    plugins: z.array(z.object({
        module: z.string().trim().min(1),
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
    }).strict()),
}).strict();

export interface PluginSelection {
    plugins: FeaturePlugin[];
    config: Record<string, Record<string, unknown>>;
    base?: 'personal';
    composition?: { source: 'default' | 'saved' | 'file'; revision?: string };
}

export async function loadPluginConfiguration(file: string, builtins: readonly FeaturePlugin[] = [], personalBase?: () => PluginSelection): Promise<PluginSelection> {
    const filename = path.resolve(file);
    return loadPluginConfigurationValue(parse(await readFile(filename, 'utf8')), path.dirname(filename), builtins, personalBase);
}

export async function loadPluginConfigurationValue(value: unknown, directory: string, builtins: readonly FeaturePlugin[] = [], personalBase?: () => PluginSelection): Promise<PluginSelection> {
    const configuration = configurationSchema.parse(value);
    if (configuration.base && !personalBase) throw new Error('base: personal 需要通过本机工作台组合加载器解析');
    const base = configuration.base ? personalBase!() : undefined;
    const byId = new Map([...builtins, ...(base?.plugins || [])].map(plugin => [plugin.manifest.id, plugin]));
    const selected: Array<{ plugin: FeaturePlugin; config: Record<string, unknown> }> = (base?.plugins || []).map(plugin => ({ plugin, config: base!.config[plugin.manifest.id] || {} }));
    for (const entry of configuration.plugins) {
        if (entry.enabled === false) continue;
        let plugin = byId.get(entry.module);
        if (!plugin) {
            if (entry.module.startsWith('builtin.')) throw new Error(`Unknown built-in plugin: ${entry.module}`);
            if (/^[a-z][a-z\d+.-]*:/i.test(entry.module)) throw new Error('Plugin modules must be local paths or installed packages');
            const modulePath = path.isAbsolute(entry.module) || entry.module.startsWith('.')
                ? pathToFileURL(path.resolve(directory, entry.module)).href
                : entry.module;
            const imported = await import(modulePath);
            plugin = (imported.default || imported) as FeaturePlugin;
        }
        selected.push({ plugin, config: entry.config || {} });
    }
    const plugins = orderPlugins(selected.map(entry => entry.plugin));
    const config = Object.fromEntries(selected.map(entry => [entry.plugin.manifest.id, entry.config]));
    return { plugins, config, ...(configuration.base ? { base: configuration.base } : {}) };
}
