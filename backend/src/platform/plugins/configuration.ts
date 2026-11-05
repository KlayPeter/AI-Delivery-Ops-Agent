import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import type { FeaturePlugin } from './contracts';
import { orderPlugins } from './runtime';

const configurationSchema = z.object({
    apiVersion: z.literal('1.0'),
    plugins: z.array(z.object({
        module: z.string().trim().min(1),
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
    }).strict()),
}).strict();

export interface PluginSelection {
    plugins: FeaturePlugin[];
    config: Record<string, Record<string, unknown>>;
}

export async function loadPluginConfiguration(file: string, builtins: readonly FeaturePlugin[] = []): Promise<PluginSelection> {
    const filename = path.resolve(file);
    const configuration = configurationSchema.parse(parse(await readFile(filename, 'utf8')));
    const byId = new Map(builtins.map(plugin => [plugin.manifest.id, plugin]));
    const selected: Array<{ plugin: FeaturePlugin; config: Record<string, unknown> }> = [];
    for (const entry of configuration.plugins) {
        if (entry.enabled === false) continue;
        let plugin = byId.get(entry.module);
        if (!plugin) {
            if (entry.module.startsWith('builtin.')) throw new Error(`Unknown built-in plugin: ${entry.module}`);
            if (/^[a-z][a-z\d+.-]*:/i.test(entry.module)) throw new Error('Plugin modules must be local paths or installed packages');
            const modulePath = path.isAbsolute(entry.module) || entry.module.startsWith('.')
                ? pathToFileURL(path.resolve(path.dirname(filename), entry.module)).href
                : entry.module;
            const imported = await import(modulePath);
            plugin = (imported.default || imported) as FeaturePlugin;
        }
        selected.push({ plugin, config: entry.config || {} });
    }
    const plugins = orderPlugins(selected.map(entry => entry.plugin));
    const config = Object.fromEntries(selected.map(entry => [entry.plugin.manifest.id, entry.config]));
    return { plugins, config };
}
