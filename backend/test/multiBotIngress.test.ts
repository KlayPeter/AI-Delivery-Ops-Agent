import { describe, expect, test } from 'bun:test';
import { BotRegistry } from '@/platform/bots/registry';
import { FeishuBotConnectionManager } from '@/platform/bots/feishuBotConnectionManager';
import { FeishuBotMessageIngress } from '@/platform/bots/feishuBotMessageIngress';

const defaultBot = {
    id: 'bot-default',
    workspaceId: 'workspace-default',
    platform: 'feishu' as const,
    name: 'Default',
    appId: 'cli_aaaaaaaaaaaaaaaa',
    secretRef: 'config://feishu/app_secret',
    status: 'active' as const,
    config: {},
};

const newsBot = {
    id: 'bot-ai-news',
    workspaceId: 'workspace-default',
    platform: 'feishu' as const,
    name: 'AI热点新闻助手',
    appId: 'cli_bbbbbbbbbbbbbbbb',
    secretRef: 'env://FEISHU_AI_NEWS_APP_SECRET',
    status: 'active' as const,
    config: {
        receiveMode: 'p2p',
        entryCapability: 'knowledge.ai.news.fetch',
    },
};

describe('Feishu multi-bot connections', () => {
    test('starts one connection per bot and scopes duplicate message ids by BotInstance', async () => {
        const bots = new BotRegistry([defaultBot, newsBot]);
        const handlers: Array<(data: any) => Promise<void>> = [];
        const closed: string[] = [];
        const received: string[] = [];
        const resolved: string[] = [];
        const audits: any[] = [];
        const manager = new FeishuBotConnectionManager(
            bots,
            'bot-default',
            () => ({
                app_id: defaultBot.appId,
                app_secret: 'default-secret',
                bot_open_id: '',
                bot_name: defaultBot.name,
                send_retry_count: 1,
            }),
            { resolve: async reference => { resolved.push(reference); return 'news-secret'; } },
            { appendAuditLog: async (action, payload) => { audits.push({ action, payload }); } },
            async bot => { received.push(bot.id); },
            {
                createClient: ({ appId }) => ({
                    start: async ({ eventDispatcher }) => { handlers.push(eventDispatcher.handler); },
                    close: () => { closed.push(appId); },
                    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
                }),
                createDispatcher: handler => ({ handler }),
                createAdapter: () => ({
                    setAuditCallback: () => {},
                } as any),
            },
        );

        await manager.start();
        expect(handlers).toHaveLength(2);
        expect(resolved).toEqual(['env://FEISHU_AI_NEWS_APP_SECRET']);
        await handlers[0]({ message: { message_id: 'om_same' } });
        await handlers[0]({ message: { message_id: 'om_same' } });
        await handlers[1]({ message: { message_id: 'om_same' } });
        await Bun.sleep(0);
        expect(received).toEqual(['bot-default', 'bot-ai-news']);
        expect(manager.health()).toEqual([
            { botInstanceId: 'bot-default', state: 'connected', reconnectAttempts: 0 },
            { botInstanceId: 'bot-ai-news', state: 'connected', reconnectAttempts: 0 },
        ]);
        expect(audits.filter(item => item.action === 'feishu_bot_connection_started')).toHaveLength(2);

        await manager.stop();
        expect(closed).toEqual([defaultBot.appId, newsBot.appId]);
    });

    test('keeps the in-memory duplicate cache bounded during a message burst', async () => {
        const bots = new BotRegistry([defaultBot]);
        let handler: ((data: any) => Promise<void>) | undefined;
        let received = 0;
        const manager = new FeishuBotConnectionManager(
            bots,
            'bot-default',
            () => ({
                app_id: defaultBot.appId,
                app_secret: 'default-secret',
                bot_open_id: '',
                bot_name: defaultBot.name,
                send_retry_count: 1,
            }),
            { resolve: async () => '' },
            { appendAuditLog: async () => {} },
            async () => { received++; },
            {
                createClient: () => ({
                    start: async ({ eventDispatcher }) => { handler = eventDispatcher.handler; },
                    close: () => {},
                }),
                createDispatcher: eventHandler => ({ handler: eventHandler }),
                createAdapter: () => ({ setAuditCallback: () => {} } as any),
            },
        );

        await manager.start();
        for (let index = 0; index <= 1000; index++) {
            await handler!({ message: { message_id: `om_${index}` } });
        }
        await handler!({ message: { message_id: 'om_0' } });
        await Bun.sleep(0);

        expect(received).toBe(1002);
        await manager.stop();
    });

    test('deduplicates the same event across two running instances through the persistent store', async () => {
        const claimed = new Set<string>();
        const handlers: Array<(data: any) => Promise<void>> = [];
        let received = 0;
        const store = {
            appendAuditLog: async () => {},
            claimIdempotencyKey: async (key: string) => {
                if (claimed.has(key)) return false;
                claimed.add(key);
                return true;
            },
        };
        const createManager = () => new FeishuBotConnectionManager(
            new BotRegistry([defaultBot]),
            'bot-default',
            () => ({
                app_id: defaultBot.appId,
                app_secret: 'default-secret',
                bot_open_id: '',
                bot_name: defaultBot.name,
                send_retry_count: 1,
            }),
            { resolve: async () => '' },
            store,
            async () => { received++; },
            {
                createClient: () => ({
                    start: async ({ eventDispatcher }) => { handlers.push(eventDispatcher.handler); },
                    close: () => {},
                }),
                createDispatcher: eventHandler => ({ handler: eventHandler }),
                createAdapter: () => ({ setAuditCallback: () => {} } as any),
            },
        );
        const first = createManager();
        const second = createManager();
        await first.start();
        await second.start();

        await Promise.all(handlers.map(handler => handler({ message: { message_id: 'om_cross_instance' } })));
        await Bun.sleep(0);

        expect(received).toBe(1);
        expect([...claimed]).toEqual(['feishu:event:workspace-default:bot-default:om_cross_instance']);
        await first.stop();
        await second.stop();
    });
});

describe('AI news bot ingress', () => {
    test('routes an AI news private message from the existing default bot without member lookup', async () => {
        const dispatched: any[] = [];
        let defaultHandlerCalls = 0;
        const message = {
            id: 'om_default_news',
            chat_id: 'oc_p2p',
            chat_type: 'p2p',
            sender_open_id: 'ou_news_user',
            sender_name: '用户',
            text: '今天 AI 圈有什么热点',
            message_type: 'text',
            sent_at: '2026-07-29T08:00:00.000Z',
            raw_payload: {},
        };
        const ingress = new FeishuBotMessageIngress(
            { dispatchBotMessage: async input => { dispatched.push(input); return { status: 'processed' }; } },
            () => ({ handleEvent: async () => { defaultHandlerCalls++; return { handled: true }; } }),
            { appendAuditLog: async () => {} },
            'bot-default',
            parsed => parsed.text.includes('AI') && parsed.text.includes('热点')
                ? { capability: 'knowledge.ai.news.fetch' }
                : null,
        );
        const adapter = {
            parseEvent: () => message,
            sendPrivateText: async () => ({ ok: true }),
        } as any;

        expect(await ingress.handle(defaultBot, adapter, { message: { message_id: message.id } }))
            .toMatchObject({ handled: true, action: 'agent_dispatched' });
        expect(defaultHandlerCalls).toBe(0);
        expect(dispatched).toEqual([{
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            capability: 'knowledge.ai.news.fetch',
            message,
            targetOpenId: 'ou_news_user',
        }]);
    });

    test('keeps non-news messages on the existing business handler path', async () => {
        let dispatched = 0;
        let defaultHandlerCalls = 0;
        const ingress = new FeishuBotMessageIngress(
            { dispatchBotMessage: async () => { dispatched++; } },
            () => ({ handleEvent: async () => { defaultHandlerCalls++; return { handled: true, action: 'task' }; } }),
            { appendAuditLog: async () => {} },
            'bot-default',
            () => null,
        );
        const adapter = {
            parseEvent: () => ({
                id: 'om_task',
                chat_id: 'oc_p2p',
                chat_type: 'p2p',
                sender_open_id: 'ou_user',
                text: '创建一个任务',
                message_type: 'text',
            }),
        } as any;

        expect(await ingress.handle(defaultBot, adapter, {})).toEqual({ handled: true, action: 'task' });
        expect(defaultHandlerCalls).toBe(1);
        expect(dispatched).toBe(0);
    });

    test('dispatches private text directly to the bound capability without member lookup', async () => {
        const dispatched: any[] = [];
        const audits: any[] = [];
        const ingress = new FeishuBotMessageIngress(
            { dispatchBotMessage: async input => { dispatched.push(input); return { status: 'processed' }; } },
            () => ({ handleEvent: async () => ({ handled: true }) }),
            { appendAuditLog: async (action, payload) => { audits.push({ action, payload }); } },
            'bot-default',
        );
        const message = {
            id: 'om_news',
            chat_id: 'oc_p2p',
            chat_type: 'p2p',
            sender_open_id: 'ou_news_user',
            sender_name: '用户',
            text: '今天 AI 圈有什么热点',
            message_type: 'text',
            sent_at: '2026-07-29T08:00:00.000Z',
            raw_payload: {},
        };
        const adapter = {
            parseEvent: () => message,
            sendPrivateText: async () => ({ ok: true }),
        } as any;

        const result = await ingress.handle(newsBot, adapter, { message: { message_id: message.id } });

        expect(result).toMatchObject({ handled: true, action: 'agent_dispatched' });
        expect(dispatched).toEqual([{
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-ai-news',
            capability: 'knowledge.ai.news.fetch',
            message,
            targetOpenId: 'ou_news_user',
        }]);
        expect(audits[0]).toMatchObject({
            action: 'source_message_received',
            payload: { bot_instance_id: 'bot-ai-news', message_id: 'om_news' },
        });
        expect(audits[0].payload).not.toHaveProperty('text');
        expect(audits[0].payload).not.toHaveProperty('raw_payload');
    });

    test('silently ignores group messages for a p2p-only bot', async () => {
        let dispatched = 0;
        let sent = 0;
        const ingress = new FeishuBotMessageIngress(
            { dispatchBotMessage: async () => { dispatched++; } },
            () => ({ handleEvent: async () => ({}) }),
            { appendAuditLog: async () => {} },
            'bot-default',
        );
        const adapter = {
            parseEvent: () => ({
                id: 'om_group',
                chat_id: 'oc_group',
                chat_type: 'group',
                sender_open_id: 'ou_user',
                text: 'AI 新闻',
                message_type: 'text',
            }),
            sendPrivateText: async () => { sent++; return { ok: true }; },
        } as any;

        expect(await ingress.handle(newsBot, adapter, {})).toEqual({ handled: false, reason: 'p2p_only' });
        expect(dispatched).toBe(0);
        expect(sent).toBe(0);
    });

    test('uses the same secondary bot adapter for a private failure response', async () => {
        const sent: string[] = [];
        const ingress = new FeishuBotMessageIngress(
            { dispatchBotMessage: async () => { throw new Error('source unavailable'); } },
            () => ({ handleEvent: async () => ({}) }),
            { appendAuditLog: async () => {} },
            'bot-default',
        );
        const adapter = {
            parseEvent: () => ({
                id: 'om_failed',
                chat_id: 'oc_p2p',
                chat_type: 'p2p',
                sender_open_id: 'ou_user',
                text: 'AI 新闻',
                message_type: 'text',
            }),
            sendPrivateText: async (_openId: string, text: string) => { sent.push(text); return { ok: true }; },
        } as any;

        expect(await ingress.handle(newsBot, adapter, {})).toMatchObject({ action: 'agent_failed' });
        expect(sent[0]).toContain('暂时获取失败');
    });
});
