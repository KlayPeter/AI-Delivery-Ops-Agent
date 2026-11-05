import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';
import { composeProfiles } from '@/connectors/profile-workbench/compose';
import { profileWorkbenchPlugin } from '@/connectors/profile-workbench/plugin';
import { exportMcpProfile } from '@/connectors/mcp-workbench/catalog';
import { preparePromptSkills } from '@/connectors/skill-workbench/catalog';
import { sha256 } from '@/connectors/skill-workbench/source';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { buildConfig } from '@/core/config';
import { readSmallJsonBody } from '@/platform/workspace/request';

const skillModule = './src/connectors/skill-workbench/promptPlugin.ts';
const rawSkill = '---\nname: writing-helper\ndescription: Write concise summaries\nlicense: MIT\n---\nWrite a short summary.\n';
const commit = 'a'.repeat(40), root = `https://github.com/example/skills/blob/${commit}`;
const bundle = { schemaVersion: '1.0', requestedUrl: 'https://github.com/example/skills/blob/main/skills/writing-helper/SKILL.md', owner: 'example', repo: 'skills', commit,
    filePath: 'skills/writing-helper/SKILL.md', skillUrl: `${root}/skills/writing-helper/SKILL.md`, rawUrl: `https://raw.githubusercontent.com/example/skills/${commit}/skills/writing-helper/SKILL.md`, rawSkill,
    sha256: sha256(rawSkill), inspectedAt: '2026-11-06T00:00:00.000Z', license: { path: 'LICENSE', url: `${root}/LICENSE`, text: 'MIT License', sha256: sha256('MIT License') } };
const selection = { bundle, reviewedSha256: bundle.sha256, confirmedPromptOnly: true, confirmedLicense: true };
const skill = () => ({ name: 'skills.yaml', yaml: stringify({ apiVersion: '1.0', plugins: [
    ...['openai', 'google', 'ollama'].map(id => ({ module: `./src/platform/models/providers/${id}Plugin.ts` })),
    { module: './src/connectors/skill-workbench/setupPlugin.ts' }, { module: skillModule, config: { skills: [selection] } },
] }) });
const mcp = (personal = false) => ({ name: 'mcp.yaml', yaml: exportMcpProfile({ serverId: 'docs', url: 'https://mcp.example.com/mcp', tools: [{ name: 'read', alias: 'read' }], reviewedReadOnly: true, includePersonalWorkspace: personal }).yaml });
const openapiConfig = { serviceId: 'weather', reviewedReadOnly: true, source: { url: 'https://example.com/openapi.yaml', sha256: 'b'.repeat(64), openapi: '3.1.0', title: 'Public weather' },
    operations: [{ key: 'GET /weather', alias: 'read', method: 'GET', path: '/weather', summary: 'Read weather', parameters: [] as never[], serverUrl: 'https://api.example.com' }] };
const openapi = () => ({ name: 'openapi.yaml', yaml: stringify({ apiVersion: '1.0', base: 'personal', plugins: [
    { module: '../src/connectors/openapi/plugin.ts', config: openapiConfig }, { module: '../src/connectors/openapi/setup.ts' },
] }) });
const edit = (file: { name: string; yaml: string }, change: (profile: any) => void) => { const profile = parse(file.yaml); change(profile); return { ...file, yaml: stringify(profile, { aliasDuplicateObjects: false }) }; };

test('combines all three export kinds into canonical personal modules without changing Skill identities or grants', () => {
    const result = composeProfiles({ files: [skill(), mcp(), openapi()] }), document = parse(result.yaml);
    expect(result.filename).toBe('plugins.combined.personal.local.yaml'); expect(document.base).toBe('personal'); expect(document.plugins).toHaveLength(6);
    expect(new Set(document.plugins.map((entry: any) => entry.module)).size).toBe(6);
    expect(document.plugins.every((entry: any) => entry.module.startsWith('./src/'))).toBe(true);
    expect(document.plugins.some((entry: any) => /models|mcp-workbench\/plugin/.test(entry.module))).toBe(false);
    const config = document.plugins.find((entry: any) => entry.module === skillModule).config;
    expect(config).toEqual({ skills: [selection] });
    expect(preparePromptSkills(config)[0]!.skill.manifest.id).toBe(preparePromptSkills({ skills: [selection] })[0]!.skill.manifest.id);
    expect(document.plugins.find((entry: any) => entry.module.endsWith('mcp-workbench/runner.ts')).config.allowedTools).toEqual(['mcp.docs.read']);
    expect(document.plugins.find((entry: any) => entry.module.endsWith('openapi/plugin.ts')).config).toEqual(openapiConfig);
    expect(result.summary.map(item => item.kind)).toEqual(['Skill', 'MCP', 'OpenAPI']);
});

test('keeps legacy single Skill shape and accepts a personal MCP export without duplicating setup', () => {
    const file = edit(skill(), document => { document.plugins.at(-1).config = selection; });
    const document = parse(composeProfiles({ files: [file, mcp(true)] }).yaml);
    expect(preparePromptSkills(document.plugins[1].config)[0]!.skill.manifest.id).toBe('community.imported-prompt');
    expect(document.plugins).toHaveLength(4);
});

test('rejects duplicate kinds, unknown modules, mixed groups, incomplete profiles and helper config', () => {
    expect(() => composeProfiles({ files: [mcp(), mcp(true)] })).toThrow('一份 MCP');
    for (const module of ['/tmp/plugin.ts', 'https://example.com/plugin.ts', '@scope/plugin', '../src/connectors/../../evil.ts']) {
        expect(() => composeProfiles({ files: [edit(mcp(), document => { document.plugins[0].module = module; })] })).toThrow('不能导入其他模块');
    }
    for (const change of [
        (d: any) => { d.plugins.pop(); d.plugins.pop(); },
        (d: any) => { d.plugins.push(d.plugins[0]); },
        (d: any) => { d.plugins[2].config = { execute: 'do not run' }; },
        (d: any) => { d.plugins.push({ module: skillModule, config: selection }); },
        (d: any) => { d.base = 'team'; },
    ]) expect(() => composeProfiles({ files: [edit(mcp(), change)] })).toThrow();
});

test('rejects MCP grant expansion, duplicate grants, authentication and stdio', () => {
    for (const change of [
        (d: any) => { d.plugins[1].config.allowedTools = ['mcp.docs.other']; },
        (d: any) => { d.plugins[1].config.allowedTools.push('mcp.docs.other'); },
        (d: any) => { d.plugins[1].config.allowedTools.push('mcp.docs.read'); },
        (d: any) => { d.plugins[0].config.servers[0].tokenRef = 'env://PRIVATE_KEY'; },
        (d: any) => { const s = d.plugins[0].config.servers[0]; delete s.url; s.transport = 'stdio'; s.command = 'echo'; },
    ]) expect(() => composeProfiles({ files: [edit(mcp(), change)] })).toThrow();
});

test('validates original Skill content, license, review confirmations and OpenAPI read contracts', () => {
    for (const change of [
        (d: any) => { d.plugins.at(-1).config.skills[0].bundle.rawSkill += 'changed'; },
        (d: any) => { d.plugins.at(-1).config.skills[0].bundle.license.text += 'changed'; },
        (d: any) => { d.plugins.at(-1).config.skills[0].confirmedLicense = false; },
    ]) expect(() => composeProfiles({ files: [edit(skill(), change)] })).toThrow();
    for (const change of [
        (d: any) => { d.plugins[0].config.operations[0].method = 'POST'; },
        (d: any) => { d.plugins[0].config.operations[0].serverUrl = 'http://localhost'; },
        (d: any) => { d.plugins[1].config = { enabled: true }; },
    ]) expect(() => composeProfiles({ files: [edit(openapi(), change)] })).toThrow();
});

test('bounds bytes, YAML nesting, aliases, duplicate keys and unexpected fields', () => {
    for (const yaml of ['apiVersion: 1\napiVersion: 2', 'x: &x [1]\ny: *x', 'x: !custom value', 'x: ' + '['.repeat(42) + '0' + ']'.repeat(42), mcp().yaml + '\n---\n{}', '# ' + '中'.repeat(400000)]) {
        expect(() => composeProfiles({ files: [{ name: 'bad.yaml', yaml }] })).toThrow();
    }
    expect(() => composeProfiles({ files: [mcp()], extra: true })).toThrow();
    expect(() => composeProfiles({ files: [{ ...mcp(), name: '../private.yaml' }] })).toThrow();
});

test('composition API is plugin owned, local only, sanitizes schema failures and disappears on unload', async () => {
    const host = new AgentHost(() => ({ store: new InMemoryPersistentKeyValueStore(), config: buildConfig({}), feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [profileWorkbenchPlugin] });
    await host.initialize();
    try {
        const request = (body: unknown, origin = 'http://localhost') => new Request('http://localhost/api/plugin-profiles/compose', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(host.web.pages()[0]).toMatchObject({ path: '/plugin-profiles', navigation: false });
        expect((await host.web.handle(request({ files: [mcp()] }))).status).toBe(200);
        expect((await host.web.handle(request({ files: [mcp()] }, 'https://external.example'))).status).toBe(403);
        const bad = await host.web.handle(request({ files: [edit(mcp(), d => { d.plugins[0].config.secret = 'DO_NOT_ECHO'; })] }));
        expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('DO_NOT_ECHO');
        expect(await host.listAgents()).toEqual([]);
    } finally { await host.stop(); }
    expect((await host.web.handle(new Request('http://localhost/api/plugin-profiles/compose', { method: 'POST' }))).status).toBe(404);
});

test('trusted request limit can increase without weakening the default, streamed limit or cancellation', async () => {
    const body = JSON.stringify({ content: 'x'.repeat(18000) });
    await expect(readSmallJsonBody(new Request('http://localhost', { method: 'POST', body }))).rejects.toThrow('16 KiB');
    expect(await readSmallJsonBody(new Request('http://localhost', { method: 'POST', body }), 32768)).toEqual(JSON.parse(body));
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33000)); }, cancel() { cancelled = true; } });
    await expect(readSmallJsonBody(new Request('http://localhost', { method: 'POST', body: stream }), 32768)).rejects.toThrow('32 KiB');
    expect(cancelled).toBe(true);
});

test('downloaded canonical output loads with the real personal preset and retains installed Skill catalog and knowledge', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'profile-composer-'));
    const file = path.resolve(import.meta.dir, `../plugins.composer-${randomUUID()}.local.yaml`);
    const keys = ['KNOWLEDGE_KIND', 'RELEASE_GITHUB_REPOSITORY'], before = keys.map(key => process.env[key]);
    let host: AgentHost | undefined;
    try {
        for (const key of keys) delete process.env[key];
        const result = composeProfiles({ files: [skill(), openapi()] }); await writeFile(file, result.yaml);
        const selected = await loadWorkspacePlugins(directory, file);
        expect(selected.base).toBe('personal'); expect(selected.plugins).toHaveLength(19);
        expect(selected.plugins.filter(plugin => plugin.manifest.id === 'mcp.setup')).toHaveLength(1);
        host = new AgentHost(() => ({ store: new InMemoryPersistentKeyValueStore(), config: { ...buildConfig({}), data_path: directory }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
        await host.initialize(); expect(await host.listAgents()).toHaveLength(13);
        expect(host.web.pages().map(page => page.path)).toEqual(expect.arrayContaining(['/plugin-profiles', '/skill-runner', '/openapi-runner', '/knowledge']));
        const catalog = await host.web.handle(new Request('http://localhost/api/skill-runner/skills'));
        expect(catalog.status).toBe(200); expect(await catalog.text()).toContain(bundle.sha256);
        const knowledge = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API 迁移说明', limit: 5 }, randomUUID());
        expect(knowledge.execution?.run.status).toBe('succeeded');
        expect(host.canDispatch('delivery.ops.orchestrate')).toBe(false);
    } finally {
        await host?.stop(); await rm(file, { force: true }); await rm(directory, { recursive: true, force: true });
        keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
    }
});
