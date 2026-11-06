import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { buildConfig } from '@/core/config';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { createSkillSetupPlugin } from '@/connectors/skill-workbench/setupPlugin';
import { exportSkillProfile, readInspection, INSPECT_CAPABILITY, RUN_CAPABILITY } from '@/connectors/skill-workbench/service';
import { readKnowledgeContext, modelKnowledge } from '@/connectors/skill-workbench/knowledgeContext';
import { createTriggerEnvelope, createTriggerScope, DEFAULT_WORKSPACE_ID, DEFAULT_BOT_INSTANCE_ID } from '@/platform/runtime/scope';
import type { WebTransport } from '@/knowledge/web/network';

const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
const keys = ['KNOWLEDGE_KIND', 'KNOWLEDGE_ROOT', 'KNOWLEDGE_VAULT_NAME', 'KNOWLEDGE_EXCLUDE', 'RELEASE_GITHUB_REPOSITORY'];
let saved: Record<string, string | undefined>, directory: string, profileFile: string;
beforeEach(async () => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]])); for (const key of keys) delete process.env[key];
    directory = await mkdtemp(path.join(tmpdir(), 'skill-knowledge-'));
    profileFile = path.resolve(import.meta.dir, '..', `plugins.skill-knowledge-${randomUUID()}.local.yaml`);
    process.env.KNOWLEDGE_KIND = 'markdown'; process.env.KNOWLEDGE_ROOT = path.join(directory, 'vault'); process.env.KNOWLEDGE_VAULT_NAME = 'PRIVATE_VAULT_NAME_NOT_FOR_MODEL';
    await mkdir(process.env.KNOWLEDGE_ROOT);
    await writeFile(path.join(process.env.KNOWLEDGE_ROOT, 'Release.md'), '# Release Rules\n\nFor API migration, include migration notes and rollback steps.\n');
    await writeFile(path.join(process.env.KNOWLEDGE_ROOT, 'Other.md'), '# Other Material\n\nUNSELECTED_PRIVATE_MARKER stays local.\n');
});
afterEach(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(profileFile, { force: true }); await rm(directory, { recursive: true, force: true });
});

async function fixture() {
    const store = new InMemoryPersistentKeyValueStore(), config = { ...buildConfig({}), data_path: path.join(directory, 'data') };
    const context = { store, config, feishu: {}, tapd: {}, intentParser: {} } as any;
    const transport: WebTransport = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: async target => ({ status: 200, headers: {}, body: Buffer.from(target.hostname === 'api.github.com' ? 'a'.repeat(40) : target.pathname.endsWith('/SKILL.md') ? '---\nname: writing-helper\ndescription: A controlled writing fixture\nlicense: MIT\n---\nSKILL_METHOD_MARKER: turn supplied information into a short checklist.\n' : 'MIT fixture license') }) };
    const inspector = new AgentHost(() => context, 1000, undefined, [], { plugins: [createSkillSetupPlugin(transport)] });
    let inspectionId: string, digest: string;
    try {
        const inspected = await inspector.runLocal(INSPECT_CAPABILITY, { url: 'https://github.com/example/skills/blob/main/skills/writing-helper/SKILL.md' }, randomUUID());
        inspectionId = inspected.execution!.run.id; digest = (await readInspection(store, scope, inspectionId)).bundle.sha256;
    } finally { await inspector.stop(); }
    const profile = await exportSkillProfile(store, scope, { inspectionRunId: inspectionId!, reviewedSha256: digest!, confirmedPromptOnly: true, confirmedLicense: true, includePersonalWorkspace: true });
    expect(profile.filename).toBe('plugins.skills-personal.local.yaml');
    const yaml = parseYaml(profile.yaml); expect(yaml.base).toBe('personal'); expect(yaml.plugins).toHaveLength(2); expect(profile.yaml).not.toContain(directory);
    await writeFile(profileFile, profile.yaml, { flag: 'wx' });
    await expect(loadPluginConfiguration(profileFile)).rejects.toThrow('本机工作台');
    const selection = await loadWorkspacePlugins(config.data_path, profileFile); expect(selection.plugins).toHaveLength(18);
    const requests: any[] = []; let mode = 'success', entered!: () => void, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const body = await request.json(); requests.push(body);
        if (mode === 'failure') return new Response('controlled failure', { status: 400 });
        if (mode === 'slow') { entered(); await pending; }
        return Response.json({ id: 'knowledge-skill-fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Protocol fixture: checklist text; facts and citations are unverified.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } });
    } });
    const activeContext = { ...context, config: { ...config, ai: { provider: 'openai', model: 'fixture', api_key: 'fixture-key', api_base: `http://127.0.0.1:${server.port}/v1` } } };
    const host = new AgentHost(() => activeContext, 1000, undefined, [], { plugins: selection.plugins, pluginConfig: selection.config });
    await host.initialize(); expect(await host.listAgents()).toHaveLength(11);
    const source = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'API migration', limit: 5 }, randomUUID());
    const sourceId = source.execution!.run.id, preview = await readKnowledgeContext(store, scope, sourceId);
    const input = { prompt: 'Write a release checklist using these excerpts.', knowledge: { runId: sourceId, sha256: preview.sha256, confirmed: true } };
    return { host, store, preview, sourceId, input, requests, started, setMode(value: string) { mode = value; }, async stop() { release(); await host.stop(); server.stop(true); } };
}

test('a personal-base Skill uses an explicitly bound historical snapshot and saves accurate selection provenance', async () => {
    const f = await fixture();
    try {
        const before = JSON.stringify(await new PersistentAgentRunStore(f.store).listArtifacts(f.sourceId));
        await writeFile(path.join(process.env.KNOWLEDGE_ROOT!, 'Release.md'), '# Release Rules\n\nAPI migration CURRENT_FILE_CHANGED_AFTER_PREVIEW.\n');
        expect((await readKnowledgeContext(f.store, scope, f.sourceId)).sha256).toBe(f.preview.sha256);
        expect((await f.host.web.handle(new Request('http://localhost/api/skill-runner/context?runId=' + f.sourceId))).status).toBe(200);
        const result = await f.host.runLocal(RUN_CAPABILITY, f.input, randomUUID()); expect(result.execution!.run.status).toBe('succeeded'); expect(f.requests).toHaveLength(1);
        const body = f.requests[0], allMessages = JSON.stringify(body.messages), payload = JSON.parse(body.messages.find((message: any) => message.role === 'user').content);
        expect(allMessages).toContain('SKILL_METHOD_MARKER'); expect(allMessages).toContain('migration notes and rollback steps');
        for (const excluded of [directory, 'PRIVATE_VAULT_NAME_NOT_FOR_MODEL', 'obsidian://', 'UNSELECTED_PRIVATE_MARKER', 'CURRENT_FILE_CHANGED_AFTER_PREVIEW']) expect(allMessages).not.toContain(excluded);
        expect(payload.knowledge).toEqual(modelKnowledge(f.preview)); expect(payload.knowledge.evidence[0].path).toBeUndefined();
        const detail = (await f.host.getLocalRunDetails(result.execution!.run.id))!;
        expect(detail.artifacts).toHaveLength(3); expect(detail.steps.map(step => step.kind).sort()).toEqual(['agent', 'guardrail', 'model', 'skill']);
        const selected = detail.artifacts.find(artifact => artifact.metadata.artifactRole === 'skill.knowledge.context')!;
        expect((selected.content as any).sha256).toBe(f.preview.sha256);
        expect((selected.content as any).verification).toEqual({ modelReceived: 'not_verified', sourceUsage: 'not_verified', answerCitations: 'not_verified', sourceCurrentness: 'not_checked' });
        expect((detail.artifacts.find(artifact => artifact.type === 'markdown')!.metadata.knowledgeContext as any)).toMatchObject({ sourceRunId: f.sourceId, sha256: f.preview.sha256, selectionArtifactId: selected.id });
        expect(JSON.stringify(await new PersistentAgentRunStore(f.store).listArtifacts(f.sourceId))).toBe(before);
        expect(result.execution!.result.metrics).toMatchObject({ modelCalls: 1, toolCalls: 0 });
    } finally { await f.stop(); }
});

test('unconfirmed, changed, foreign, empty and delegated snapshot requests fail before model calls', async () => {
    const f = await fixture(), runs = new PersistentAgentRunStore(f.store);
    try {
        for (const knowledge of [{ ...f.input.knowledge, confirmed: false }, { ...f.input.knowledge, sha256: '0'.repeat(64) }, { ...f.input.knowledge, injectedEvidence: ['not accepted'] }]) expect((await f.host.runLocal(RUN_CAPABILITY, { ...f.input, knowledge }, randomUUID())).execution!.run.status).toBe('failed');
        const foreignId = randomUUID(); await runs.create({ ...(await runs.get(f.sourceId))!, id: foreignId, rootRunId: foreignId, workspaceId: 'foreign' });
        let artifactReads = 0; const list = f.store.listIdempotencyEntries.bind(f.store);
        f.store.listIdempotencyEntries = async prefix => { if (prefix.startsWith('agent:artifact:')) artifactReads++; return list(prefix) as any; };
        await expect(readKnowledgeContext(f.store, scope, foreignId)).rejects.toThrow('当前范围'); expect(artifactReads).toBe(0);
        const empty = await f.host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: 'nonexistentkeywordxyz', limit: 5 }, randomUUID());
        await expect(readKnowledgeContext(f.store, scope, empty.execution!.run.id)).rejects.toThrow('没有可用片段');
        const trigger = createTriggerEnvelope({ occurredAt: new Date().toISOString(), scope: createTriggerScope({ ...scope, triggerType: 'agent', triggerId: randomUUID() }), payload: {}, replyPolicy: { mode: 'none' } });
        expect((await f.host.dispatch(trigger, RUN_CAPABILITY, f.input)).execution!.run.status).toBe('failed');
        expect((await f.host.web.handle(new Request('http://localhost/api/skill-runner/context?runId=' + f.sourceId, { headers: { origin: 'https://foreign.test' } }))).status).toBe(403);
        expect((await f.host.web.handle(new Request('http://localhost/api/skill-runner/context?runId=' + f.sourceId + '&extra=1'))).status).toBe(404);
        expect(f.requests).toEqual([]);
        const original = (await runs.listArtifacts(f.sourceId))[0]!;
        await runs.saveArtifacts([{ ...original, content: { ...(original.content as any), hits: [{ ...(original.content as any).hits[0], excerpt: 'changed stored excerpt' }] } }]);
        expect((await f.host.runLocal(RUN_CAPABILITY, f.input, randomUUID())).execution!.run.status).toBe('failed'); expect(f.requests).toEqual([]);
    } finally { await f.stop(); }
});

test('failure and cancellation retain selected context without publishing a generated text result', async () => {
    const f = await fixture();
    try {
        f.setMode('failure');
        const failed = await f.host.runLocal(RUN_CAPABILITY, f.input, randomUUID()); expect(failed.execution!.run.status).toBe('failed');
        const failedDetails = (await f.host.getLocalRunDetails(failed.execution!.run.id))!;
        expect(failedDetails.artifacts.map(artifact => artifact.metadata.artifactRole)).toEqual(['skill.knowledge.context']);
        f.setMode('slow'); const receipt = await f.host.startLocal(RUN_CAPABILITY, f.input, randomUUID()); await f.started;
        expect((await f.host.cancelLocal(receipt.runId))?.requested).toBe(true);
        for (let i = 0; i < 100 && (await f.host.getLocalRunDetails(receipt.runId))?.run.status === 'running'; i++) await Bun.sleep(1);
        const cancelled = (await f.host.getLocalRunDetails(receipt.runId))!;
        expect(cancelled.run.status).toBe('cancelled'); expect(cancelled.artifacts.map(artifact => artifact.metadata.artifactRole)).toEqual(['skill.knowledge.context']);
    } finally { await f.stop(); }
});
