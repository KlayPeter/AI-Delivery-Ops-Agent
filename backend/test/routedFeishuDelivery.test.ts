import { describe, expect, test } from 'bun:test';
import { BotRegistry } from '@/platform/bots/registry';
import { RoutedFeishuDeliveryAdapter } from '@/platform/delivery/routedFeishuAdapter';

function record(botInstanceId: string): any {
    return {
        id: `delivery-${botInstanceId}`,
        deliveryKey: `key-${botInstanceId}`,
        artifact: {
            id: 'artifact-1', runId: 'run-1', type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0',
            content: 'hello', metadata: {}, createdAt: new Date().toISOString(),
        },
        target: { workspaceId: 'workspace-default', botInstanceId, channel: 'group', targetId: 'oc_group' },
        status: 'pending', attempts: 0, maxAttempts: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
}

describe('Routed Feishu delivery', () => {
    test('uses the selected BotInstance credentials while preserving the configured default adapter', async () => {
        const bots = new BotRegistry([
            { id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'Default', appId: 'cli_default', secretRef: 'config://feishu/app_secret', status: 'active', config: {} },
            { id: 'bot-secondary', workspaceId: 'workspace-default', platform: 'feishu', name: 'Secondary', appId: 'cli_secondary', secretRef: 'env://SECONDARY_SECRET', status: 'active', config: {} },
        ]);
        const resolved: string[] = [];
        const defaultFeishu: any = {
            sendGroupMarkdown: async () => ({ ok: true, message_id: 'om_default', chat_id: 'oc_group' }),
        };
        const adapter = new RoutedFeishuDeliveryAdapter(
            bots,
            'bot-default',
            () => defaultFeishu,
            { resolve: async reference => { resolved.push(reference); return 'secondary-secret'; } },
            (bot, secret) => ({ deliver: async () => ({ botId: bot.id, secret }) }),
        );

        expect(await adapter.deliver(record('bot-default'), new AbortController().signal)).toMatchObject({ messageId: 'om_default' });
        expect(await adapter.deliver(record('bot-secondary'), new AbortController().signal)).toEqual({ botId: 'bot-secondary', secret: 'secondary-secret' });
        expect(resolved).toEqual(['env://SECONDARY_SECRET']);
    });

    test('uses a private interactive card for article links', async () => {
        const bots = new BotRegistry([
            { id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'Default', appId: 'cli_default', secretRef: 'config://feishu/app_secret', status: 'active', config: {} },
        ]);
        const calls: any[] = [];
        const adapter = new RoutedFeishuDeliveryAdapter(
            bots,
            'bot-default',
            () => ({
                sendPrivateMarkdown: async (openId: string, content: string, title?: string) => {
                    calls.push({ openId, content, title });
                    return { ok: true, message_id: 'om_private', chat_id: 'oc_p2p' };
                },
            } as any),
            { resolve: async () => '' },
        );
        const privateRecord = record('bot-default');
        privateRecord.target = {
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-default',
            channel: 'private',
            targetId: 'ou_user',
        };
        privateRecord.artifact = {
            ...privateRecord.artifact,
            type: 'article_list',
            content: {
                articles: [{
                    title: 'AI 新闻',
                    url: 'https://example.com/news',
                    source: 'Example',
                    publishedAt: '2026-07-29T01:00:00.000Z',
                    summary: '摘要',
                    sourceCount: 6,
                    signalCount: 3,
                    sourceNames: ['Example', 'IT之家', 'Hacker News'],
                }],
                hasMore: true,
            },
            metadata: { title: 'AI 热点新闻' },
        };

        expect(await adapter.deliver(privateRecord, new AbortController().signal)).toMatchObject({ messageId: 'om_private' });
        expect(calls[0]).toMatchObject({ openId: 'ou_user', title: 'AI 热点新闻' });
        expect(calls[0].content).toContain('[AI 新闻](https://example.com/news)');
        expect(calls[0].content).toContain('Example');
        expect(calls[0].content).toContain('6 个来源 · 3 条关联信号');
        expect(calls[0].content).toContain('信号来源：Example、IT之家、Hacker News');
        expect(calls[0].content).toContain('回复「查看更多」继续下一批');
        expect(calls[0].content).toContain('「搜索 Claude」');
        expect(calls[0].content).toContain('「AI信号」');
        expect(calls[0].content).toContain('「来源 IT之家」');
        expect(calls[0].content).toContain('「今天全部 AI 动态」');
    });

    test('emits bot-scoped audit metadata for a secondary delivery', async () => {
        const secondaryBot = {
            id: 'bot-secondary',
            workspaceId: 'workspace-default',
            platform: 'feishu' as const,
            name: 'Secondary',
            appId: 'cli_secondary',
            secretRef: 'env://SECONDARY_SECRET',
            status: 'active' as const,
            config: {},
        };
        const bots = new BotRegistry([secondaryBot]);
        const audits: any[] = [];
        const adapter = new RoutedFeishuDeliveryAdapter(
            bots,
            'bot-default',
            () => ({} as any),
            { resolve: async () => 'secondary-secret' },
            (bot, _secret, audit) => ({
                deliver: async () => {
                    audit('bot_message_sent', {
                        channel: 'private_markdown',
                        target: 'ou_user',
                        ok: true,
                        message_id: 'om_secondary',
                        chat_id: 'oc_p2p',
                        error: undefined,
                    });
                    return { messageId: 'om_secondary', botId: bot.id };
                },
            }),
            (bot, action, payload) => audits.push({ bot: bot.id, action, payload }),
        );
        const privateRecord = record(secondaryBot.id);
        privateRecord.target = {
            workspaceId: 'workspace-default',
            botInstanceId: secondaryBot.id,
            channel: 'private',
            targetId: 'ou_user',
        };

        expect(await adapter.deliver(privateRecord, new AbortController().signal)).toMatchObject({
            messageId: 'om_secondary',
            botId: secondaryBot.id,
        });
        expect(audits).toEqual([{
            bot: secondaryBot.id,
            action: 'bot_message_sent',
            payload: {
                channel: 'private_markdown',
                target: 'ou_user',
                ok: true,
                message_id: 'om_secondary',
                chat_id: 'oc_p2p',
                error: undefined,
            },
        }]);
    });
});
