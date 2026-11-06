import { expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, stat, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SavedPluginProfiles, ProfileConflict } from '@/connectors/profile-workbench/saved';
import { profileWorkbenchPlugin } from '@/connectors/profile-workbench/plugin';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';
import { LocalConnections } from '@/platform/workspace/connections';
import { createWorkspaceApi } from '@/platform/workspace/api';
import { skill, mcp, openapi, edit, bundle } from './helpers/profileExports';

const keys = ['AGENT_PLUGINS_FILE', 'PLUGIN_SETUP_ASSISTANTS', 'KNOWLEDGE_KIND', 'RELEASE_GITHUB_REPOSITORY', 'RELEASE_GITHUB_BRANCH', 'RELEASE_GITHUB_TOKEN'];
async function fixture(work: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), 'saved-plugin-profile-'));
    const before = keys.map(key => process.env[key]);
    try { keys.forEach(key => delete process.env[key]); await work(directory); }
    finally { await rm(directory, { recursive: true, force: true }); keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }); }
}
const request = (suffix: string, input?: unknown, origin = 'http://localhost') => new Request('http://localhost/api/plugin-profiles/' + suffix, input === undefined ? undefined : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });

test('saved profiles require review, persist privately, serialize stale edits and retain disabled selections', async () => fixture(async directory => {
    const saved = new SavedPluginProfiles(directory);
    expect(await saved.snapshot()).toMatchObject({ revision: null, enabled: false, pending: false, editable: true });
    await expect(saved.save({ files: [skill()], expectedRevision: null, confirmed: false })).rejects.toThrow();
    const results = await Promise.allSettled([saved.save({ files: [skill()], expectedRevision: null, confirmed: true }), saved.save({ files: [openapi()], expectedRevision: null, confirmed: true })]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    const first = await saved.snapshot(); expect(first.pending).toBe(true); expect(first.enabled).toBe(true);
    expect((await stat(path.join(directory, 'plugin-profile.json'))).mode & 0o777).toBe(0o600);
    expect(await new SavedPluginProfiles(directory, first.revision).snapshot()).toMatchObject({ enabled: true, pending: false });
    await expect(saved.activate({ expectedRevision: null, confirmed: true, enabled: false })).rejects.toBeInstanceOf(ProfileConflict);
    const disabled = await saved.activate({ expectedRevision: first.revision, confirmed: true, enabled: false });
    expect(disabled.enabled).toBe(false); expect(disabled.profile).toEqual(first.profile);
    const restored = await saved.activate({ expectedRevision: disabled.revision, confirmed: true, enabled: true });
    expect(restored.profile).toEqual(first.profile); expect((await saved.read())!.record.files).toEqual([skill()]);
}));

test('startup uses reviewed saved modules, preserves history and executes the pinned Skill through the real model SDK', async () => fixture(async directory => {
    const store = new InMemoryPersistentKeyValueStore();
    let modelCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        modelCalls++; const body = await request.json() as any;
        expect(JSON.stringify(body.messages)).toContain('Write a short summary.');
        expect((body.tools || []).map((tool: any) => tool.function.name)).toEqual(['request_human_input']);
        return Response.json({ id: 'saved-profile-fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: '受控协议回复，不代表真实模型质量。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    } });
    const create = (selection: Awaited<ReturnType<typeof loadWorkspacePlugins>>) => {
        const config = { ...buildConfig({}), data_path: directory };
        config.ai = { ...config.ai, provider: 'openai', model: 'fixture', api_key: 'fixture-key', api_base: `http://127.0.0.1:${server.port}/v1` };
        return new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selection.plugins, pluginConfig: selection.config });
    };
    let host: AgentHost | undefined;
    try {
        process.env.PLUGIN_SETUP_ASSISTANTS = 'skills\nopenapi';
        host = create(await loadWorkspacePlugins(directory, ''));
        const search = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, crypto.randomUUID());
        const original = (await host.getLocalRunDetails(search.execution!.run.id))!; await host.stop();
        const saved = new SavedPluginProfiles(directory), installed = await saved.save({ files: [skill()], expectedRevision: null, confirmed: true });
        const selection = await loadWorkspacePlugins(directory, '');
        expect(selection.composition).toEqual({ source: 'saved', revision: installed.revision }); expect(selection.base).toBe('personal');
        host = create(selection); await host.initialize();
        expect(host.canDispatch('skills.prompt.run')).toBe(true); expect(host.canDispatch('knowledge.markdown.retrieve')).toBe(true);
        expect(host.canDispatch('openapi.spec.inspect')).toBe(false);
        expect(await host.web.handle(request('saved')).then(result => result.json())).toMatchObject({ revision: installed.revision, enabled: true, pending: false });
        const executed = await host.runLocal('skills.prompt.run', { prompt: '请整理一条建议。' }, crypto.randomUUID());
        expect(executed.execution!.run.status).toBe('succeeded'); expect(executed.execution!.result.metrics).toMatchObject({ modelCalls: 1, toolCalls: 0 }); expect(modelCalls).toBe(1);
        expect(executed.execution!.artifacts.some(artifact => (artifact.metadata?.upstreamSkill as any)?.sha256 === bundle.sha256)).toBe(true);
        const after = (await host.getLocalRunDetails(original.run.id))!;
        for (const key of ['run', 'steps', 'artifacts'] as const) expect(after[key]).toEqual(original[key]);
        await host.stop();
        const inactive = await new SavedPluginProfiles(directory, installed.revision).activate({ expectedRevision: installed.revision, confirmed: true, enabled: false });
        const defaults = await loadWorkspacePlugins(directory, ''); expect(defaults.composition).toEqual({ source: 'default', revision: inactive.revision });
        host = create(defaults); await host.initialize(); expect(host.canDispatch('skills.prompt.run')).toBe(false); expect(host.canDispatch('openapi.spec.inspect')).toBe(true);
        expect((await host.getLocalRunDetails(executed.execution!.run.id))!.run.status).toBe('succeeded');
    } finally { await host?.stop(); server.stop(true); }
}));

test('saved configuration cannot load arbitrary modules, tokens or unsupported grants and explicit files remain authoritative', async () => fixture(async directory => {
    const file = path.join(directory, 'plugin-profile.json'), marker = path.join(directory, 'executed');
    const malicious = path.join(directory, 'malicious.ts'); await writeFile(malicious, `await Bun.write(${JSON.stringify(marker)}, 'executed');`);
    const invalid = edit(mcp(), profile => { profile.plugins[0].module = malicious; });
    await writeFile(file, JSON.stringify({ apiVersion: '1.0', enabled: true, files: [invalid] }), { mode: 0o600 });
    await expect(loadWorkspacePlugins(directory, '')).rejects.toThrow('不能导入其他模块'); expect(await Bun.file(marker).exists()).toBe(false);
    const explicit = path.resolve(import.meta.dir, '../profiles/agents/empty.yaml');
    expect((await loadWorkspacePlugins(directory, explicit)).plugins).toEqual([]);
    await rm(file);
    const saved = new SavedPluginProfiles(directory);
    for (const bad of [invalid, edit(mcp(), p => { p.plugins[0].config.servers[0].tokenRef = 'env://DO_NOT_ECHO'; })]) {
        await expect(saved.save({ files: [bad], expectedRevision: null, confirmed: true })).rejects.toThrow();
    }
    expect(await Bun.file(file).exists()).toBe(false);
    const current = await saved.save({ files: [skill()], expectedRevision: null, confirmed: true });
    await expect(new SavedPluginProfiles(directory, null, true).save({ files: [openapi()], expectedRevision: current.revision, confirmed: true })).rejects.toBeInstanceOf(ProfileConflict);
    expect((await saved.snapshot()).revision).toBe(current.revision);
}));

test('private profile reads reject public files, links, oversized files and nonregular objects', async () => fixture(async directory => {
    const saved = new SavedPluginProfiles(directory), file = path.join(directory, 'plugin-profile.json');
    await saved.save({ files: [skill()], expectedRevision: null, confirmed: true });
    await chmod(file, 0o644); await expect(saved.read()).rejects.toThrow('private regular'); await chmod(file, 0o600);
    const sentinel = path.join(directory, 'original'); await writeFile(sentinel, 'keep'); await rm(file); await symlink(sentinel, file);
    await expect(saved.read()).rejects.toThrow(); expect(await readFile(sentinel, 'utf8')).toBe('keep'); await rm(file);
    await chmod(sentinel, 0o600); await link(sentinel, file);
    await expect(saved.read()).rejects.toThrow('private regular'); expect(await readFile(sentinel, 'utf8')).toBe('keep'); await rm(file);
    await writeFile(file, Buffer.alloc(3 * 1024 * 1024 + 1), { mode: 0o600 }); await expect(saved.read()).rejects.toThrow('private regular'); await rm(file);
    const fifo = Bun.spawnSync(['mkfifo', file]); expect(fifo.exitCode).toBe(0); await expect(saved.read()).rejects.toThrow('private regular');
}));

test('profile management API is local, review-bound, stale-safe, unloadable and locks helper choices in saved mode', async () => fixture(async directory => {
    const config = { ...buildConfig({}), data_path: directory };
    const host = new AgentHost(() => ({ store: new InMemoryPersistentKeyValueStore(), config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [profileWorkbenchPlugin] });
    await host.initialize();
    try {
        expect((await host.handlePluginRequest(request('save', { files: [skill()], expectedRevision: null, confirmed: true }, 'https://foreign.example'))).status).toBe(403);
        expect((await host.handlePluginRequest(request('save', { files: [skill()], expectedRevision: null, confirmed: false }))).status).toBe(400);
        const response = await host.handlePluginRequest(request('save', { files: [skill()], expectedRevision: null, confirmed: true })); expect(response.status).toBe(200);
        const state: any = await response.json(); expect(state.pending).toBe(true); expect(host.canDispatch('skills.prompt.run')).toBe(false);
        expect((await host.handlePluginRequest(request('activation', { expectedRevision: null, confirmed: true, enabled: false }))).status).toBe(409);
        const bad = await host.handlePluginRequest(request('save', { files: [edit(mcp(), p => { p.plugins[0].config.secret = 'DO_NOT_ECHO'; })], expectedRevision: state.revision, confirmed: true }));
        expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('DO_NOT_ECHO');
        const connections = new LocalConnections(path.join(directory, 'connections.json')); await connections.initialize();
        for (const source of ['saved', 'file'] as const) {
            const api = createWorkspaceApi(host, connections, () => config, 'personal', undefined, { source, revision: state.revision });
            const workspace = await (await api.handle(new Request('http://localhost/api/workspace/state'))).json() as any;
            expect(workspace).toMatchObject({ managedByPluginFile: true, sourceSettingsManagedByPluginFile: false, compositionSource: source });
            expect((await api.handle(new Request('http://localhost/api/workspace/connections', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ PLUGIN_SETUP_ASSISTANTS: 'openapi' }) }))).status).toBe(400);
        }
    } finally { await host.stop(); }
    expect((await host.web.handle(request('saved'))).status).toBe(404);
}));

test('reset command recovers the personal preset without deleting saved instructions or history', async () => fixture(async directory => {
    const saved = new SavedPluginProfiles(directory), current = await saved.save({ files: [skill()], expectedRevision: null, confirmed: true });
    const run = Bun.spawnSync(['bun', 'run', 'src/scripts/resetPluginProfile.ts'], { cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env, DATA_DIR: directory } });
    expect(run.exitCode).toBe(0); expect(run.stdout.toString()).toContain('已停用');
    expect(await saved.snapshot()).toMatchObject({ enabled: false, profile: current.profile });
    expect((await loadWorkspacePlugins(directory, '')).composition?.source).toBe('default');
}));
