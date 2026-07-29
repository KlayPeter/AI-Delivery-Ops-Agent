import { describe, expect, test } from 'bun:test';
import {
    AI_NEWS_RADAR_CAPABILITY,
    aiNewsRadarManifest,
    registerAiNewsRadarAgent,
} from '@/agents/native/ai-news-radar/aiNewsRadarAgent';
import { createAiNewsIntentRouter, isAiNewsIntent } from '@/agents/native/ai-news-radar/intent';
import { AiHotNewsProvider } from '@/agents/native/ai-news-radar/provider';
import { AgentRegistry } from '@/platform/agents/registry';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { AgentRuntime } from '@/platform/agents/runtime';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { BotRegistry } from '@/platform/bots/registry';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';

describe('AI News Radar intent routing', () => {
    test('recognizes explicit AI news queries for the existing bot', () => {
        expect(isAiNewsIntent('今天 AI 圈有什么热点')).toBe(true);
        expect(isAiNewsIntent('最近三天 OpenAI 的全部模型新闻')).toBe(true);
        expect(isAiNewsIntent('昨天的 AI 日报')).toBe(true);
        expect(isAiNewsIntent('AI新闻')).toBe(true);
        expect(isAiNewsIntent('AI信号')).toBe(true);
        expect(isAiNewsIntent('搜索 Claude')).toBe(true);
        expect(isAiNewsIntent('AI论文')).toBe(true);
    });

    test('does not steal task, negated, or configuration messages', () => {
        expect(isAiNewsIntent('创建一个 AI 新闻助手开发任务')).toBe(false);
        expect(isAiNewsIntent('不要查询 AI 新闻')).toBe(false);
        expect(isAiNewsIntent('AI 新闻功能怎么用')).toBe(false);
        expect(isAiNewsIntent('生成项目日报')).toBe(false);
        expect(isAiNewsIntent('不要看 AI 信号')).toBe(false);
    });

    test('routes ambiguous follow-ups only inside a recent AI news conversation', () => {
        const route = createAiNewsIntentRouter();
        expect(route({ chat_id: 'oc_other', text: '查看更多' })).toBe(false);
        expect(route({ chat_id: 'oc_news', text: '今天 AI 圈有什么热点' })).toBe(true);
        expect(route({ chat_id: 'oc_news', text: '查看更多' })).toBe(true);
        expect(route({ chat_id: 'oc_news', text: '来源 IT之家' })).toBe(true);
        expect(route({ chat_id: 'oc_other', text: '来源 IT之家' })).toBe(false);
    });
});

describe('AI News Radar provider', () => {
    test('translates a Chinese news request into a bounded, sanitized article list', async () => {
        let requested: URL | null = null;
        const provider = new AiHotNewsProvider({
            baseUrl: 'https://aihot.example.com',
            defaultLimit: 10,
            fetch: async input => {
                requested = new URL(String(input));
                return Response.json({
                    schemaVersion: 1,
                    items: [
                        {
                            title: ' OpenAI 发布新模型 ',
                            links: {
                                original: 'https://openai.com/news/model',
                                aihot: 'https://aihot.example.com/items/1',
                            },
                            source: { name: 'OpenAI Blog' },
                            summary: ' 新能力摘要 ',
                            publishedAt: '2026-07-29T01:00:00.000Z',
                            category: 'ai-models',
                        },
                        {
                            title: '危险链接',
                            links: { original: 'javascript:alert(1)', aihot: 'https://aihot.example.com/items/2' },
                            source: { name: 'bad' },
                        },
                    ],
                    page: { count: 2, hasMore: true, nextCursor: 'cursor-2' },
                });
            },
        });

        const result = await provider.fetch({
            prompt: '最近三天 OpenAI 的全部模型新闻',
            limit: 5,
            now: new Date('2026-07-29T08:00:00.000Z'),
        }, new AbortController().signal);

        expect(requested!.pathname).toBe('/api/v1/items');
        expect(requested!.searchParams.get('mode')).toBe('all');
        expect(requested!.searchParams.get('category')).toBe('ai-models');
        expect(requested!.searchParams.get('q')).toBe('OpenAI');
        expect(requested!.searchParams.get('limit')).toBe('5');
        expect(requested!.searchParams.get('window')).toBe('7d');
        expect(requested!.searchParams.get('by')).toBe('published');
        expect(result.articles).toEqual([{
            title: 'OpenAI 发布新模型',
            url: 'https://openai.com/news/model',
            source: 'OpenAI Blog',
            summary: '新能力摘要',
            publishedAt: '2026-07-29T01:00:00.000Z',
            category: 'ai-models',
        }]);
        expect(result.stale).toBe(false);
        expect(result).toMatchObject({ queryKind: 'items', hasMore: true, nextCursor: 'cursor-2' });
    });

    test('uses the daily endpoint only for an explicit daily request', async () => {
        let requested = '';
        const provider = new AiHotNewsProvider({
            baseUrl: 'https://aihot.example.com',
            fetch: async input => {
                requested = String(input);
                return Response.json({
                    schemaVersion: 1,
                    report: {
                        date: '2026-07-28',
                        generatedAt: '2026-07-29T00:00:00.000Z',
                        sections: [{
                            label: '论文研究',
                            items: [{
                                title: '一篇论文',
                                links: { original: 'https://example.com/paper', aihot: null },
                                source: { name: 'Example Research' },
                                summary: '论文摘要',
                            }],
                        }],
                        flashes: [],
                    },
                });
            },
        });

        const result = await provider.fetch({
            prompt: '昨天的 AI 日报',
            now: new Date('2026-07-29T08:00:00.000Z'),
        }, new AbortController().signal);

        expect(new URL(requested).pathname).toBe('/api/v1/dailies/2026-07-28');
        expect(result.title).toBe('AI 日报 · 2026-07-28');
        expect(result.articles[0]).toMatchObject({ source: 'Example Research', category: 'paper' });
    });

    test('supports arbitrary keyword search and multi-source AI signals', async () => {
        const requested: URL[] = [];
        const provider = new AiHotNewsProvider({
            baseUrl: 'https://aihot.example.com',
            fetch: async input => {
                const url = new URL(String(input));
                requested.push(url);
                if (url.pathname.endsWith('/hot-topics')) {
                    return Response.json({
                        schemaVersion: 1,
                        items: [{
                            title: 'Kimi K3 开放日',
                            links: { original: 'https://example.com/kimi', aihot: 'https://aihot.example.com/items/kimi' },
                            source: { name: 'Kimi' },
                            latestAt: '2026-07-29T02:00:00.000Z',
                            sourceCount: 25,
                            signalCount: 8,
                            sourceNames: ['Kimi', 'IT之家', 'Hacker News'],
                        }],
                    });
                }
                return Response.json({
                    schemaVersion: 1,
                    items: [],
                    page: { count: 0, hasMore: false, nextCursor: null },
                });
            },
        });

        await provider.fetch({ prompt: '搜索 具身智能' }, new AbortController().signal);
        const signals = await provider.fetch({ prompt: 'AI信号' }, new AbortController().signal);

        expect(requested[0].pathname).toBe('/api/v1/items');
        expect(requested[0].searchParams.get('q')).toBe('具身智能');
        expect(requested[0].searchParams.get('category')).toBeNull();
        expect(requested[1].pathname).toBe('/api/v1/hot-topics');
        expect(signals).toMatchObject({
            title: 'AI 多源热点信号',
            queryKind: 'signals',
            articles: [{
                sourceCount: 25,
                signalCount: 8,
                sourceNames: ['Kimi', 'IT之家', 'Hacker News'],
            }],
        });
    });

    test('filters recent public items by source name with bounded paging', async () => {
        let requested: URL | null = null;
        const provider = new AiHotNewsProvider({
            baseUrl: 'https://aihot.example.com',
            fetch: async input => {
                requested = new URL(String(input));
                return Response.json({
                    schemaVersion: 1,
                    items: [
                        {
                            title: '命中',
                            links: { original: 'https://example.com/hit', aihot: 'https://aihot.example.com/items/hit' },
                            source: { name: 'IT之家（RSS）' },
                        },
                        {
                            title: '未命中',
                            links: { original: 'https://example.com/miss', aihot: 'https://aihot.example.com/items/miss' },
                            source: { name: '其他来源' },
                        },
                    ],
                    page: { count: 2, hasMore: false, nextCursor: null },
                });
            },
        });

        const result = await provider.fetch({ prompt: '来源 IT之家' }, new AbortController().signal);

        expect(requested!.pathname).toBe('/api/v1/items');
        expect(requested!.searchParams.get('mode')).toBe('all');
        expect(requested!.searchParams.get('limit')).toBe('100');
        expect(result).toMatchObject({
            title: 'AI 来源 · IT之家',
            queryKind: 'source',
            articles: [{ title: '命中', source: 'IT之家（RSS）' }],
        });
    });

    test('restarts the same query when a rolling-window cursor is rejected', async () => {
        const cursors: Array<string | null> = [];
        const provider = new AiHotNewsProvider({
            baseUrl: 'https://aihot.example.com',
            fetch: async input => {
                const url = new URL(String(input));
                cursors.push(url.searchParams.get('cursor'));
                if (cursors.length === 1) return Response.json({ code: 'invalid_cursor' }, { status: 400 });
                return Response.json({
                    schemaVersion: 1,
                    items: [{
                        title: '最新结果',
                        links: { original: 'https://example.com/latest', aihot: 'https://aihot.example.com/items/latest' },
                        source: { name: 'Example' },
                    }],
                    page: { count: 1, hasMore: false, nextCursor: null },
                });
            },
        });

        const result = await provider.fetch({
            prompt: '今天 AI 圈有什么热点',
            cursor: 'expired-cursor',
        }, new AbortController().signal);

        expect(cursors).toEqual(['expired-cursor', null]);
        expect(result.articles[0]?.title).toBe('最新结果');
    });

    test('rejects oversized provider responses before parsing', async () => {
        const provider = new AiHotNewsProvider({
            baseUrl: 'https://aihot.example.com',
            maxResponseBytes: 1024,
            fetch: async () => new Response('{}', { headers: { 'content-length': '2048' } }),
        });

        await expect(provider.fetch({}, new AbortController().signal)).rejects.toMatchObject({
            code: 'AI_NEWS_RESPONSE_TOO_LARGE',
            retryable: false,
        });
    });
});

describe('AI News Radar Agent', () => {
    test('runs through the standard Agent Runtime and emits an article_list artifact without a model', async () => {
        const registry = new AgentRegistry();
        registry.register(aiNewsRadarManifest);
        registry.install({
            id: 'install-news',
            workspaceId: 'workspace-default',
            agentId: aiNewsRadarManifest.id,
            version: aiNewsRadarManifest.version,
            status: 'active',
            config: {},
            secretRefs: {},
        });
        registry.bind({
            id: 'bind-news',
            botInstanceId: 'bot-ai-news',
            agentInstallationId: 'install-news',
            enabled: true,
            priority: 1,
            capabilities: [AI_NEWS_RADAR_CAPABILITY],
            routingConfig: {},
            configOverride: {},
        });
        const bots = new BotRegistry([{
            id: 'bot-ai-news',
            workspaceId: 'workspace-default',
            platform: 'feishu',
            name: 'AI热点新闻助手',
            appId: 'cli_aaaaaaaaaaaaaaaa',
            secretRef: 'env://FEISHU_AI_NEWS_APP_SECRET',
            status: 'active',
            config: {},
        }]);
        const adapter = new NativeAgentAdapter();
        const queries: any[] = [];
        registerAiNewsRadarAgent(adapter, () => ({
            fetch: async query => {
                queries.push(query);
                return ({
                title: 'AI 热点新闻',
                articles: [{ title: '新闻', url: 'https://example.com/news', source: 'Example' }],
                generatedAt: '2026-07-29T08:00:00.000Z',
                source: 'example.com',
                stale: false,
                hasMore: queries.length === 1,
                nextCursor: queries.length === 1 ? 'cursor-2' : undefined,
                queryKind: 'items',
            });
            },
        }));
        const runtime = new AgentRuntime(registry, bots, new InMemoryAgentRunStore(), [adapter]);
        const scope = createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-ai-news',
            triggerType: 'message',
            triggerId: 'om_news',
            conversationId: 'oc_p2p',
            actorId: 'ou_user',
        });
        const trigger = createTriggerEnvelope({
            occurredAt: '2026-07-29T08:00:00.000Z',
            scope,
            payload: { prompt: '今天 AI 新闻' },
        });

        const result = await runtime.execute(trigger, AI_NEWS_RADAR_CAPABILITY, trigger.payload);

        expect(result.run.status).toBe('succeeded');
        expect(result.artifacts).toHaveLength(1);
        expect(result.artifacts[0]).toMatchObject({
            type: 'article_list',
            content: {
                articles: [{ title: '新闻', url: 'https://example.com/news', source: 'Example' }],
                hasMore: true,
            },
        });
        expect(result.result.metrics).toBeUndefined();

        const moreScope = createTriggerScope({
            workspaceId: 'workspace-default',
            botInstanceId: 'bot-ai-news',
            triggerType: 'message',
            triggerId: 'om_news_more',
            conversationId: 'oc_p2p',
            actorId: 'ou_user',
        });
        const moreTrigger = createTriggerEnvelope({
            occurredAt: '2026-07-29T08:01:00.000Z',
            scope: moreScope,
            payload: { prompt: '查看更多' },
        });
        const moreResult = await runtime.execute(moreTrigger, AI_NEWS_RADAR_CAPABILITY, moreTrigger.payload);

        expect(moreResult.run.status).toBe('succeeded');
        expect(queries).toEqual([
            { prompt: '今天 AI 新闻', limit: undefined, cursor: undefined },
            { prompt: '今天 AI 新闻', limit: 20, cursor: 'cursor-2' },
        ]);
        expect(moreResult.artifacts[0]).toMatchObject({
            content: { continued: true, requestedMore: true, hasMore: false },
        });
    });
});
