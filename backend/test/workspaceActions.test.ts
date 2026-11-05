import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildConfig } from '@/core/config';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { LocalConnections } from '@/platform/workspace/connections';
import { workspaceKnowledge } from '@/platform/workspace/knowledge';
import { createWorkspaceApi } from '@/platform/workspace/api';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import type { AgentRun } from '@/platform/agents/contracts';
import { echoPlugin } from '../examples/plugins/echo';

let directory: string;
let environment: Record<string, string | undefined>;
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'workspace-actions-'));
    environment = Object.fromEntries(['KNOWLEDGE_KIND', 'KNOWLEDGE_ROOT'].map(key => [key, process.env[key]]));
    process.env.KNOWLEDGE_KIND = 'markdown'; process.env.KNOWLEDGE_ROOT = directory;
});
afterEach(async () => {
    for (const [key, value] of Object.entries(environment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
});

function fixture(host: AgentHost, store: InMemoryPersistentKeyValueStore) {
    const connections = new LocalConnections(path.join(directory, 'connections.json'));
    const app = createWorkspaceApi(host, connections, () => buildConfig({}));
    const request = (url: string, body?: unknown) => app.handle(new Request(`http://localhost/api/workspace${url}`, body === undefined ? undefined : {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:15173' }, body: JSON.stringify(body),
    }));
    return { request, runs: new PersistentAgentRunStore(store) };
}

test('a third-party plugin contributes a scoped action that executes through the normal Agent Runtime', async () => {
    const store = new InMemoryPersistentKeyValueStore(), config = buildConfig({});
    let stateUnavailable = false;
    const plugin = { ...echoPlugin, apply(ctx: Parameters<typeof echoPlugin.apply>[0], cfg: Record<string, unknown>) {
        echoPlugin.apply(ctx, cfg);
        ctx.delivery.runActions.register({ id: 'example.review', label: 'Review', capability: 'example.echo', appliesTo: ['example.echo'], input: runId => ({ text: runId }),
            readState: () => { if (stateUnavailable) throw new Error('private failure detail'); return { schemaVersion: '1.0', tone: 'neutral', title: 'Ready' }; },
        });
    } };
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [plugin] });
    const { request, runs } = fixture(host, store);
    try {
        const first = await host.runLocal('example.echo', { text: 'original' }, randomUUID());
        const target = first.execution!.run.id;
        const before = await runs.listArtifacts(target);
        const listing = await (await request(`/runs/${target}/actions`)).json() as any;
        expect(listing.actions).toHaveLength(1); expect(listing.actions[0]).toMatchObject({ id: 'example.review', label: 'Review', available: true, panel: { title: 'Ready' } });
        stateUnavailable = true;
        const unavailable = await (await request(`/runs/${target}/actions`)).json() as any;
        expect(unavailable.actions[0].panel).toMatchObject({ tone: 'error', title: '动作状态暂不可用' });
        expect(JSON.stringify(unavailable)).not.toContain('private failure detail');
        stateUnavailable = false;
        const triggerId = randomUUID();
        const result = await (await request(`/runs/${target}/actions/example.review`, { triggerId })).json() as any;
        expect(result.status).toBe('succeeded');
        expect((await runs.listArtifacts(result.runId))[0]!.content).toBe(target);
        const repeated = await (await request(`/runs/${target}/actions/example.review`, { triggerId })).json() as any;
        expect(repeated.runId).toBe(result.runId); expect(repeated.status).toBe('duplicate');
        expect(await runs.listArtifacts(target)).toEqual(before);
        const forbidden = { ...first.execution!.run, id: randomUUID(), workspaceId: 'foreign' }; await runs.create(forbidden);
        expect((await request(`/runs/${forbidden.id}/actions`)).status).toBe(404);
        expect((await request(`/runs/${forbidden.id}/actions/example.review`, {})).status).toBe(400);
        expect((await request(`/runs/${target}/actions/example.review`, { input: { text: 'override' } })).status).toBe(400);
        expect((await request(`/runs/${target}/actions/unknown`, {})).status).toBe(400);
        const another = await host.runLocal('example.echo', { text: 'another' }, randomUUID());
        const second = await (await request(`/runs/${another.execution!.run.id}/actions/example.review`, { triggerId })).json() as any;
        expect(second.runId).not.toBe(result.runId);
    } finally { await host.stop(); }
});

test('the knowledge action reads cached assessments without new runs and rechecks changed citations without rewriting original evidence', async () => {
    const note = path.join(directory, 'Rules.md'); await writeFile(note, '# Rules\nAPI 发布必须提供迁移说明。\n');
    const store = new InMemoryPersistentKeyValueStore(), config = { ...buildConfig({}), data_path: directory }, selected = workspaceKnowledge(directory);
    const host = new AgentHost(() => ({ store, config, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
    const { request, runs } = fixture(host, store);
    await host.initialize();
    try {
        const evidence = (await new MarkdownKnowledgeSource({ root: directory, sourceId: 'workspace-notes' }).search('API 迁移说明')).hits;
        const target: AgentRun = { id: randomUUID(), workspaceId: 'workspace-default', botInstanceId: 'bot-default', agentInstallationId: 'install-knowledge-answer', capability: 'knowledge.answer', triggerId: 'fixture', correlationId: randomUUID(), rootRunId: '', depth: 0, status: 'succeeded', createdAt: new Date().toISOString() };
        target.rootRunId = target.id; await runs.create(target);
        await runs.saveArtifacts([{ id: randomUUID(), runId: target.id, createdAt: target.createdAt, type: 'json', mediaType: 'application/json', schemaVersion: '1.0', metadata: { privateKnowledge: true },
            content: { status: 'answered', evidence, claims: [{ text: '需要迁移说明', citations: [{ citationId: evidence[0]!.citationId, quote: '必须提供迁移说明' }] }] },
        }]);
        const before = await runs.listArtifacts(target.id);
        const actions = async () => (await (await request(`/runs/${target.id}/actions`)).json() as any).actions;
        expect((await actions())[0].panel.title).toBe('知识引用尚未检查');
        const runCount = (await host.listLocalRuns()).length;
        await actions(); await actions(); expect((await host.listLocalRuns()).length).toBe(runCount);
        const checked = await (await request(`/runs/${target.id}/actions/knowledge.review`, {})).json() as any;
        expect(checked.status).toBe('succeeded');
        const current = (await actions())[0].panel;
        expect(current).toMatchObject({ tone: 'success', title: '知识引用版本未变化', relatedRun: { id: checked.runId } });
        expect(current.checkedAt).toBeDefined();
        await writeFile(note, '# Rules\nAPI 发布必须提供升级清单和回滚步骤。\n');
        expect((await actions())[0].panel).toEqual(current);
        const changed = await (await request(`/runs/${target.id}/actions/knowledge.review`, {})).json() as any;
        expect(changed.status).toBe('succeeded');
        expect((await actions())[0].panel).toMatchObject({ tone: 'warning', title: '知识引用需要复核', items: [{ label: 'Rules.md', value: '内容已变化' }] });
        const report = (await runs.listArtifacts(changed.runId))[0]!;
        expect(report.metadata.statusPanels).toMatchObject([{ title: '知识引用需要复核', relatedRun: { id: target.id, label: '返回原结果' } }]);
        expect(await runs.listArtifacts(target.id)).toEqual(before);
    } finally { await host.stop(); }
});
