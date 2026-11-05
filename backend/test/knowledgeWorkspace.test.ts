import { expect, test } from 'bun:test';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createPluginApi } from '@/platform/workspace/api';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { createKnowledgeWebPlugin } from '@/knowledge/web/plugin';
import { createKnowledgeWorkspacePlugin, knowledgeWorkspacePlugin } from '@/knowledge/workspace/plugin';
import { knowledgeWebWorkspacePlugin } from '@/knowledge/workspace/webPlugin';
import { buildConfig } from '@/core/config';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';

const config = buildConfig({});
const context = () => ({ store: new InMemoryPersistentKeyValueStore(), config, feishu: {}, tapd: {}, intentParser: {} } as any);
const pluginConfig = { 'knowledge.markdown': { root: path.join(import.meta.dir, '../examples/knowledge-vault') }, 'knowledge.web': { urls: ['https://example.com/rules'] } };
const sources = () => [createKnowledgeWebPlugin(async () => ({ url: 'https://example.com/rules', body: Buffer.from('# Web-only fixture\nAPI migration policy.'), contentType: 'text/markdown' })), knowledgeMarkdownPlugin];
const request = (method = 'GET', suffix = '', origin = 'http://localhost:15173') => new Request(`http://localhost/api/knowledge-workspace${suffix}`, { method, headers: { origin } });

for (const kind of ['markdown', 'web'] as const) test(`knowledge workspace explicitly selects ${kind} even when both source plugins are installed`, async () => {
    const host = new AgentHost(context, 1000, undefined, [], { plugins: [createKnowledgeWorkspacePlugin(kind), ...sources()], pluginConfig });
    try {
        await host.initialize();
        const app = createPluginApi(host), response = await app.handle(request());
        expect(response.status).toBe(200);
        const selected = await response.json() as any;
        expect(selected).toEqual({ kind, pluginId: `knowledge.${kind}`, capability: `knowledge.${kind}.retrieve` });
        expect(host.web.pages()).toEqual([{ path: '/knowledge', label: '知识库', section: 'workspace', view: { kind: 'builtin', id: 'knowledge' } }]);
        const result = await host.runLocal(selected.capability, { operation: 'search', query: 'API', limit: 5 }, crypto.randomUUID());
        expect(result.execution!.run.status).toBe('succeeded');
        const data = result.execution!.result.data as any;
        expect(data.hits.length).toBeGreaterThan(0);
        if (kind === 'web') expect(data.hits[0].path).toBe('https://example.com/rules');
        else expect(data.hits[0].path).toEndWith('.md');
        expect(JSON.stringify(selected)).not.toContain(pluginConfig['knowledge.markdown'].root);
        expect((await app.handle(request('POST'))).status).toBe(404);
        expect((await app.handle(request('GET', '/unknown'))).status).toBe(404);
        expect((await app.handle(request('GET', '', 'https://foreign.example'))).status).toBe(403);
    } finally { await host.stop(); }
    expect(host.web.pages()).toEqual([]);
    expect((await host.handlePluginRequest(request())).status).toBe(503);
});

test('knowledge UI is independently removable and dependencies are checked before assembly', async () => {
    const sourceOnly = new AgentHost(context, 1000, undefined, [], { plugins: sources(), pluginConfig });
    const empty = new AgentHost(context), missing = new AgentHost(context, 1000, undefined, [], { plugins: [knowledgeWorkspacePlugin] });
    try {
        await sourceOnly.initialize(); await empty.initialize();
        expect(sourceOnly.canDispatch('knowledge.markdown.retrieve')).toBe(true);
        expect(sourceOnly.web.pages()).toEqual([]);
        expect((await createPluginApi(sourceOnly).handle(request())).status).toBe(404);
        expect((await createPluginApi(empty).handle(request())).status).toBe(404);
        await expect(missing.initialize()).rejects.toThrow('knowledge.markdown');
        expect(missing.web.pages()).toEqual([]);
        expect(knowledgeWebWorkspacePlugin.manifest.requires).toEqual(['knowledge.web']);
        expect(createKnowledgeWorkspacePlugin('sample').manifest.requires).toEqual(['knowledge.markdown']);
        expect(() => createKnowledgeWorkspacePlugin('unknown' as any)).toThrow();
    } finally { await sourceOnly.stop(); await empty.stop(); await missing.stop(); }
});

test('the shipped local knowledge profile loads source and UI without model or messaging plugins', async () => {
    const selected = await loadPluginConfiguration(path.join(import.meta.dir, '../examples/plugins.knowledge-workspace.yaml'));
    expect(selected.plugins.map(plugin => plugin.manifest.id)).toEqual(['knowledge.markdown', 'knowledge.workspace']);
    const host = new AgentHost(context, 1000, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
    try {
        await host.initialize();
        expect((await createPluginApi(host).handle(request())).status).toBe(200);
        const result = await host.runLocal('knowledge.markdown.retrieve', { operation: 'search', query: '迁移', limit: 5 }, crypto.randomUUID());
        expect(result.execution!.run.status).toBe('succeeded');
    } finally { await host.stop(); }
});
