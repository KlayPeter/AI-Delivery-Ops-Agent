import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalConnections, connectionKeys, isLocalWorkspaceRequest } from '@/platform/workspace/connections';
import { createWorkspaceApi } from '@/platform/workspace/api';
import { workspaceKnowledge } from '@/platform/workspace/knowledge';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { buildConfig } from '@/core/config';
import { echoPlugin } from '../examples/plugins/echo';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { createGitHubPlugin } from '@/connectors/github/plugin';
import { githubFixture, repository, window } from './helpers/github';

let directory: string;
let environment: Record<string, string | undefined>;
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'agent-workspace-test-'));
    environment = Object.fromEntries(connectionKeys.map(key => [key, process.env[key]]));
    for (const key of connectionKeys) delete process.env[key];
});
afterEach(async () => {
    for (const key of connectionKeys) {
        if (environment[key] === undefined) delete process.env[key];
        else process.env[key] = environment[key];
    }
    await rm(directory, { recursive: true, force: true });
});

describe('local connection settings', () => {
    test('persists private settings without echoing secrets, applies them only after restart, and preserves omitted fields', async () => {
        const file = path.join(directory, 'connections.json');
        const settings = new LocalConnections(file);
        await settings.initialize();
        const result = await settings.save({ FEISHU_APP_ID: 'cli_aaaaaaaaaaaaaaaa', FEISHU_APP_SECRET: 'test-only-secret', AI_MODEL: 'test-model' });
        expect(result.secrets.FEISHU_APP_SECRET).toBe(true);
        expect(JSON.stringify(result)).not.toContain('test-only-secret');
        expect(result.restartRequired).toBe(true);
        expect(process.env.FEISHU_APP_SECRET).toBeUndefined();
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        await Promise.all([settings.save({ AI_MODEL: 'next-model' }), settings.save({ KNOWLEDGE_KIND: 'sample' })]);
        const restarted = new LocalConnections(file);
        await restarted.initialize();
        expect(process.env.FEISHU_APP_SECRET).toBe('test-only-secret');
        expect(process.env.AI_MODEL).toBe('next-model');
        expect(buildConfig({ ai: { model: 'old-config-file' } }).ai.model).toBe('next-model');
        expect(restarted.snapshot().restartRequired).toBe(false);
        const cleared = await restarted.save({ FEISHU_APP_ID: '', FEISHU_APP_SECRET: null });
        expect(cleared.secrets.FEISHU_APP_SECRET).toBe(false);
    });

    test('rejects invalid credentials, unsafe source settings and unknown fields before replacing the saved file', async () => {
        const file = path.join(directory, 'connections.json');
        const settings = new LocalConnections(file);
        await settings.initialize(); await settings.save({ AI_MODEL: 'kept-model' });
        const before = await readFile(file, 'utf8');
        for (const payload of [
            { FEISHU_APP_ID: 'cli_aaaaaaaaaaaaaaaa' }, { FEISHU_APP_ID: 'bad', FEISHU_APP_SECRET: 'test-only' },
            { AI_API_BASE: 'javascript:alert(1)' }, { AI_API_BASE: 'https://key:secret@example.com' },
            { KNOWLEDGE_KIND: 'markdown', KNOWLEDGE_ROOT: '../private' },
            { KNOWLEDGE_KIND: 'markdown', KNOWLEDGE_ROOT: directory, KNOWLEDGE_EXCLUDE: '../escape' },
            { KNOWLEDGE_KIND: 'web', KNOWLEDGE_URLS: 'http://127.0.0.1/private' },
            { AI_MODEL: '\0' }, { HOST: '0.0.0.0' }, { AI_MODEL: null },
            { RELEASE_GITHUB_REPOSITORY: 'https://github.com/example/project' }, { RELEASE_GITHUB_REPOSITORY: 'example/..' },
            { RELEASE_GITHUB_REPOSITORY: repository, RELEASE_GITHUB_BRANCH: 'x'.repeat(257) },
        ]) await expect(settings.save(payload)).rejects.toThrow();
        expect(await readFile(file, 'utf8')).toBe(before);
    });

    test('refuses symlink and world-readable credential files', async () => {
        const target = path.join(directory, 'target.json');
        await writeFile(target, '{}', { mode: 0o600 });
        const link = path.join(directory, 'link.json'); await symlink(target, link);
        await expect(new LocalConnections(link).initialize()).rejects.toThrow();
        const publicFile = path.join(directory, 'public.json'); await writeFile(publicFile, '{}', { mode: 0o644 });
        await expect(new LocalConnections(publicFile).initialize()).rejects.toThrow('private regular file');
    });

    test('accepts loopback UI origins and rejects cross-site requests and DNS rebinding hosts', () => {
        for (const origin of ['http://localhost:15173', 'http://127.0.0.1:15174']) {
            expect(isLocalWorkspaceRequest(new Request('http://127.0.0.1:8090/api/workspace/state', { headers: { origin } }))).toBe(true);
        }
        for (const [url, headers] of [
            ['http://evil.test/api/workspace/state', {}],
            ['http://127.0.0.1/api/workspace/state', { origin: 'https://evil.test' }],
            ['http://127.0.0.1/api/workspace/state', { origin: 'null' }],
            ['http://127.0.0.1/api/workspace/state', { 'sec-fetch-site': 'cross-site' }],
        ] as const) expect(isLocalWorkspaceRequest(new Request(url, { headers }))).toBe(false);
    });
});

test('GitHub settings enable the matching release composition after restart, keep the token private, and can disable it', async () => {
    const file = path.join(directory, 'connections.json');
    const settings = new LocalConnections(file); await settings.initialize();
    expect(workspaceKnowledge(directory).plugins.some(plugin => plugin.manifest.id === 'release.prepare')).toBe(false);
    const saved = await settings.save({ RELEASE_GITHUB_REPOSITORY: repository, RELEASE_GITHUB_BRANCH: 'main', RELEASE_GITHUB_TOKEN: 'fixture-private-token' });
    expect(saved.secrets.RELEASE_GITHUB_TOKEN).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('fixture-private-token');
    expect(workspaceKnowledge(directory).plugins.some(plugin => plugin.manifest.id === 'release.prepare')).toBe(false);
    await new LocalConnections(file).initialize();
    const selected = workspaceKnowledge(directory), github = githubFixture();
    expect('connector.github' in selected.config ? selected.config['connector.github'] : undefined).toMatchObject({ repository, baseBranch: 'main', tokenRef: 'env://RELEASE_GITHUB_TOKEN' });
    const config = { ...buildConfig({}), data_path: directory }, store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {}, intentParser: {} } as any), 1000, undefined, [], {
        plugins: selected.plugins.map(plugin => plugin.manifest.id === 'connector.github' ? createGitHubPlugin(github) : plugin), pluginConfig: selected.config,
    });
    try {
        await host.start();
        const app = createWorkspaceApi(host, settings, () => config);
        const state = await (await app.handle(new Request('http://localhost/api/workspace/state'))).json() as any;
        expect(state.pages.find((page: any) => page.path === '/release')?.view.id).toBe('release-preparation');
        const response = await app.handle(new Request('http://localhost/api/workspace/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ capability: 'release.prepare', input: { ...window, policyQuery: 'API 迁移', operation: 'collect' } }) }));
        expect(response.status).toBe(200);
        const result = await response.json() as any;
        expect(result.status).toBe('succeeded');
        const details = await host.getLocalRunDetails(result.runId);
        expect(details!.artifacts.map(artifact => artifact.type).sort()).toEqual(['json', 'markdown']);
        expect(github.calls.every(call => call.init?.method === 'GET')).toBe(true);
        expect(JSON.stringify(details)).not.toContain('fixture-private-token');
    } finally { await host.stop(); }
    expect(host.web.pages()).toEqual([]);
    process.env.KNOWLEDGE_KIND = 'web'; process.env.KNOWLEDGE_URLS = 'https://example.com/policy';
    expect(workspaceKnowledge(directory).plugins.find(plugin => plugin.manifest.id === 'release.prepare')?.manifest.requires).toContain('knowledge.web');
    await settings.save({ RELEASE_GITHUB_REPOSITORY: '', RELEASE_GITHUB_TOKEN: null });
    const disabled = new LocalConnections(file); await disabled.initialize();
    expect(workspaceKnowledge(directory).plugins.some(plugin => plugin.manifest.id === 'release.prepare')).toBe(false);
    expect(disabled.snapshot().secrets.RELEASE_GITHUB_TOKEN).toBe(false);
});

test('workspace API runs a real plugin, deduplicates triggers, returns artifacts and excludes foreign workspaces', async () => {
    const store = new InMemoryPersistentKeyValueStore();
    const config = buildConfig({});
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {}, intentParser: {} } as any), 1000, undefined, [], { plugins: [echoPlugin] });
    const settings = new LocalConnections(path.join(directory, 'connections.json')); await settings.initialize();
    await host.start();
    try {
        const app = createWorkspaceApi(host, settings, () => config);
        const request = (url: string, body?: unknown) => app.handle(new Request(`http://localhost/api/workspace${url}`, body === undefined ? undefined : {
            method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:15173' }, body: JSON.stringify(body),
        }));
        const body = { capability: 'example.echo', input: { text: '真实插件结果' }, triggerId: randomUUID() };
        const response = await request('/runs', body); expect(response.status).toBe(200);
        const result = await response.json() as any;
        expect(result.status).toBe('succeeded');
        const duplicate = await (await request('/runs', body)).json() as any;
        expect(duplicate.runId).toBe(result.runId);
        const details = await (await request(`/runs/${result.runId}`)).json() as any;
        expect(details.artifacts[0].content).toBe('真实插件结果');
        const foreign = { ...details.run, id: randomUUID(), workspaceId: 'foreign-workspace' };
        await new PersistentAgentRunStore(store).create(foreign);
        expect((await request(`/runs/${foreign.id}`)).status).toBe(404);
        const state = await (await request('/state')).json() as any;
        expect(state.runs.map((run: any) => run.id)).toEqual([result.runId]);
        expect(state.plugins[0].id).toBe('example.echo');
        expect(state.knowledgeKind).toBe('none');
        const rejected = await app.handle(new Request('http://localhost/api/workspace/connections', { headers: { origin: 'https://evil.test' } }));
        expect(rejected.status).toBe(403);
    } finally { await host.stop(); }
});

test('default workspace knowledge retrieves bundled sample evidence without a model or Feishu', async () => {
    const selected = workspaceKnowledge(directory);
    const config = { ...buildConfig({}), data_path: directory };
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {}, intentParser: {} } as any), 1000, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
    try {
        const result = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, randomUUID());
        expect(result.execution?.run.status).toBe('succeeded');
        const content = result.execution?.artifacts[0]?.content as any;
        expect(content.hits[0].excerpt).toContain('不兼容变更');
        expect(content.hits[0].documentVersion).toHaveLength(64);
    } finally { await host.stop(); }
});

test('local human continuation stays on the original run and refuses completed or foreign runs', async () => {
    const store = new InMemoryPersistentKeyValueStore();
    const config = buildConfig({});
    const original = echoPlugin.agents![0]!;
    const manifest = { ...original.manifest, id: 'example.human', capabilities: ['example.human'] };
    const plugin: FeaturePlugin = {
        manifest: { ...echoPlugin.manifest, id: 'example.human' },
        agents: [{ manifest, installationId: 'install-human' }],
        apply(ctx) {
            ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async request => {
                const { text } = request.input as { text: string };
                return { status: text === 'ask' ? 'needs_human' : 'succeeded', data: { text }, artifacts: [] };
            });
        },
    };
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {}, intentParser: {} } as any), 1000, undefined, [], { plugins: [plugin] });
    try {
        const first = await host.runLocal('example.human', { text: 'ask' }, randomUUID());
        const id = first.execution!.run.id;
        expect(first.execution!.run.status).toBe('waiting_human');
        const resumed = await host.resumeLocal(id, { text: 'confirmed' }, randomUUID());
        expect(resumed.execution!.run.id).toBe(id);
        expect(resumed.execution!.run.status).toBe('succeeded');
        expect((await host.resumeLocal(id, { text: 'again' }, randomUUID())).status).toBe('failed');
        expect((await host.getLocalRunDetails(id))!.run.status).toBe('succeeded');
        const foreign = { ...resumed.execution!.run, id: randomUUID(), workspaceId: 'foreign' };
        await new PersistentAgentRunStore(store).create(foreign);
        await expect(host.resumeLocal(foreign.id, { text: 'rejected' }, randomUUID())).rejects.toThrow('local workspace');
    } finally { await host.stop(); }
});
