import { describe, expect, test } from 'bun:test';
import { writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { parseAgentSkill } from '@/platform/skills/packageLoader';
import { standardModelPlugins } from '@/platform/models/providers';
import type { WebTransport } from '@/knowledge/web/network';
import { inspectSkill, validateBundle, parseSkillUrl, grants, PROMPT_SKILL } from '@/connectors/skill-workbench/source';
import { createSkillSetupPlugin } from '@/connectors/skill-workbench/setupPlugin';
import { promptSkillPlugin } from '@/connectors/skill-workbench/promptPlugin';
import { exportSkillProfile, INSPECT_CAPABILITY, RUN_CAPABILITY, readInspection } from '@/connectors/skill-workbench/service';

const url = 'https://github.com/example/skills/blob/main/skills/writing-helper/SKILL.md', commit = 'a'.repeat(40);
const text = '---\nname: writing-helper\ndescription: Controlled fixture for concise text\nlicense: MIT\nallowed-tools: Bash Read\ncompatibility: May mention other tools\n---\nUse the phrase FIXTURE_SKILL_APPLIED in the generated text.\n';
const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
function fixture() {
    const requests: string[] = [];
    const transport: WebTransport = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], async request(target) {
        requests.push(target.href);
        const content = target.hostname === 'api.github.com' ? commit : target.pathname.endsWith('/SKILL.md') ? text : 'MIT License\nCopyright Test fixture\n';
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(content) };
    } };
    return { transport, requests };
}
function hostFor(plugins: any[], pluginConfig: Record<string, Record<string, unknown>> = {}, ai: any = {}) {
    const store = new InMemoryPersistentKeyValueStore(), host = new AgentHost(() => ({ store, config: { feishu: { app_id: '', bot_name: 'test' }, ai }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins, pluginConfig });
    return { store, host };
}
describe('reviewed GitHub prompt Skills', () => {
    test('pins a branch and preserves declarations without granting upstream tools', async () => {
        const { transport, requests } = fixture(), bundle = await inspectSkill(url, new AbortController().signal, transport), { skill } = validateBundle(bundle);
        expect(bundle.commit).toBe(commit); expect(bundle.rawUrl).toContain('/' + commit + '/'); expect(requests).toHaveLength(3);
        expect(skill.manifest.allowedTools).toEqual([]); expect(skill.manifest.maxToolCalls).toBe(0); expect(skill.declarations.allowedTools).toBe('Bash Read'); expect(skill.declarations.license).toBe('MIT');
        expect(bundle.license!.text).toContain('Copyright Test fixture');
        expect(() => validateBundle({ ...bundle, rawSkill: text + 'tampered' })).toThrow();
        expect(() => validateBundle({ ...bundle, commit: 'b'.repeat(40) })).toThrow();
        expect(() => parseAgentSkill(text, 'different-name', grants)).toThrow('directory');
        expect(() => parseAgentSkill('---\nname: x\n---\nbody', 'x', grants)).toThrow();
    });
    test('rejects unsupported URLs before networking and enforces cancellation, DNS, redirects and byte limits', async () => {
        const { transport, requests } = fixture();
        for (const target of ['http://github.com/example/skills/blob/main/skills/writing-helper/SKILL.md', url + '?token=secret', url.replace('github.com', 'github.com.evil.test'), url.replace('/main/', '/main/../'), url.replace('/skills/writing-helper/', '/skills/%2e%2e/'), url.replace('/blob/', '/tree/')]) expect(() => parseSkillUrl(target)).toThrow();
        await expect(inspectSkill(url, AbortSignal.abort(), transport)).rejects.toThrow(); expect(requests).toHaveLength(0);
        await expect(inspectSkill(url, new AbortController().signal, { ...transport, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toThrow('public'); expect(requests).toHaveLength(0);
        let redirects = 0;
        await expect(inspectSkill(url, new AbortController().signal, { ...transport, request: async () => { redirects++; return { status: 302, headers: { location: 'https://other.example/skill' }, body: Buffer.alloc(0) }; } })).rejects.toThrow('来源'); expect(redirects).toBe(1);
        await expect(inspectSkill(url.replace('/main/', '/' + commit + '/'), new AbortController().signal, { ...transport, request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(128 * 1024 + 1) }) })).rejects.toThrow('budget');
    });
    test('unavailable licenses remain missing and invalid commit responses fail', async () => {
        const { transport } = fixture();
        const bundle = await inspectSkill(url, new AbortController().signal, { ...transport, request: async (...args) => { if (args[0].pathname.endsWith('/LICENSE')) throw new Error('Unavailable'); return transport.request(...args); } });
        expect(bundle.license).toBeNull();
        await expect(inspectSkill(url, new AbortController().signal, { ...transport, request: async () => ({ status: 200, headers: {}, body: Buffer.from('not a full SHA') }) })).rejects.toThrow('SHA');
    });
    test('exports only reviewed stored content and checks ownership before reading artifacts', async () => {
        const { transport, requests } = fixture(), { host, store } = hostFor([createSkillSetupPlugin(transport)]);
        try {
            await host.initialize(); const outcome = await host.runLocal(INSPECT_CAPABILITY, { url }, crypto.randomUUID()), id = outcome.execution!.run.id;
            expect(outcome.execution!.run.status).toBe('succeeded'); const { bundle } = await readInspection(store, scope, id); const count = requests.length;
            const profile = await exportSkillProfile(store, scope, { inspectionRunId: id, reviewedSha256: bundle.sha256, confirmedPromptOnly: true, confirmedLicense: true });
            const yaml = parseYaml(profile.yaml); expect(yaml.plugins).toHaveLength(5); expect(yaml.plugins[4].config.bundle.rawSkill).toBe(text); expect(requests).toHaveLength(count);
            await expect(exportSkillProfile(store, scope, { inspectionRunId: id, reviewedSha256: '0'.repeat(64), confirmedPromptOnly: true, confirmedLicense: true })).rejects.toThrow('指纹');
            await expect(exportSkillProfile(store, scope, { inspectionRunId: id, reviewedSha256: bundle.sha256, confirmedPromptOnly: true, confirmedLicense: false })).rejects.toThrow();
            let readArtifacts = 0; const list = store.listIdempotencyEntries.bind(store);
            store.listIdempotencyEntries = async prefix => { if (prefix.startsWith('agent:artifact:')) readArtifacts++; return list(prefix) as any; };
            await expect(readInspection(store, { ...scope, botInstanceId: 'foreign' }, id)).rejects.toThrow(); expect(readArtifacts).toBe(0);
            const response = await host.web.handle(new Request('http://localhost/api/skill-setup/inspection?runId=' + id)); expect(response.status).toBe(200);
        } finally { await host.stop(); }
        expect((await host.web.handle(new Request('http://localhost/api/skill-setup/inspection?runId=' + crypto.randomUUID()))).status).toBe(404);
    });
    test('exported local profile invokes the actual host Skill Runtime and model protocol', async () => {
        const { transport } = fixture(), bundle = await inspectSkill(url, new AbortController().signal, transport), inspector = hostFor([createSkillSetupPlugin(transport)]);
        let filename = '', requests = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { requests++; const body = await request.json() as any;
            expect(body.messages.some((message: any) => message.content.includes('FIXTURE_SKILL_APPLIED'))).toBe(true);
            expect(body.messages.some((message: any) => message.content.includes('用户任务'))).toBe(true);
            expect((body.tools || []).some((tool: any) => /Bash|Read/.test(tool.function.name))).toBe(false);
            return Response.json({ id: 'skill-protocol-fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'FIXTURE_SKILL_APPLIED：这只是受控协议文本。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } });
        } });
        let runner: AgentHost | undefined;
        try {
            await inspector.host.initialize(); const result = await inspector.host.runLocal(INSPECT_CAPABILITY, { url }, crypto.randomUUID());
            const profile = await exportSkillProfile(inspector.store, scope, { inspectionRunId: result.execution!.run.id, reviewedSha256: bundle.sha256, confirmedPromptOnly: true, confirmedLicense: true });
            filename = path.resolve(import.meta.dir, '..', `plugins.skill-test-${crypto.randomUUID()}.local.yaml`); await writeFile(filename, profile.yaml, { flag: 'wx' });
            const selection = await loadPluginConfiguration(filename), fixtureHost = hostFor(selection.plugins as any[], selection.config, { provider: 'openai', model: 'fixture', api_key: 'skill-test-key', api_base: `http://127.0.0.1:${server.port}/v1` }); runner = fixtureHost.host;
            await runner.initialize(); const executed = await runner.runLocal(RUN_CAPABILITY, { prompt: '用户任务：请整理一句建议。' }, crypto.randomUUID()), detail = (await runner.getLocalRunDetails(executed.execution!.run.id))!;
            expect(detail.run.status).toBe('succeeded'); expect(requests).toBe(1); expect(detail.steps.filter(step => step.kind === 'skill' && step.name === PROMPT_SKILL && step.status === 'succeeded')).toHaveLength(1);
            expect(detail.steps.find(step => step.kind === 'skill')!.metadata!.instructionsSha256).toBe((detail.artifacts[0]!.metadata!.upstreamSkill as any).instructionsSha256);
            expect(detail.steps.filter(step => step.kind === 'model')).toHaveLength(1); expect(executed.execution!.result.metrics).toMatchObject({ modelCalls: 1, toolCalls: 0 });
            expect(detail.artifacts.find(artifact => artifact.type === 'markdown')!.metadata?.statusPanels).toBeUndefined();
            expect(detail.artifacts.find(artifact => artifact.type === 'json')!.metadata?.statusPanels).toBeDefined();
            expect(detail.artifacts.find(artifact => artifact.type === 'markdown')!.metadata).toMatchObject({ privateKnowledge: true, upstreamSkill: { sha256: bundle.sha256, commit } });
            expect(await runner.listSkills()).toHaveLength(1);
        } finally { await runner?.stop(); await inspector.host.stop(); server.stop(true); if (filename) await rm(filename, { force: true }); }
        expect(runner!.skillRegistry.list()).toHaveLength(0);
    });
    test('missing models fail and mismatched review rolls back contributions', async () => {
        const { transport } = fixture(), bundle = await inspectSkill(url, new AbortController().signal, transport), config = { bundle, reviewedSha256: bundle.sha256, confirmedPromptOnly: true, confirmedLicense: true };
        const good = hostFor([promptSkillPlugin], { 'skills.prompt': config });
        try { await good.host.initialize(); const result = await good.host.runLocal(RUN_CAPABILITY, { prompt: 'test' }, crypto.randomUUID()); expect(result.execution!.run.status).toBe('failed'); } finally { await good.host.stop(); }
        const bad = hostFor([promptSkillPlugin, ...standardModelPlugins], { 'skills.prompt': { ...config, reviewedSha256: '0'.repeat(64) } });
        await expect(bad.host.initialize()).rejects.toThrow('指纹'); expect(bad.host.skillRegistry.list()).toHaveLength(0); expect(bad.host.web.pages()).toHaveLength(0); await bad.host.stop();
    });
});
