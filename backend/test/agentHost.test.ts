import { describe, expect, test } from 'bun:test';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { createDeliveryOpsHost } from '@/agents/host';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { dailySummaryManifest } from '@/agents/native/dailySummaryAgent';
import { PersistentBotControlCatalog } from '@/platform/bots/catalog';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { echoPlugin } from '../examples/plugins/echo';
import { BotRegistry } from '@/platform/bots/registry';
import { InMemoryDeliveryOutbox } from '@/platform/delivery/outbox';
import { DeliveryWorker } from '@/platform/delivery/worker';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';

function context(store: InMemoryPersistentKeyValueStore): any {
    return {
        store,
        config: {
            data_path: '/tmp',
            feishu: { bot_name: 'default', app_id: 'app' },
            project: { name: 'project' },
            runtime: { public_base_url: '' },
            groups: [],
        },
        feishu: {},
        tapd: {},
        intentParser: {},
    };
}

describe('AgentHost lifecycle', () => {
    test('executes the documented plugin template without model or Feishu credentials', async () => {
        const host = new AgentHost(() => context(new InMemoryPersistentKeyValueStore()), 10, undefined, [], { plugins: [echoPlugin] });
        expect(host.canDispatch('example.echo')).toBe(false);
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: 'template-example' });
        const trigger = createTriggerEnvelope({ occurredAt: new Date().toISOString(), scope, payload: { text: 'plugin works' }, replyPolicy: { mode: 'none' } });
        const result = await host.dispatch(trigger, 'example.echo', { text: 'plugin works' });
        expect(host.canDispatch('example.echo')).toBe(true);
        expect(host.canDispatch('example.echo', 'another-workspace')).toBe(false);
        expect(result.execution?.artifacts[0]?.content).toBe('plugin works');
        expect((await host.dispatch(trigger, 'example.echo', { text: 'plugin works' })).status).toBe('duplicate');
        await host.stop();
        expect(host.canDispatch('example.echo')).toBe(false);
    });

    test('starts without business plugins and leaves no implicit tools, skills or Agents', async () => {
        const host = new AgentHost(() => context(new InMemoryPersistentKeyValueStore()));
        await host.initialize();
        expect(await host.listAgents()).toEqual([]);
        expect(host.health()).toMatchObject({ initialized: true, tools: 0, skills: 0, bindings: 0 });
        await host.stop();
    });

    test('runs a third-party native plugin and drains in-flight work before disposing it', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const ctx = context(database);
        let entered!: () => void;
        let release!: () => void;
        const running = new Promise<void>(resolve => { entered = resolve; });
        const finish = new Promise<void>(resolve => { release = resolve; });
        let disposed = false;
        const manifest = { ...dailySummaryManifest, id: 'example.echo', capabilities: ['example.echo'], inputSchema: {}, outputSchema: {} };
        const plugin: FeaturePlugin = {
            manifest: { apiVersion: '1.0', id: 'example.echo', name: 'Echo', version: '1.0.0', description: 'External native example' },
            agents: [{ manifest, installationId: 'install-example-echo' }],
            apply(pluginContext) {
                pluginContext.effect(() => () => { disposed = true; });
                pluginContext.delivery.nativeAgents.register(manifest.id, manifest.version, async request => {
                    entered();
                    await finish;
                    return { status: 'succeeded', data: request.input, artifacts: [] };
                });
            },
        };
        const host = new AgentHost(() => ctx, 10, undefined, [], { plugins: [plugin] });
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: 'plugin-run' });
        const execution = host.dispatch(createTriggerEnvelope({ occurredAt: new Date().toISOString(), scope, payload: { text: 'hello' }, replyPolicy: { mode: 'none' } }), 'example.echo', { text: 'hello' });
        await running;
        const stopping = host.stop();
        await Promise.resolve();
        expect(disposed).toBe(false);
        release();
        const result = await execution;
        await stopping;
        expect(result.execution?.result.data).toEqual({ text: 'hello' });
        expect(disposed).toBe(true);
        expect(host.registry.listBindings()).toEqual([]);
        expect((await new PersistentAgentRunStore(database).get(result.execution!.run.id))?.status).toBe('succeeded');
        await expect(host.start()).rejects.toThrow('stopped');
    });

    test('retains persisted bindings while a removed plugin and its entry bot stay inactive', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const catalog = new PersistentBotControlCatalog(database);
        await catalog.upsertBot({
            id: 'bot-removed', workspaceId: 'workspace-default', platform: 'feishu', name: 'Removed feature',
            appId: 'app-removed', secretRef: 'env://UNUSED_PLUGIN_SECRET', status: 'active', config: { entryCapability: 'task.manage' },
        });
        await catalog.upsertBinding({
            id: 'saved-task-binding', botInstanceId: 'bot-removed', agentInstallationId: 'install-built-in-task-agent',
            enabled: true, priority: 1, capabilities: ['task.manage'], routingConfig: {}, configOverride: {},
        });
        const host = new AgentHost(() => context(database));
        await host.initialize();
        expect(await host.listBindings()).toEqual([]);
        expect((await host.listBots()).find(bot => bot.id === 'bot-removed')?.status).toBe('disabled');
        expect(await catalog.listBindings()).toHaveLength(1);
        expect((await catalog.listBots())[0]?.status).toBe('active');
        await host.stop();
    });

    test('initializes once and exposes a stable runtime health state', async () => {
        const ctx = context(new InMemoryPersistentKeyValueStore());
        const host = createDeliveryOpsHost(() => ctx, 10);
        await Promise.all([host.initialize(), host.initialize()]);
        expect(host.health()).toEqual({
            initialized: true,
            started: false,
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            tools: 6,
            skills: 2,
            bots: 1,
            bindings: 7,
        });
        expect((await host.listAgents()).map(agent => agent.agentId).sort()).toEqual([
            'built-in.delivery-ops-agent',
            'built-in.standup-agent',
            'built-in.task-agent',
            'native.ai-news-radar',
            'native.daily-summary',
            'native.project-dashboard',
            'native.weekly-report',
        ]);
        await host.start();
        expect(host.health().started).toBe(true);
        await host.stop();
        expect(host.health().started).toBe(false);
    });

    test('recovers interrupted Agent records before reporting initialized', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const runs = new PersistentAgentRunStore(database);
        await runs.create({
            id: 'interrupted-host-run',
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            agentInstallationId: 'install-native-daily-summary',
            capability: 'daily-summary.generate',
            triggerId: 'scheduled-before-restart',
            correlationId: 'interrupted-host-run',
            rootRunId: 'interrupted-host-run',
            depth: 0,
            status: 'queued',
            createdAt: '2026-07-14T00:00:00Z',
        });
        await runs.transition('interrupted-host-run', 'running', { startedAt: '2026-07-14T00:00:01Z' });
        const auditEvents: Array<{ event: string; details: unknown }> = [];
        (database as any).appendAuditLog = async (event: string, details: unknown) => {
            auditEvents.push({ event, details });
        };

        const host = createDeliveryOpsHost(() => context(database), 10);
        await host.initialize();

        expect(host.health().initialized).toBe(true);
        expect(await runs.get('interrupted-host-run')).toMatchObject({
            status: 'failed',
            error: { code: 'PROCESS_RESTARTED', retryable: false },
        });
        expect(auditEvents).toEqual([{
            event: 'agent_runtime_recovered_after_restart',
            details: { runs: 1, steps: 0, tool_calls: 0, triggers: 0 },
        }]);
    });

    test('registers an extension once before the runtime becomes ready', async () => {
        const ctx = context(new InMemoryPersistentKeyValueStore());
        let registrations = 0;
        const host = createDeliveryOpsHost(() => ctx, 10, undefined, [{
            id: 'test-tools',
            register: ({ toolRegistry }) => {
                registrations++;
                toolRegistry.register({
                    id: 'test.echo',
                    version: '1.0.0',
                    description: 'Test-only extension tool.',
                    inputSchema: {},
                    outputSchema: {},
                    sideEffect: 'read',
                    riskLevel: 'low',
                    idempotent: true,
                    timeoutSeconds: 1,
                }, async input => input);
            },
        }]);

        await Promise.all([host.initialize(), host.initialize()]);

        expect(registrations).toBe(1);
        expect(host.health()).toMatchObject({ initialized: true, tools: 7 });
    });

    test('rejects duplicate extension ids before reporting ready', async () => {
        const extension = { id: 'duplicate', register: () => {} };
        const host = createDeliveryOpsHost(
            () => context(new InMemoryPersistentKeyValueStore()),
            10,
            undefined,
            [extension, extension],
        );

        await expect(host.initialize()).rejects.toThrow('Duplicate Agent Host extension id: duplicate');
        expect(host.health().initialized).toBe(false);
    });

    test('provisions a p2p-only AI news BotInstance and binding without exposing its secret reference', async () => {
        const ctx = context(new InMemoryPersistentKeyValueStore());
        ctx.config.ai_news = {
            enabled: true,
            bot_instance_id: 'bot-ai-news',
            bot_name: 'AI热点新闻助手',
            app_id: 'cli_aaaaaaaaaaaaaaaa',
            app_secret_env: 'FEISHU_AI_NEWS_APP_SECRET',
            source_url: 'https://aihot.virxact.com',
            default_limit: 10,
            request_timeout_ms: 10000,
        };
        const host = createDeliveryOpsHost(() => ctx, 10);

        await host.initialize();

        expect(host.health()).toMatchObject({ bots: 2, bindings: 8 });
        expect(await host.listBots()).toContainEqual({
            id: 'bot-ai-news',
            workspaceId: 'workspace-default',
            platform: 'feishu',
            name: 'AI热点新闻助手',
            appId: 'cli_aaaaaaaaaaaaaaaa',
            botOpenId: undefined,
            status: 'active',
            config: {
                managedBy: 'ai-news-config',
                inboundEnabled: true,
                receiveMode: 'p2p',
                entryCapability: 'knowledge.ai.news.fetch',
                sendRetryCount: 3,
            },
            hasSecretRef: true,
        });
        expect(await host.listBindings('bot-ai-news')).toContainEqual({
            id: 'bind-install-native-ai-news-radar-bot-ai-news',
            botInstanceId: 'bot-ai-news',
            agentInstallationId: 'install-native-ai-news-radar',
            enabled: true,
            priority: 1,
            capabilities: ['knowledge.ai.news.fetch'],
            routingConfig: { receiveMode: 'p2p' },
            hasConfigOverride: false,
        });
    });

    test('reuses the default BotInstance when no dedicated AI news App ID is configured', async () => {
        const ctx = context(new InMemoryPersistentKeyValueStore());
        ctx.config.ai_news = {
            enabled: true,
            bot_instance_id: 'bot-ai-news',
            bot_name: 'AI热点新闻助手',
            app_id: '',
            app_secret_env: 'FEISHU_AI_NEWS_APP_SECRET',
            source_url: 'https://aihot.virxact.com',
            default_limit: 10,
            request_timeout_ms: 10000,
        };
        const host = createDeliveryOpsHost(() => ctx, 10);

        await host.initialize();

        expect(host.health()).toMatchObject({ bots: 1, bindings: 7 });
        expect(await host.listBots()).toHaveLength(1);
        expect(await host.listBindings('bot-default')).toContainEqual({
            id: 'bind-native.ai-news-radar-default',
            botInstanceId: 'bot-default',
            agentInstallationId: 'install-native-ai-news-radar',
            enabled: true,
            priority: 1,
            capabilities: ['knowledge.ai.news.fetch'],
            routingConfig: {},
            hasConfigOverride: false,
        });
    });

    test('delivery loop drains durable work without a scheduler flush', async () => {
        const outbox = new InMemoryDeliveryOutbox();
        const bots = new BotRegistry([{
            id: 'bot-default',
            workspaceId: 'workspace-default',
            platform: 'feishu',
            name: 'default',
            appId: 'app',
            secretRef: 'secret://bot',
            status: 'active',
            config: {},
        }]);
        await outbox.enqueue({
            deliveryKey: 'background-delivery',
            artifact: {
                id: 'artifact-1',
                runId: 'run-1',
                type: 'markdown',
                mediaType: 'text/markdown',
                schemaVersion: '1.0',
                content: 'background',
                metadata: {},
                createdAt: new Date().toISOString(),
            },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_group' },
        });
        let delivered = 0;
        const worker = new DeliveryWorker(outbox, bots, {
            deliver: async () => { delivered++; return { messageId: 'om_1' }; },
        });
        worker.start(10);
        await Bun.sleep(30);
        await worker.stop();
        expect(delivered).toBe(1);
    });
});
