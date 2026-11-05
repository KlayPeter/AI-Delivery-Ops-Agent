import { describe, expect, test } from 'bun:test';
import { dailySummaryPlugin } from '@/agents/plugins/dailySummary';
import { taskPlugin } from '@/agents/plugins/task';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { MessageHandler } from '@/services/messageHandler';
import { ContextRouter } from '@/services/messageHandler/ContextRouter';
import { MessageRouter } from '@/services/messageHandler/MessageRouter';
import { MessageRouteRegistry, type MessageRoute } from '@/services/messageHandler/routes';
import { StatusUpdateHandler } from '@/services/messageHandler/handlers/StatusUpdateHandler';

function fixture(source: 'group' | 'private' = 'group') {
    const replies: string[] = [];
    const message: any = {
        id: 'message-1', chat_id: 'chat-1', chat_type: source === 'group' ? 'group' : 'p2p',
        sender_open_id: 'ou_person', text: '@Bot 创建任务：测试',
        mentions: [{ open_id: 'ou_bot', name: 'Bot' }], sent_at: new Date().toISOString(),
    };
    const ctx: any = {
        config: {
            feishu: { bot_name: 'Bot', bot_open_id: 'ou_bot', app_id: '' }, email: { enabled: false },
            project: { name: 'Test' }, data_path: '/tmp', runtime: { public_base_url: '' }, groups: [],
        },
        messageRoutes: new MessageRouteRegistry(),
        store: Object.assign(new InMemoryPersistentKeyValueStore(), {
            saveSourceMessage: async () => {}, appendAuditLog: async () => {},
            saveTask: async () => { throw new Error('Disabled task plugin must not write tasks'); },
        }),
        feishu: {
            dryRun: true, parseEvent: () => message, addReaction: async (): Promise<undefined> => undefined,
            sendPrivateText: async (_id: string, text: string) => { replies.push(text); return { ok: true }; },
            sendReplyText: async (_id: string, text: string) => { replies.push(text); return { ok: true }; },
            getUserName: async () => { throw new Error('Standalone plugin must not consult project membership'); },
        },
    };
    function handler(replyContext: any = null) {
        const handler = new MessageHandler(ctx) as any;
        handler.resolver = { resolveReplyContext: async () => replyContext };
        return handler as MessageHandler;
    }
    function host(plugins: readonly FeaturePlugin[]) {
        return new AgentHost(() => ctx, 10, undefined, [], { plugins, messageRoutes: ctx.messageRoutes });
    }
    return { ctx, message, replies, handler, host };
}

describe('Plugin-owned message routes', () => {
    test('rejects ambiguous or invalid routes and keeps disposal idempotent', () => {
        const registry = new MessageRouteRegistry();
        const route: MessageRoute = { id: 'example.first', priority: 10, sources: ['group'], handle: async () => null };
        const dispose = registry.register(route);
        expect(() => registry.register(route)).toThrow('Duplicate message route');
        expect(() => registry.register({ ...route, id: 'example.second' })).toThrow('priority');
        expect(() => registry.register({ ...route, id: 'example.context', phase: 'context' })).toThrow('Invalid message route');
        expect(() => registry.register({ ...route, id: 'example.invalid', sources: ['email'] as any })).toThrow('Invalid message route');
        registry.register({ ...route, id: 'example.context', phase: 'context', matches: () => true });
        dispose();
        registry.register(route);
        dispose();
        expect(registry.list('group', 'message').map(item => item.id)).toEqual(['example.first']);
    });

    test('a declined matching context cannot fall through into another context handler', async () => {
        const { ctx, message } = fixture();
        let wrongContextCalled = false;
        ctx.messageRoutes.register({
            id: 'example.standup', phase: 'context', priority: 200, sources: ['group'],
            matches: () => true, handle: async (): Promise<null> => null,
        });
        ctx.messageRoutes.register({
            id: 'example.task', phase: 'context', priority: 100, sources: ['group'], matches: () => true,
            handle: async () => { wrongContextCalled = true; return { handled: true }; },
        });
        await MessageRouter.handleGroup(ctx, {} as any, message, { context_type: 'task_thread' });
        expect(wrongContextCalled).toBe(false);
    });

    test('removing the task plugin removes commands, old contexts and task help', async () => {
        const { ctx, message, replies, handler, host } = fixture();
        const runtime = host([dailySummaryPlugin]);
        await runtime.initialize();
        try {
            expect(await ContextRouter.maybeHandle(ctx, {} as any, message, 'group', {
                context_type: 'missing_task_field', metadata: { original_text: '@Bot 创建任务' },
            })).toBeNull();
            const result = await handler({ context_type: 'task_thread', task_id: 'old-task' }).handleEvent({});
            expect(result.action).toBe('unrecognized_command');
            expect(replies[0]).toContain('生成/发送群聊日报');
            expect(replies[0]).not.toContain('创建');
            expect(replies[0]).not.toContain('站会');
        } finally { await runtime.stop(); }
        expect(ctx.messageRoutes.list()).toEqual([]);
    });

    test('removing the standup plugin removes unmentioned historical template replies', async () => {
        const { message, handler, host } = fixture();
        message.mentions = [];
        message.text = '完成联调，今天17点交付';
        const runtime = host([dailySummaryPlugin]);
        await runtime.initialize();
        try {
            expect(await handler({ context_type: 'task_standup_template' }).handleEvent({})).toEqual({
                handled: false, reason: 'not_directed_at_bot',
            });
        } finally { await runtime.stop(); }
    });

    test('a standalone third-party private plugin works without project membership and cleans up', async () => {
        const { ctx, handler, host } = fixture('private');
        const plugin: FeaturePlugin = {
            manifest: { apiVersion: '1.0', id: 'example.personal', name: 'Personal', version: '1.0.0', description: 'Personal message plugin' },
            messageRoutes: [{
                id: 'example.personal', priority: 10, sources: ['private'],
                handle: async () => ({ handled: true, action: 'personal_answer' }),
            }],
            apply(context) {
                context.delivery.messageRoutes.register({ id: 'example.group', priority: 20, sources: ['group'], handle: async () => null });
            },
        };
        const runtime = host([plugin]);
        await runtime.initialize();
        try { expect((await handler().handleEvent({})).action).toBe('personal_answer'); }
        finally { await runtime.stop(); }
        expect(ctx.messageRoutes.list()).toEqual([]);
        await expect(MessageRouter.handlePrivate(ctx, {} as any, {} as any, null)).rejects.toThrow('stopped');
    });

    test('the default membership requirement remains active when a team route is installed', async () => {
        const { ctx, handler, replies } = fixture('private');
        ctx.feishu.getUserName = async () => 'Test user';
        ctx.messageRoutes.register({
            id: 'example.member', priority: 10, sources: ['private'], requiresProjectMember: true,
            handle: async () => { throw new Error('Unknown member cannot enter the team route'); },
        });
        expect((await handler().handleEvent({})).action).toBe('unknown_user');
        expect(replies[0]).toContain('无法识别您的身份');
    });

    test('Host stop waits for a deterministic message before disposing its plugin', async () => {
        const { ctx, handler, host } = fixture('private');
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const finish = new Promise<void>(resolve => { release = resolve; });
        let disposed = false;
        const plugin: FeaturePlugin = {
            manifest: { apiVersion: '1.0', id: 'example.wait', name: 'Wait', version: '1.0.0', description: 'Wait for a message' },
            messageRoutes: [{
                id: 'example.wait', priority: 10, sources: ['private'],
                async handle() { entered(); await finish; return { handled: true, action: 'finished' }; },
            }],
            apply(context) { context.effect(() => () => { disposed = true; }); },
        };
        const runtime = host([plugin]);
        await runtime.initialize();
        const processing = handler().handleEvent({});
        await started;
        const stopping = runtime.stop();
        await Promise.resolve();
        expect(disposed).toBe(false);
        await expect(MessageRouter.handlePrivate(ctx, {} as any, {} as any, null)).rejects.toThrow('stopped');
        release();
        expect((await processing).action).toBe('finished');
        await stopping;
        expect(disposed).toBe(true);
        expect(ctx.messageRoutes.list()).toEqual([]);
    });

    test('task preparation is plugin-owned, runs once and preserves the original source text', async () => {
        const { ctx, message, host } = fixture();
        message.text = '明天下午';
        const runtime = host([taskPlugin]);
        const original = StatusUpdateHandler.maybeHandle;
        let prepared = '';
        StatusUpdateHandler.maybeHandle = async (_ctx, _resolver, input) => {
            prepared = input.text || '';
            return { handled: true, action: 'prepared' };
        };
        try {
            await runtime.initialize();
            await MessageRouter.handleGroup(ctx, {} as any, message, {
                context_type: 'missing_task_field', metadata: { original_text: '创建任务：联调' },
            });
            expect(prepared).toBe('创建任务：联调 明天下午');
            expect(message.text).toBe('明天下午');
        } finally {
            StatusUpdateHandler.maybeHandle = original;
            await runtime.stop();
        }
    });
});
