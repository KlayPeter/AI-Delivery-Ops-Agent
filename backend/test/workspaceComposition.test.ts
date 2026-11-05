import { createKnowledgeWebPlugin } from '@/knowledge/web/plugin';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { createWorkspaceApi } from '@/platform/workspace/api';

const profile = (name: string) => path.resolve(import.meta.dir, `../profiles/agents/${name}.yaml`);
const environmentKeys = ['DATA_DIR', 'AGENT_PLUGINS_FILE', 'KNOWLEDGE_KIND', 'KNOWLEDGE_URLS', 'KNOWLEDGE_ROOT', 'KNOWLEDGE_VAULT_NAME', 'KNOWLEDGE_EXCLUDE', 'RELEASE_GITHUB_REPOSITORY', 'RELEASE_GITHUB_BRANCH', 'RELEASE_GITHUB_TOKEN'];
let previous: Record<string, string | undefined>;
let root: string, directory: string;
beforeEach(async () => {
    previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])); for (const key of environmentKeys) delete process.env[key];
    root = await mkdtemp(path.join(tmpdir(), 'workspace-composition-')); directory = path.join(root, 'fixture-data');
    await mkdir(directory, { mode: 0o700 });
    process.env.DATA_DIR = path.join(root, 'environment-data');
});
afterEach(async () => {
    for (const key of environmentKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
});
const createHost = async (store = new InMemoryPersistentKeyValueStore(), file = '') => {
    const selection = await loadWorkspacePlugins(directory, file);
    const config = { ...buildConfig({}), data_path: directory };
    return new AgentHost(() => ({ store, config, feishu: {}, tapd: {}, intentParser: {} } as any), 1000, undefined, [], { plugins: selection.plugins, pluginConfig: selection.config });
};

test('HTTP default loads personal plugins without implicit team agents, routes or manual jobs', async () => {
    const selected = await loadWorkspacePlugins(directory, '');
    expect(selected.plugins).toHaveLength(14);
    expect(selected.plugins.some(plugin => plugin.manifest.id.startsWith('builtin.'))).toBe(false);
    const host = await createHost();
    try {
        const result = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded');
        expect(await host.listAgents()).toHaveLength(9);
        expect(host.canDispatch('delivery.ops.orchestrate')).toBe(false);
        expect(host.web.pages().every(page => page.section === 'workspace')).toBe(true);
        expect(host.web.manualJobs()).toEqual([]);
        expect(host.web.routes().some(route => route.path.startsWith('/api/standups'))).toBe(false);
        expect((await host.web.handle(new Request('http://localhost/api/standups'))).status).toBe(404);
        expect(await readdir(root)).toEqual(['fixture-data']);
    } finally { await host.stop(); }
});

test('explicit team and empty files fully replace the default composition', async () => {
    process.env.KNOWLEDGE_KIND = 'web'; process.env.KNOWLEDGE_URLS = '';
    process.env.AGENT_PLUGINS_FILE = profile('team');
    expect((await loadWorkspacePlugins(directory)).plugins).toHaveLength(12);
    const team = await loadWorkspacePlugins(directory, profile('team'));
    expect(team.plugins).toHaveLength(12); expect(team.plugins.every(plugin => ['builtin.', 'model.'].some(prefix => plugin.manifest.id.startsWith(prefix)))).toBe(true);
    const host = await createHost(undefined, profile('team'));
    try {
        await host.initialize();
        expect(await host.listAgents()).toHaveLength(7);
        expect(host.canDispatch('delivery.ops.orchestrate')).toBe(true);
        expect(host.web.pages().some(page => page.path === '/standups')).toBe(true);
        expect(host.web.manualJobs()).toContain('daily-summary');
        expect(host.web.routes().some(route => route.path.startsWith('/api/standups'))).toBe(true);
        expect(host.canDispatch('knowledge.markdown.retrieve')).toBe(false);
    } finally { await host.stop(); }
    const empty = await createHost(undefined, profile('empty'));
    try { await empty.initialize(); expect(await empty.listAgents()).toEqual([]); expect(empty.web.pages()).toEqual([]); expect(empty.web.manualJobs()).toEqual([]); }
    finally { await empty.stop(); }
});

test('an explicit personal base retains actual source settings, adds plugins and exposes editable source ownership', async () => {
    const file = path.join(root, 'personal.yaml');
    await writeFile(file, JSON.stringify({ apiVersion: '1.0', base: 'personal', plugins: [{ module: path.resolve(import.meta.dir, '../examples/plugins/echo.ts') }] }));
    process.env.AGENT_PLUGINS_FILE = file;
    const selection = await loadWorkspacePlugins(directory), config = { ...buildConfig({}), data_path: directory };
    expect(selection.base).toBe('personal'); expect(selection.plugins).toHaveLength(15);
    const host = new AgentHost(() => ({ store: new InMemoryPersistentKeyValueStore(), config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selection.plugins, pluginConfig: selection.config });
    try {
        const result = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, randomUUID());
        expect((result.execution!.result.data as any).hits).not.toHaveLength(0);
        expect((await host.runLocal('example.echo', { text: 'extends personal workspace' }, randomUUID())).execution!.run.status).toBe('succeeded');
        expect(await host.listAgents()).toHaveLength(10); expect(host.web.pages().some(page => page.path === '/knowledge')).toBe(true);
        const app = createWorkspaceApi(host, {} as any, () => config, selection.base);
        const state = await (await app.handle(new Request('http://localhost/api/workspace/state'))).json() as any;
        expect(state).toMatchObject({ base: 'personal', managedByPluginFile: true, sourceSettingsManagedByPluginFile: false, knowledgeKind: 'sample' });
        const standaloneState = await (await createWorkspaceApi(host, {} as any, () => config).handle(new Request('http://localhost/api/workspace/state'))).json() as any;
        expect(standaloneState.sourceSettingsManagedByPluginFile).toBe(true);
    } finally { await host.stop(); }
    process.env.KNOWLEDGE_KIND = 'library';
    const library = await loadWorkspacePlugins(directory);
    expect(library.config['knowledge.markdown']!.sourceId).toBe('workspace-library');
    expect(library.config['knowledge.markdown']!.root).toContain(directory);
    expect(library.config['knowledge.markdown']!.root).not.toContain(process.env.DATA_DIR!);
    process.env.RELEASE_GITHUB_REPOSITORY = 'example/project';
    const github = await loadWorkspacePlugins(directory);
    expect(github.plugins).toHaveLength(17); expect(github.config['connector.github']!.repository).toBe('example/project');
    await writeFile(file, JSON.stringify({ apiVersion: '1.0', base: 'personal', plugins: [{ module: 'knowledge.markdown' }] }));
    await expect(loadWorkspacePlugins(directory)).rejects.toThrow('Duplicate plugin');
});

test('switching profiles preserves successful run artifacts and does not re-enable their old agents', async () => {
    const store = new InMemoryPersistentKeyValueStore();
    const original = await createHost(store, profile('native-demo'));
    let runId: string;
    try {
        const result = await original.runLocal('example.echo', { text: '来自之前组合的演示记录' }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded'); runId = result.execution!.run.id;
    } finally { await original.stop(); }
    const personal = await createHost(store);
    try {
        await personal.initialize();
        const saved = await personal.getLocalRunDetails(runId!);
        expect(saved?.run.status).toBe('succeeded'); expect(saved?.artifacts[0]?.content).toBe('来自之前组合的演示记录');
        expect(personal.canDispatch('example.echo')).toBe(false);
    } finally { await personal.stop(); }
});

test('mixed HTTP selection composes both sources, matching answer/research/impact, and the optional mixed release port', async () => {
    process.env.KNOWLEDGE_KIND = 'mixed'; process.env.KNOWLEDGE_ROOT = path.join(import.meta.dir, '../examples/knowledge-vault'); process.env.KNOWLEDGE_URLS = 'https://example.com/policy';
    const selection = await loadWorkspacePlugins(directory, '');
    expect(selection.plugins).toHaveLength(16);
    expect(selection.plugins.find(plugin => plugin.manifest.id === 'knowledge.answer')!.manifest.requires).toEqual(['knowledge.mixed']);
    const host = new AgentHost(() => ({ config: { ...buildConfig({}), data_path: directory }, store: new InMemoryPersistentKeyValueStore(), feishu: {}, tapd: {} } as any), 1000, undefined, [], {
        plugins: selection.plugins.map(plugin => plugin.manifest.id === 'knowledge.web' ? createKnowledgeWebPlugin(async () => ({ url: 'https://example.com/policy', body: Buffer.from('# API policy\nAPI needs migration notes.'), contentType: 'text/markdown' })) : plugin), pluginConfig: selection.config,
    });
    try {
        await host.initialize(); expect(await host.listAgents()).toHaveLength(11);
        const result = await host.runLocal('knowledge.mixed.retrieve', { operation: 'search', query: 'API', limit: 5 }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded');
        expect((result.execution!.result.data as any).hits.some((hit: any) => hit.sourceKind === 'web')).toBe(true);
    } finally { await host.stop(); }
    process.env.RELEASE_GITHUB_REPOSITORY = 'example/project';
    const release = await loadWorkspacePlugins(directory, ''); expect(release.plugins).toHaveLength(18);
    expect(release.plugins.find(plugin => plugin.manifest.id === 'release.prepare')?.manifest.requires).toContain('knowledge.mixed');
    const demo = await loadWorkspacePlugins(directory, profile('knowledge-mixed-demo'));
    expect(demo.plugins).toHaveLength(11); expect(demo.plugins.reduce((sum, plugin) => sum + (plugin.agents?.length || 0), 0)).toBe(7); expect(demo.plugins.find(plugin => plugin.manifest.id === 'personal.research')?.manifest.requires).toContain('knowledge.mixed');
});
