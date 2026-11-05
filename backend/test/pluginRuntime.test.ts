import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { dailySummaryManifest } from '@/agents/native/dailySummaryAgent';
import { AgentRegistry } from '@/platform/agents/registry';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { PersistentBotControlCatalog } from '@/platform/bots/catalog';
import { BotRegistry } from '@/platform/bots/registry';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PluginRuntime } from '@/platform/plugins/runtime';
import type { FeaturePlugin, PluginHostServices } from '@/platform/plugins/contracts';
import { SkillRegistry } from '@/platform/skills/registry';
import { ToolRegistry } from '@/platform/tools/registry';
import { MessageRouteRegistry } from '@/services/messageHandler/routes';
import { ScheduleRegistry } from '@/platform/scheduling/registry';

function plugin(id: string, apply: FeaturePlugin['apply'] = () => {}): FeaturePlugin {
    return { manifest: { apiVersion: '1.0', id, name: id, version: '1.0.0', description: 'Test plugin' }, apply };
}

function fixture() {
    const tools = new ToolRegistry();
    const services: PluginHostServices = {
        getContext: () => ({} as any), agents: new AgentRegistry(), nativeAgents: new NativeAgentAdapter(),
        modelAgents: { register: () => () => {} }, tools, skills: new SkillRegistry(), bots: new BotRegistry(),
        messageRoutes: new MessageRouteRegistry(),
        schedules: new ScheduleRegistry(),
        orchestrator: { run: async () => { throw new Error('Model is unused in this fixture'); } },
        toolGateway: { execute: async () => { throw new Error('Tool execution is unused in this fixture'); } },
        botCatalog: new PersistentBotControlCatalog(new InMemoryPersistentKeyValueStore()), skillRoot: '/nonexistent-plugin-skills',
    };
    return { services, tools };
}

describe('Cordis feature plugins', () => {
    test('loads dependencies before consumers, validates config, and disposes effects', async () => {
        const { services } = fixture();
        const events: string[] = [];
        const provider = plugin('test.provider', ctx => {
            events.push('provider');
            ctx.effect(() => () => { events.push('disposed'); });
        });
        const consumer = plugin('test.consumer', (_ctx, config) => { events.push(String(config.label)); });
        consumer.manifest.requires = ['test.provider'];
        consumer.Config = z.object({ label: z.string().min(1) });
        const runtime = new PluginRuntime([consumer, provider], services, { 'test.consumer': { label: 'consumer' } });
        await Promise.all([runtime.start(), runtime.start()]);
        expect(events).toEqual(['provider', 'consumer']);
        await runtime.dispose();
        expect(events).toEqual(['provider', 'consumer', 'disposed']);
        await expect(runtime.start()).rejects.toThrow('disposed');
    });

    test('rejects duplicate, missing and cyclic dependencies before invoking plugin code', () => {
        const { services } = fixture();
        let called = false;
        const first = plugin('test.first', () => { called = true; });
        expect(() => new PluginRuntime([first, first], services)).toThrow('Duplicate plugin');
        first.manifest.requires = ['test.missing'];
        expect(() => new PluginRuntime([first], services)).toThrow('Required plugin is missing');
        const second = plugin('test.second');
        first.manifest.requires = ['test.second'];
        second.manifest.requires = ['test.first'];
        expect(() => new PluginRuntime([first, second], services)).toThrow('cycle');
        expect(called).toBe(false);
    });

    test('rejects incompatible API versions and escaping skill package paths', () => {
        const { services } = fixture();
        const invalid = plugin('test.invalid');
        (invalid.manifest as any).apiVersion = '2.0';
        expect(() => new PluginRuntime([invalid], services)).toThrow();
        invalid.manifest.apiVersion = '1.0';
        invalid.skillPackages = ['../secret'];
        expect(() => new PluginRuntime([invalid], services)).toThrow('Invalid plugin skill package');
    });

    test('rolls back Agent, Tool and handler registrations when apply fails', async () => {
        const { services, tools } = fixture();
        const feature = plugin('test.failing', ctx => {
            ctx.delivery.messageRoutes.register({ id: 'test.dynamic', priority: 20, sources: ['private'], handle: async () => null });
            ctx.delivery.schedules.register({ id: 'test.dynamic', priority: 20, kind: 'timed', plan: () => null, run: async () => ({}) });
            ctx.delivery.tools.register({
                id: 'test.echo', version: '1.0.0', description: 'Echo', inputSchema: {}, outputSchema: {},
                sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 1,
            }, async input => input);
            ctx.delivery.nativeAgents.register(dailySummaryManifest.id, dailySummaryManifest.version,
                async () => ({ status: 'succeeded', artifacts: [] }));
            throw new Error('setup failed');
        });
        feature.agents = [{ manifest: dailySummaryManifest, installationId: 'test-install' }];
        feature.messageRoutes = [{ id: 'test.declared', priority: 10, sources: ['group'], handle: async () => null }];
        feature.schedules = [{ id: 'test.declared', priority: 10, kind: 'timed', plan: () => null, run: async () => ({}) }];
        const runtime = new PluginRuntime([feature], services);
        await expect(runtime.start()).rejects.toThrow('setup failed');
        expect(tools.list()).toEqual([]);
        expect((services.messageRoutes as MessageRouteRegistry).list()).toEqual([]);
        expect((services.schedules as ScheduleRegistry).list()).toEqual([]);
        expect(services.agents.getInstallation('test-install')).toBeNull();
        expect(services.agents.listBindings()).toEqual([]);
        expect(() => services.agents.install({
            id: 'test-install', workspaceId: 'workspace-default', agentId: dailySummaryManifest.id,
            version: dailySummaryManifest.version, status: 'active', config: {}, secretRefs: {},
        })).toThrow('definition is not registered');
        const release = services.nativeAgents.register(dailySummaryManifest.id, dailySummaryManifest.version,
            async () => ({ status: 'succeeded', artifacts: [] }));
        release();
    });

    test('config validation failure disposes previously loaded dependencies', async () => {
        const { services } = fixture();
        let disposed = false;
        const provider = plugin('test.provider', ctx => { ctx.effect(() => () => { disposed = true; }); });
        const consumer = plugin('test.consumer');
        consumer.manifest.requires = ['test.provider'];
        consumer.Config = z.object({ requiredValue: z.string() });
        const runtime = new PluginRuntime([provider, consumer], services);
        await expect(runtime.start()).rejects.toThrow();
        expect(disposed).toBe(true);
    });

    test('emits restoration hooks only after plugins are mounted', async () => {
        const { services } = fixture();
        let restored = 0;
        const runtime = new PluginRuntime([plugin('test.restored', ctx => {
            ctx.on('delivery/restored', () => { restored++; });
        })], services);
        await runtime.start();
        expect(restored).toBe(0);
        await runtime.restored();
        expect(restored).toBe(1);
        await runtime.dispose();
    });

    test('missing declared skills fail startup instead of silently disabling an Agent capability', async () => {
        const { services } = fixture();
        const feature = plugin('test.missing-skill');
        feature.agents = [{ manifest: dailySummaryManifest, installationId: 'test-missing-skill' }];
        feature.skillPackages = ['required-skill'];
        const runtime = new PluginRuntime([feature], services);
        await expect(runtime.start()).rejects.toThrow('Plugin skill package not found');
        expect(services.agents.getInstallation('test-missing-skill')).toBeNull();
    });

    test('restoration failure releases contributions from already loaded plugins', async () => {
        const { services, tools } = fixture();
        const runtime = new PluginRuntime([plugin('test.restore-failure', ctx => {
            ctx.delivery.tools.register({
                id: 'test.restore', version: '1.0.0', description: 'Restore test', inputSchema: {}, outputSchema: {},
                sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 1,
            }, async input => input);
            ctx.on('delivery/restored', () => { throw new Error('restore failed'); });
        })], services);
        await expect(runtime.restored()).rejects.toThrow('restore failed');
        expect(tools.list()).toEqual([]);
    });
});
