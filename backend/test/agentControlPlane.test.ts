import { describe, expect, test } from 'bun:test';
import { ScheduledAgentDispatcher } from '@/platform/bootstrap/scheduledAgentDispatcher';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';

function dispatcher(database: InMemoryPersistentKeyValueStore) {
    const ctx: any = {
        store: database,
        config: {
            feishu: { bot_name: 'default', app_id: 'app' }, project: { name: 'project' }, runtime: { public_base_url: '' }, groups: [],
        },
        feishu: {}, tapd: {}, intentParser: {},
    };
    return new ScheduledAgentDispatcher(() => ({ ctx }) as any);
}

describe('Agent control plane', () => {
    test('installs AIHot by secret reference and lists it after restart without exposing the reference', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const installed = await dispatcher(database).installAiHot({ endpoint: 'https://agent.example.com/v1/run', apiTokenRef: 'env://AIHOT_AGENT_TOKEN' });
        expect(installed).toMatchObject({ agentId: 'external.ai-hot', installationId: 'install-external.ai-hot' });
        const agents = await dispatcher(database).listAgents();
        expect(agents).toHaveLength(8);
        expect(agents.find(agent => agent.agentId === 'external.ai-hot')).toMatchObject({ runtime: 'http', source: 'external', secretNames: ['apiToken'] });
        expect(agents.filter(agent => agent.source === 'built-in').map(agent => agent.agentId).sort()).toEqual([
            'built-in.delivery-ops-agent',
            'built-in.standup-agent',
            'built-in.task-agent',
            'native.ai-news-radar',
            'native.daily-summary',
            'native.project-dashboard',
            'native.weekly-report',
        ]);
        expect(JSON.stringify(agents)).not.toContain('AIHOT_AGENT_TOKEN');
    });

    test('persists a secondary BotInstance and its independent Agent binding without exposing the secret reference', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const first = dispatcher(database);
        const bot = await first.registerBot({
            id: 'bot-secondary',
            workspaceId: 'workspace-default',
            platform: 'feishu',
            name: 'Secondary Bot',
            appId: 'cli_secondary',
            secretRef: 'env://SECONDARY_FEISHU_SECRET',
            status: 'active',
            config: { sendRetryCount: 2 },
        });
        expect(bot).toMatchObject({ id: 'bot-secondary', hasSecretRef: true });
        expect(JSON.stringify(bot)).not.toContain('SECONDARY_FEISHU_SECRET');
        await first.bindAgent({
            botInstanceId: 'bot-secondary',
            agentInstallationId: 'install-built-in-delivery-ops-agent',
            capabilities: ['delivery.ops.orchestrate'],
            priority: 10,
        });

        const restarted = dispatcher(database);
        expect(await restarted.listBots()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'bot-secondary', appId: 'cli_secondary', status: 'active', hasSecretRef: true }),
        ]));
        expect(await restarted.listBindings('bot-secondary')).toEqual([
            expect.objectContaining({
                botInstanceId: 'bot-secondary',
                agentInstallationId: 'install-built-in-delivery-ops-agent',
                capabilities: ['delivery.ops.orchestrate'],
            }),
        ]);
        expect(JSON.stringify(await restarted.listBots())).not.toContain('SECONDARY_FEISHU_SECRET');
    });

    test('installs AIHot independently for a secondary BotInstance without replacing the default installation', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const control = dispatcher(database);
        await control.registerBot({
            id: 'bot-secondary',
            workspaceId: 'workspace-default',
            platform: 'feishu',
            name: 'Secondary Bot',
            appId: 'cli_secondary',
            secretRef: 'env://SECONDARY_FEISHU_SECRET',
            status: 'active',
            config: {},
        });

        const defaultInstall = await control.installAiHot({ endpoint: 'https://agent.example.com/v1/run' });
        const secondaryInstall = await control.installAiHot({
            endpoint: 'https://agent.example.com/v1/run',
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-secondary',
        });

        expect(defaultInstall.installationId).toBe('install-external.ai-hot');
        expect(secondaryInstall.installationId).toBe('install-external.ai-hot-workspace-default-bot-secondary');
        expect((await dispatcher(database).listAgents()).filter(agent => agent.agentId === 'external.ai-hot')).toHaveLength(2);
    });

    test('derives collision-free default ids for a generic external Agent on a secondary BotInstance', async () => {
        const database = new InMemoryPersistentKeyValueStore();
        const control = dispatcher(database);
        await control.registerBot({
            id: 'bot-secondary',
            workspaceId: 'workspace-default',
            platform: 'feishu',
            name: 'Secondary Bot',
            appId: 'cli_secondary',
            secretRef: 'env://SECONDARY_FEISHU_SECRET',
            status: 'active',
            config: {},
        });
        const manifest: any = {
            schemaVersion: '1.0',
            id: 'external.example',
            name: 'Example Agent',
            version: '1.0.0',
            description: 'Example external Agent.',
            runtime: { type: 'http', entrypoint: 'https://agent.example.com/v1/run' },
            capabilities: ['example.run'],
            triggers: ['manual'],
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            requirements: { tools: [], secrets: [], networkHosts: ['agent.example.com'] },
            limits: { timeoutSeconds: 30, maxSteps: 1, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 1024 },
            delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
        };

        const defaultInstall = await control.installExternal(manifest, {});
        const secondaryInstall = await control.installExternal(manifest, {
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-secondary',
        });

        expect(defaultInstall.installationId).toBe('install-external.example');
        expect(secondaryInstall.installationId).toBe('install-external.example-workspace-default-bot-secondary');
        expect((await dispatcher(database).listAgents()).filter(agent => agent.agentId === 'external.example')).toHaveLength(2);
    });
});
