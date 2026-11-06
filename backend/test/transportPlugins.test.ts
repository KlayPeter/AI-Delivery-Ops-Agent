import { createFeishuTransportPlugin } from '@/platform/bots/feishuPlugin';
import { TransportRegistry } from '@/platform/transports/registry';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { expect, test } from 'bun:test';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentDeliveryOutbox } from '@/platform/delivery/persistentOutbox';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { buildConfig } from '@/core/config';

function fixture() {
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), { appendAuditLog: async () => {} });
    const config = buildConfig({}); config.feishu = { app_id: 'cli_aaaaaaaaaaaaaaaa', app_secret: 'fixture-only', bot_name: 'Fixture', bot_open_id: '', send_retry_count: 1 };
    let sends = 0;
    const ctx: any = { store, config, feishu: { sendGroupMarkdown: async () => { sends++; return { ok: true, message_id: 'fixture-sent' }; } }, tapd: {} };
    return { store, ctx, sends: () => sends };
}
async function queued(store: InMemoryPersistentKeyValueStore) {
    const outbox = new PersistentDeliveryOutbox(store), now = new Date().toISOString();
    const record = await outbox.enqueue({ deliveryKey: crypto.randomUUID(), maxAttempts: 1,
        artifact: { id: crypto.randomUUID(), runId: crypto.randomUUID(), type: 'text', schemaVersion: '1.0', mediaType: 'text/plain', content: 'Fixture only', metadata: {}, createdAt: now },
        target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_fixture' },
    });
    return { outbox, record };
}

test('an absent transport never claims or consumes retries from a persisted Outbox', async () => {
    const f = fixture(), { outbox, record } = await queued(f.store), host = new AgentHost(() => f.ctx);
    try {
        await host.initialize(); await host.start(); await host.flushDeliveries();
        expect(await outbox.get(record.id)).toEqual(record); expect(f.sends()).toBe(0);
    } finally { await host.stop(); }
});


test('installing the transport delivers the same queued record once without needing an inbound connection', async () => {
    const f = fixture(), { outbox, record } = await queued(f.store);
    const host = new AgentHost(() => f.ctx, 1000, undefined, [], { plugins: [createFeishuTransportPlugin({ createClient: () => { throw new Error('inbound should not start during initialize'); } })] });
    try {
        await host.initialize(); expect(host.transports.available).toBe(true);
        expect(await host.flushDeliveries()).toEqual({ delivered: 1, retried: 0, deadLettered: 0 });
        expect(await outbox.get(record.id)).toMatchObject({ status: 'delivered', attempts: 1 }); expect(f.sends()).toBe(1);
        await host.flushDeliveries(); expect(f.sends()).toBe(1);
    } finally { await host.stop(); }
    expect(host.transports.available).toBe(false);
});

test('a plugin owns default inbound routing, duplicate protection, readiness and draining before disposal', async () => {
    const f = fixture(); let emit!: (data: any) => Promise<void>, entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let received = 0, started = 0, closed = 0;
    const source = { id: 'fixture-incoming', chat_type: 'p2p', chat_id: 'oc_fixture', sender_open_id: 'ou_fixture', text: 'fixture input', mentions: [] as Array<{ open_id: string; name: string }>, message_type: 'text' };
    Object.assign(f.ctx.store, { saveSourceMessage: async () => {}, getBotMessageContext: async (): Promise<null> => null, getSourceMessage: async (): Promise<null> => null });
    Object.assign(f.ctx.feishu, { parseEvent: () => source, addReaction: async (): Promise<undefined> => undefined });
    const channel = createFeishuTransportPlugin({
        createClient: () => ({ start: async () => { started++; }, close: () => { closed++; }, getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
        createAdapter: () => ({ parseEvent: () => source, setAuditCallback: () => {} }) as any,
        createDispatcher: handler => { emit = handler; return {}; },
    });
    const feature: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'example.receive', name: 'Receive fixture', version: '1.0.0', description: 'No external actions' },
        messageRoutes: [{ id: 'example.receive', priority: 1, sources: ['private'], handle: async () => { received++; entered(); await gate; return { handled: true }; } }], apply() {} };
    const host = new AgentHost(() => f.ctx, 1000, undefined, [], { plugins: [channel, feature] });
    await Promise.all([host.start(), host.start()]); expect(started).toBe(1);
    expect(host.transports.health()).toMatchObject({ requiredBotInstanceIds: ['bot-default'], connections: [{ botInstanceId: 'bot-default', state: 'connected' }] });
    const frame = { header: { app_id: f.ctx.config.feishu.app_id }, event: { message: { message_id: source.id } } };
    await emit(frame); await ready; await emit(frame); expect(received).toBe(1);
    let stopped = false; const stopping = host.stop().then(() => { stopped = true; });
    try { await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(1); expect(stopped).toBe(false); }
    finally { release(); await stopping; }
    expect(host.transports.available).toBe(false); expect(host.transports.health()).toEqual({ requiredBotInstanceIds: [], connections: [] });
    await emit({ ...frame, event: { message: { message_id: 'fixture-after-stop' } } }); expect(received).toBe(1);
});

test('a failing second inbound connection closes both the started and the failed client', async () => {
    const f = fixture(), closed: string[] = [], previous = process.env.FIXTURE_SECOND_BOT_SECRET;
    process.env.FIXTURE_SECOND_BOT_SECRET = 'fixture-only';
    const channel = createFeishuTransportPlugin({
        createClient: ({ appId }) => ({ start: async () => { if (appId.endsWith('b')) throw new Error('Fixture startup failure'); }, close: () => { closed.push(appId); } }),
        createAdapter: () => ({ setAuditCallback: () => {} }) as any, createDispatcher: () => ({}),
    });
    let disposed = false;
    const companion: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'example.cleanup', name: 'Cleanup fixture', version: '1.0.0', description: 'Companion resources' }, apply(ctx) { ctx.effect(() => () => { disposed = true; }); } };
    const host = new AgentHost(() => f.ctx, 1000, undefined, [], { plugins: [channel, companion] });
    try {
        await host.initialize(); await host.registerBot({ id: 'fixture-second', workspaceId: 'workspace-default', platform: 'feishu', name: 'Second', appId: 'cli_bbbbbbbbbbbbbbbb', secretRef: 'env://FIXTURE_SECOND_BOT_SECRET', status: 'active', config: {} });
        await expect(host.start()).rejects.toThrow('Fixture startup failure');
        expect(closed.sort()).toEqual(['cli_aaaaaaaaaaaaaaaa', 'cli_bbbbbbbbbbbbbbbb']); expect(host.health().started).toBe(false); expect(host.transports.health().connections).toEqual([]); expect(disposed).toBe(true); expect(host.health().initialized).toBe(false); expect(host.transports.available).toBe(false);
    } finally { await host.stop(); if (previous === undefined) delete process.env.FIXTURE_SECOND_BOT_SECRET; else process.env.FIXTURE_SECOND_BOT_SECRET = previous; }
});

test('transport registration validates the single-owner contract, snapshots health and disposes safely', async () => {
    const registry = new TransportRegistry(), connections = [{ botInstanceId: 'fixture', state: 'connected', reconnectAttempts: 0 }];
    const transport = { id: 'example.transport', delivery: { deliver: async () => ({}) }, start: async () => {}, stopIngress: async () => {}, stop: async () => {}, health: () => ({ requiredBotInstanceIds: ['fixture'], connections }) };
    expect(() => registry.register({ ...transport, delivery: {} as any })).toThrow('Invalid');
    const release = registry.register(transport); expect(() => registry.register(transport)).toThrow('Only one');
    registry.health().connections[0]!.state = 'changed'; expect(connections[0]!.state).toBe('connected');
    release(); release(); expect(registry.available).toBe(false);
    await expect(registry.deliver({} as any, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
    class FixtureTransport {
        id = 'example.class'; #starts = 0;
        get delivery() { return { deliver: async () => ({}) }; }
        async start() { this.#starts++; }
        async stopIngress() {}
        async stop() {}
        health() { return { requiredBotInstanceIds: ['fixture'], connections: [{ botInstanceId: 'fixture', state: String(this.#starts), reconnectAttempts: 0 }] }; }
    }
    const dispose = registry.register(new FixtureTransport()); await registry.start();
    expect(registry.health().connections[0]!.state).toBe('1'); dispose();
});


test('stopping during transport startup prevents later bot connections from opening', async () => {
    const f = fixture(), previous = process.env.FIXTURE_SECOND_BOT_SECRET;
    process.env.FIXTURE_SECOND_BOT_SECRET = 'fixture-only';
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const opened: string[] = [];
    const channel = createFeishuTransportPlugin({
        createClient: ({ appId }) => ({ start: async () => { opened.push(appId); entered(); await gate; }, close: () => { release(); } }),
        createAdapter: () => ({ setAuditCallback: () => {} }) as any, createDispatcher: () => ({}),
    });
    const host = new AgentHost(() => f.ctx, 1000, undefined, [], { plugins: [channel] });
    try {
        await host.initialize(); await host.registerBot({ id: 'fixture-second', workspaceId: 'workspace-default', platform: 'feishu', name: 'Second', appId: 'cli_bbbbbbbbbbbbbbbb', secretRef: 'env://FIXTURE_SECOND_BOT_SECRET', status: 'active', config: {} });
        const starting = host.start(), outcome = starting.then((): null => null, (error: Error): Error => error); await ready;
        await host.stop(); expect((await outcome)?.message).toContain('stopped');
        expect(opened).toEqual(['cli_aaaaaaaaaaaaaaaa']); expect(host.transports.available).toBe(false); expect(host.health().started).toBe(false);
    } finally { release(); await host.stop(); if (previous === undefined) delete process.env.FIXTURE_SECOND_BOT_SECRET; else process.env.FIXTURE_SECOND_BOT_SECRET = previous; }
});
