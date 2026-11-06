import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDeliveryOpsContext } from '@/agents/context';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { MessageHandler } from '@/services/messageHandler';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';
import { loadWorkspacePlugins } from '@/platform/workspace/composition';
import { echoPlugin } from '../examples/plugins/echo';

function context(directory: string) {
    const config = buildConfig({}); config.data_path = directory;
    return createDeliveryOpsContext({ config, store: new InMemoryPersistentKeyValueStore() as any, feishu: {} as any });
}

test('empty, personal and native-only hosts do not construct legacy team services while starting or running an unrelated task', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'application-context-'));
    try {
        const personal = await loadWorkspacePlugins(directory, '');
        for (const selection of [{ plugins: [] }, personal, { plugins: [echoPlugin] }]) {
            const { plugins } = selection;
            const ctx = context(directory), touched: string[] = [];
            for (const key of ['feishu', 'tapd', 'dashboard', 'projectDashboard', 'email', 'intentParser'] as const) {
                const getter = Object.getOwnPropertyDescriptor(ctx, key)!.get!;
                Object.defineProperty(ctx, key, { get() { touched.push(key); return getter.call(ctx); } });
            }
            new MessageHandler(ctx);
            const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins, pluginConfig: 'config' in selection ? selection.config : undefined });
            try {
                await host.initialize();
                if (plugins.includes(echoPlugin)) expect((await host.runLocal('example.echo', { text: 'No legacy service' }, crypto.randomUUID())).execution?.run.status).toBe('succeeded');
                expect((await host.handlePluginRequest(new Request('http://localhost/api/standups'))).status).toBe(404);
            } finally { await host.stop(); }
            expect(touched).toEqual([]);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('services are reused within one context, and rebuilt from the new configuration on reload', () => {
    const first = context('/tmp/application-context-first'), second = context('/tmp/application-context-second');
    first.config.ai.model = 'fixture-model-first'; second.config.ai.model = 'fixture-model-second';
    expect(first.tapd).toBe(first.tapd); expect(first.dashboard).toBe(first.dashboard); expect(first.projectDashboard).toBe(first.projectDashboard);
    expect(first.intentParser).toBe(first.intentParser); expect(first.email).toBeNull();
    expect(second.tapd).not.toBe(first.tapd); expect(second.projectDashboard).not.toBe(first.projectDashboard);
    expect(first.intentParser!.llm!.diagnostics().model).toBe('fixture-model-first'); expect(second.intentParser!.llm!.diagnostics().model).toBe('fixture-model-second');
    second.config.email = { enabled: true, host: 'mail-fixture.invalid', port: 465, secure: true, user: 'fixture', pass: '', from_address: 'fixture@example.invalid', to_addresses: ['recipient@example.invalid'] };
    expect(second.email?.dryRun).toBe(false); expect(second.email).toBe(second.email);
});


test('application Feishu access is blocked without a transport, including an Adapter cached before removal', () => {
    let enabled = false;
    const base = context('/tmp/application-context-channel');
    const ctx = createDeliveryOpsContext({ config: base.config, store: base.store, isTransportAvailable: () => enabled });
    expect(() => ctx.feishu).toThrow('transport is not installed');
    enabled = true; const adapter = ctx.feishu; expect(ctx.feishu).toBe(adapter);
    enabled = false; expect(() => ctx.feishu).toThrow('transport is not installed');
});
