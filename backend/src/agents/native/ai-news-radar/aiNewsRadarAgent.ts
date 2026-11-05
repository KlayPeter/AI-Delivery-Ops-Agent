import type { AgentManifest } from '@/platform/agents/contracts';
import type { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import type { AiNewsProvider } from './provider';

export const AI_NEWS_RADAR_AGENT_ID = 'native.ai-news-radar';
export const AI_NEWS_RADAR_CAPABILITY = 'knowledge.ai.news.fetch';

const MORE_REQUEST = /^(?:请)?(?:继续|查看更多|看更多|更多|再来(?:一点|一些|点)?|再给(?:一点|一些|点)?|下一页|下页)(?:新闻|资讯|动态|内容)?[。！!？?]?$/;
const CONTINUATION_TTL_MS = 30 * 60_000;
const MAX_CONTINUATIONS = 500;
const MORE_PAGE_LIMIT = 20;

interface NewsContinuation {
    prompt: string;
    cursor: string;
    expiresAt: number;
}

export const aiNewsRadarManifest: AgentManifest = {
    schemaVersion: '1.0',
    id: AI_NEWS_RADAR_AGENT_ID,
    name: 'AI News Radar Agent',
    version: '1.0.0',
    description: 'Fetches current AI news from a governed external data provider and returns a traceable article list.',
    runtime: { type: 'native' },
    capabilities: [AI_NEWS_RADAR_CAPABILITY],
    triggers: ['message', 'manual', 'schedule'],
    inputSchema: {
        type: 'object',
        properties: {
            prompt: { type: 'string' },
            limit: { type: 'integer' },
        },
    },
    outputSchema: {
        type: 'object',
        required: ['count', 'source'],
        properties: {
            count: { type: 'integer' },
            source: { type: 'string' },
            stale: { type: 'boolean' },
        },
    },
    requirements: { tools: [], secrets: [], networkHosts: ['aihot.virxact.com'] },
    limits: { timeoutSeconds: 15, maxSteps: 2, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['article_list'], directDelivery: false },
};

export function registerAiNewsRadarAgent(adapter: Pick<NativeAgentAdapter, 'register'>, provider: () => AiNewsProvider): void {
    const continuations = new Map<string, NewsContinuation>();
    adapter.register(aiNewsRadarManifest.id, aiNewsRadarManifest.version, async (request, _resolved, signal) => {
        try {
            const input = request.input && typeof request.input === 'object'
                ? request.input as { prompt?: unknown; limit?: unknown }
                : {};
            const rawPrompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
            const continuationKey = [
                request.scope.botInstanceId,
                request.scope.conversationId || request.scope.actorId || request.runId,
            ].join(':');
            const now = Date.now();
            for (const [key, value] of continuations) {
                if (value.expiresAt <= now) continuations.delete(key);
            }
            const moreRequested = MORE_REQUEST.test(rawPrompt);
            const previous = moreRequested ? continuations.get(continuationKey) : undefined;
            const prompt = previous?.prompt || (moreRequested ? '今天 AI 圈有什么热点' : rawPrompt);
            const result = await provider().fetch({
                prompt,
                limit: moreRequested ? MORE_PAGE_LIMIT : (typeof input.limit === 'number' ? input.limit : undefined),
                cursor: previous?.cursor,
            }, signal);
            if (result.nextCursor) {
                continuations.delete(continuationKey);
                continuations.set(continuationKey, {
                    prompt,
                    cursor: result.nextCursor,
                    expiresAt: now + CONTINUATION_TTL_MS,
                });
                while (continuations.size > MAX_CONTINUATIONS) {
                    const oldest = continuations.keys().next().value;
                    if (!oldest) break;
                    continuations.delete(oldest);
                }
            } else {
                continuations.delete(continuationKey);
            }
            return {
                status: 'succeeded',
                data: { count: result.articles.length, source: result.source, stale: result.stale },
                artifacts: [{
                    type: 'article_list',
                    mediaType: 'application/vnd.delivery-ops.article-list+json',
                    schemaVersion: '1.0',
                    content: {
                        articles: result.articles,
                        generatedAt: result.generatedAt,
                        source: result.source,
                        stale: result.stale,
                        hasMore: result.hasMore === true,
                        queryKind: result.queryKind || 'items',
                        continued: moreRequested && !!previous,
                        requestedMore: moreRequested,
                    },
                    metadata: {
                        title: result.title,
                        source: result.source,
                        stale: result.stale,
                    },
                }],
            };
        } catch (cause: any) {
            return {
                status: 'failed',
                artifacts: [],
                error: {
                    code: cause?.code || 'AI_NEWS_FETCH_FAILED',
                    message: cause?.message || String(cause),
                    retryable: cause?.retryable === true,
                },
            };
        }
    });
}
