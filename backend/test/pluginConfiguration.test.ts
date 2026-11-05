import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { deliveryTeamPlugins } from '@/agents/plugins/builtins';

async function withConfiguration(body: (directory: string, file: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'plugin-configuration-'));
    try { await body(directory, path.join(directory, 'plugins.yaml')); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

describe('trusted plugin configuration', () => {
    test('loads the shipped team, empty and native template profiles', async () => {
        const root = path.resolve(import.meta.dir, '../profiles/agents');
        const team = await loadPluginConfiguration(path.join(root, 'team.yaml'), deliveryTeamPlugins);
        expect(team.plugins).toHaveLength(8);
        expect((await loadPluginConfiguration(path.join(root, 'empty.yaml'), deliveryTeamPlugins)).plugins).toEqual([]);
        const demo = await loadPluginConfiguration(path.join(root, 'native-demo.yaml'), deliveryTeamPlugins);
        expect(demo.plugins.map(plugin => plugin.manifest.id)).toEqual(['example.echo']);
    });

    test('uses declared dependencies rather than YAML order and retains per-plugin config', async () => {
        await withConfiguration(async (_directory, file) => {
            const rows = [...deliveryTeamPlugins].reverse().map(plugin => ({ module: plugin.manifest.id, config: { label: plugin.manifest.id } }));
            await writeFile(file, JSON.stringify({ apiVersion: '1.0', plugins: rows }));
            const selection = await loadPluginConfiguration(file, deliveryTeamPlugins);
            expect(selection.plugins.findIndex(plugin => plugin.manifest.id === 'builtin.task'))
                .toBeLessThan(selection.plugins.findIndex(plugin => plugin.manifest.id === 'builtin.orchestrator'));
            expect(selection.config['builtin.task']).toEqual({ label: 'builtin.task' });
        });
    });

    test('does not import disabled modules', async () => {
        await withConfiguration(async (directory, file) => {
            await writeFile(path.join(directory, 'disabled.ts'), 'throw new Error("disabled module was imported");');
            await writeFile(file, JSON.stringify({ apiVersion: '1.0', plugins: [{ module: './disabled.ts', enabled: false }] }));
            expect((await loadPluginConfiguration(file)).plugins).toEqual([]);
        });
    });

    test('rejects unknown built-ins, missing dependencies, duplicates and remote code URLs', async () => {
        await withConfiguration(async (_directory, file) => {
            for (const [rows, error] of [
                [[{ module: 'builtin.unknown' }], 'Unknown built-in plugin'],
                [[{ module: 'builtin.orchestrator' }], 'Required plugin is missing'],
                [[{ module: 'builtin.task' }, { module: 'builtin.task' }], 'Duplicate plugin'],
                [[{ module: 'https://example.test/plugin.ts' }], 'local paths or installed packages'],
            ] as const) {
                await writeFile(file, JSON.stringify({ apiVersion: '1.0', plugins: rows }));
                await expect(loadPluginConfiguration(file, deliveryTeamPlugins)).rejects.toThrow(error);
            }
        });
    });

    test('rejects an invalid configuration schema before importing any module', async () => {
        await withConfiguration(async (_directory, file) => {
            await writeFile(file, JSON.stringify({ apiVersion: '1.0', plugins: [{ module: './does-not-exist.ts', enabled: 'true' }] }));
            await expect(loadPluginConfiguration(file)).rejects.toThrow('expected boolean');
        });
    });
});
