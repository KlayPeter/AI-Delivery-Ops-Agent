import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';

const profile = (name: string) => path.resolve(import.meta.dir, `../profiles/agents/${name}.yaml`);
const environmentKeys = ['AGENT_PLUGINS_FILE', 'KNOWLEDGE_KIND', 'KNOWLEDGE_URLS', 'RELEASE_GITHUB_REPOSITORY', 'RELEASE_GITHUB_BRANCH', 'RELEASE_GITHUB_TOKEN'];
let previous: Record<string, string | undefined>;
beforeEach(() => { previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])); for (const key of environmentKeys) delete process.env[key]; });
afterEach(() => { for (const key of environmentKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
const createHost = async (store = new InMemoryPersistentKeyValueStore(), file = '') => {
    const selection = await loadWorkspacePlugins('/tmp/workspace-composition-test', file);
    const config = buildConfig({});
    return new AgentHost(() => ({ store, config, feishu: {}, tapd: {}, intentParser: {} } as any), 1000, undefined, [], { plugins: selection.plugins, pluginConfig: selection.config });
};

test('HTTP default loads personal plugins without implicit team agents, routes or manual jobs', async () => {
    const selected = await loadWorkspacePlugins('/tmp/workspace-composition-test', '');
    expect(selected.plugins).toHaveLength(9);
    expect(selected.plugins.some(plugin => plugin.manifest.id.startsWith('builtin.'))).toBe(false);
    const host = await createHost();
    try {
        const result = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded');
        expect(await host.listAgents()).toHaveLength(8);
        expect(host.canDispatch('delivery.ops.orchestrate')).toBe(false);
        expect(host.web.pages().every(page => page.section === 'workspace')).toBe(true);
        expect(host.web.manualJobs()).toEqual([]);
        expect(host.web.routes().some(route => route.path.startsWith('/api/standups'))).toBe(false);
        expect((await host.web.handle(new Request('http://localhost/api/standups'))).status).toBe(404);
    } finally { await host.stop(); }
});

test('explicit team and empty files fully replace the default composition', async () => {
    process.env.KNOWLEDGE_KIND = 'web'; process.env.KNOWLEDGE_URLS = '';
    process.env.AGENT_PLUGINS_FILE = profile('team');
    expect((await loadWorkspacePlugins('/tmp/workspace-composition-test')).plugins).toHaveLength(9);
    const team = await loadWorkspacePlugins('/tmp/workspace-composition-test', profile('team'));
    expect(team.plugins).toHaveLength(9); expect(team.plugins.every(plugin => plugin.manifest.id.startsWith('builtin.'))).toBe(true);
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
