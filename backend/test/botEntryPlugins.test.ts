import { expect, test } from 'bun:test';
import { buildConfig } from '@/core/config';
import { aiNewsPlugin } from '@/agents/plugins/aiNews';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { FeishuBotMessageIngress } from '@/platform/bots/feishuBotMessageIngress';
import { FeishuBotConnectionManager } from '@/platform/bots/feishuBotConnectionManager';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { MessageRouteRegistry } from '@/services/messageHandler/routes';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { AgentManifest } from '@/platform/agents/contracts';

const message = (text = '今天 AI 圈有什么热点'): any => ({ id: crypto.randomUUID(), chat_id: 'private-a', chat_type: 'p2p', message_type: 'text', sender_open_id: 'ou_reader', text, sent_at: new Date().toISOString(), raw_payload: {} });
const context = (): any => ({ config: buildConfig({}), store: Object.assign(new InMemoryPersistentKeyValueStore(), { appendAuditLog: async () => {} }), feishu: {}, tapd: {} });

test('bot entries enforce unique priorities, valid contracts, availability and p2p text before matching', async () => {
    const routes = new MessageRouteRegistry(), ctx = context(); let matches = 0;
    const entry = { id: 'example.news', priority: 10, capability: 'example.news', matches: () => { matches++; return true; } };
    const release = routes.registerBotEntry(entry);
    expect(() => routes.registerBotEntry(entry)).toThrow('Duplicate');
    expect(() => routes.registerBotEntry({ ...entry, id: 'example.other' })).toThrow('priority');
    for (const bad of [{ ...entry, priority: NaN }, { ...entry, capability: '' }, { ...entry, matches: null }, { ...entry, id: '../bad' }]) {
        expect(() => routes.registerBotEntry(bad as any)).toThrow('Invalid');
    }
    const original = message();
    for (const skipped of [{ ...original, chat_type: 'group' }, { ...original, message_type: 'image' }, { ...original, sender_open_id: '' }]) {
        expect(routes.resolveBotEntry(ctx, skipped, () => true)).toBeNull();
    }
    expect(routes.resolveBotEntry(ctx, original, () => false)).toBeNull(); expect(matches).toBe(0);
    routes.registerBotEntry({ ...entry, id: 'example.priority', priority: 20, capability: 'example.priority' });
    expect(routes.resolveBotEntry(ctx, original, () => true)).toEqual({ capability: 'example.priority' }); expect(matches).toBe(1);
    expect(routes.resolveBotEntry(ctx, original, capability => capability === entry.capability)).toEqual({ capability: entry.capability });
    release(); routes.registerBotEntry(entry); release();
    expect(routes.resolveBotEntry(ctx, original, capability => capability === entry.capability)).toEqual({ capability: entry.capability });
    await routes.stop(); expect(routes.resolveBotEntry(ctx, original, () => true)).toBeNull();
});

test('news plugin owns default-bot routing, isolates conversations and stops routing when disabled or dedicated', async () => {
    const ctx = context(); ctx.config.ai_news.enabled = true;
    const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [aiNewsPlugin] });
    await host.initialize();
    const resolve = (value: any) => host.messageRoutes.resolveBotEntry(ctx, value, capability => host.canDispatch(capability));
    try {
        expect(resolve(message('查看更多'))).toBeNull();
        expect(resolve(message())).toEqual({ capability: 'knowledge.ai.news.fetch' });
        expect(resolve(message('查看更多'))).toEqual({ capability: 'knowledge.ai.news.fetch' });
        expect(resolve({ ...message('查看更多'), chat_id: 'private-b' })).toBeNull();
        for (const text of ['不要给我 AI 新闻', '创建 AI 新闻助手', '这个功能如何配置', '创建一个任务']) expect(resolve(message(text))).toBeNull();
        ctx.config.ai_news.enabled = false; expect(resolve(message())).toBeNull();
        ctx.config.ai_news.enabled = true; ctx.config.ai_news.app_id = 'cli_bbbbbbbbbbbbbbbb'; expect(resolve(message())).toBeNull();
        ctx.config.feishu.app_id = ctx.config.ai_news.app_id; expect(resolve(message())).toEqual({ capability: 'knowledge.ai.news.fetch' });
    } finally { await host.stop(); }
    expect(resolve(message())).toBeNull();
    const fresh = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [aiNewsPlugin] });
    await fresh.initialize();
    try { expect(fresh.messageRoutes.resolveBotEntry(ctx, message('查看更多'), () => true)).toBeNull(); }
    finally { await fresh.stop(); }
    const empty = new AgentHost(() => context(), 1000, undefined, [], { plugins: [] });
    await empty.initialize();
    try { expect(empty.messageRoutes.resolveBotEntry(ctx, message(), () => true)).toBeNull(); }
    finally { await empty.stop(); }
});

test('an independent plugin dispatches through generic ingress, the actual Host and persistent Run/Artifact without news coupling', async () => {
    const ctx = context(), input = message('帮我整理个人资料');
    const manifest: AgentManifest = {
        schemaVersion: '1.1', id: 'example.personal', name: 'Personal entry', version: '1.0.0', description: 'Local fixture',
        runtime: { type: 'native' }, capabilities: ['example.personal'], triggers: ['message'],
        inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
        outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        requirements: { tools: [], secrets: [], networkHosts: [] },
        limits: { timeoutSeconds: 5, maxSteps: 1, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 4096 },
        delivery: { allowedArtifactTypes: ['text'], directDelivery: false },
    };
    const plugin: FeaturePlugin = {
        manifest: { apiVersion: '1.0', id: 'example.personal', name: 'Personal entry', version: '1.0.0', description: 'Local fixture' },
        agents: [{ manifest, installationId: 'install-example-personal' }],
        apply(scope) {
            scope.delivery.messageRoutes.registerBotEntry({ id: 'example.personal', priority: 10, capability: 'example.personal', matches: () => true });
            scope.delivery.nativeAgents.register(manifest.id, manifest.version, async request => {
                const text = (request.input as any).prompt;
                return { status: 'succeeded', data: { text }, artifacts: [{ type: 'text', mediaType: 'text/plain', schemaVersion: '1.0', content: text }] };
            });
        },
    };
    const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [plugin] });
    await host.initialize(); let fallback = 0;
    const ingress = new FeishuBotMessageIngress(host, () => ({ handleEvent: async () => { fallback++; return { handled: false }; } }), ctx.store, 'bot-default',
        value => host.messageRoutes.resolveBotEntry(ctx, value, capability => host.canDispatch(capability)));
    const adapter: any = { parseEvent: () => input };
    try {
        const result: any = await ingress.handle(host.bots.requireActive('bot-default'), adapter, {});
        expect(fallback).toBe(0); expect(result.action).toBe('agent_dispatched'); expect(result.result.execution.run.status).toBe('succeeded');
        const details = (await host.getRunDetails(result.result.execution.run.id))!;
        expect(details.run.capability).toBe('example.personal'); expect(details.artifacts[0]!.content).toBe(input.text);
        expect(details.run).toMatchObject({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'message' });
        expect((await ingress.handle(host.bots.requireActive('bot-default'), adapter, {})) as any).toMatchObject({ action: 'agent_dispatched' });
        expect((await host.getRunDetails(details.run.id))!.artifacts).toEqual(details.artifacts);
    } finally { await host.stop(); }
});

test('a persisted dedicated bot stays saved but reads no secret or connection when its plugin is removed', async () => {
    const ctx = context(); ctx.config.ai_news.enabled = true; ctx.config.ai_news.app_id = 'cli_bbbbbbbbbbbbbbbb';
    const installed = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [aiNewsPlugin] });
    await installed.initialize();
    const saved = installed.bots.get(ctx.config.ai_news.bot_instance_id)!; expect(saved.status).toBe('active'); await installed.stop();
    let secrets = 0, connections = 0;
    const boot = async (plugins: FeaturePlugin[]) => {
        const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins }); await host.initialize();
        const manager = new FeishuBotConnectionManager(host.bots, 'bot-default', () => ctx.config.feishu,
            { resolve: async () => { secrets++; return 'fixture-secret'; } }, ctx.store, async () => {}, {
                createClient: () => ({ start: async () => { connections++; }, close: () => {} }),
                createDispatcher: () => ({}), createAdapter: () => ({ setAuditCallback: () => {} } as any),
            });
        return { host, manager };
    };
    const removed = await boot([]);
    try {
        expect(removed.host.bots.get(saved.id)).toEqual({ ...saved, status: 'disabled' }); expect(removed.manager.requiredBots()).toEqual([]);
        await removed.manager.start(); expect(secrets).toBe(0); expect(connections).toBe(0);
    } finally { await removed.manager.stop(); await removed.host.stop(); }
    const restored = await boot([aiNewsPlugin]);
    try {
        expect(restored.manager.requiredBots().map(bot => bot.id)).toEqual([saved.id]);
        await restored.manager.start(); expect(secrets).toBe(1); expect(connections).toBe(1);
    } finally { await restored.manager.stop(); await restored.host.stop(); }
});
