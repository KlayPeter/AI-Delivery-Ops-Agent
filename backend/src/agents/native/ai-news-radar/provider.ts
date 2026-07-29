export interface AiNewsArticle {
    title: string;
    url: string;
    summary?: string;
    source: string;
    publishedAt?: string;
    category?: string;
    sourceCount?: number;
    signalCount?: number;
    sourceNames?: string[];
}

export type AiNewsQueryKind = 'items' | 'daily' | 'signals' | 'source';

export interface AiNewsQuery {
    prompt?: string;
    limit?: number;
    now?: Date;
    cursor?: string;
}

export interface AiNewsResult {
    title: string;
    articles: AiNewsArticle[];
    generatedAt: string;
    source: string;
    stale: boolean;
    queryKind?: AiNewsQueryKind;
    hasMore?: boolean;
    nextCursor?: string;
}

export interface AiNewsProvider {
    fetch(query: AiNewsQuery, signal: AbortSignal): Promise<AiNewsResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AiHotNewsProviderOptions {
    baseUrl: string;
    defaultLimit?: number;
    timeoutMs?: number;
    maxResponseBytes?: number;
    fetch?: FetchLike;
}

const CATEGORY_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
    { category: 'ai-models', pattern: /模型|大模型|LLM/i },
    { category: 'ai-products', pattern: /产品|应用|工具/i },
    { category: 'industry', pattern: /行业|公司|融资|政策/i },
    { category: 'paper', pattern: /论文|研究|paper/i },
    { category: 'tip', pattern: /技巧|观点|教程|方法/i },
];

const KNOWN_SEARCH_TERMS = /\b(OpenAI|Anthropic|Google|Gemini|Claude|GPT(?:-\d+(?:\.\d+)?)?|Sora|Kimi|DeepSeek|Qwen|Llama|Mistral|RAG)\b/i;
const SIGNAL_REQUEST = /(?:AI\s*信号|热点信号|多源热点|多源信号)/i;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class AiHotNewsProvider implements AiNewsProvider {
    private readonly baseUrl: URL;
    private readonly defaultLimit: number;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly fetcher: FetchLike;

    constructor(options: AiHotNewsProviderOptions) {
        this.baseUrl = this.validateBaseUrl(options.baseUrl);
        this.defaultLimit = this.clampLimit(options.defaultLimit ?? 15);
        this.timeoutMs = Math.max(1000, Math.min(30000, options.timeoutMs ?? 10000));
        this.maxResponseBytes = Math.max(1024, Math.min(2 * 1024 * 1024, options.maxResponseBytes ?? 1024 * 1024));
        this.fetcher = options.fetch || fetch;
    }

    async fetch(query: AiNewsQuery, signal: AbortSignal): Promise<AiNewsResult> {
        const prompt = String(query.prompt || '').trim();
        const now = query.now || new Date();
        const limit = this.clampLimit(query.limit ?? this.defaultLimit);
        if (prompt.includes('日报')) return this.fetchDaily(prompt, now, limit, signal);
        if (SIGNAL_REQUEST.test(prompt)) return this.fetchSignals(now, limit, signal);
        const sourceFilter = this.sourceFilter(prompt);
        if (sourceFilter) return this.fetchBySource(sourceFilter, now, limit, query.cursor, signal);
        return this.fetchItems(prompt, now, limit, query.cursor, signal);
    }

    private async fetchItems(
        prompt: string,
        now: Date,
        limit: number,
        cursor: string | undefined,
        signal: AbortSignal,
    ): Promise<AiNewsResult> {
        const endpoint = new URL('/api/v1/items', this.baseUrl);
        const category = CATEGORY_PATTERNS.find(item => item.pattern.test(prompt))?.category;
        const search = this.searchTerm(prompt);
        const hours = this.windowHours(prompt);
        endpoint.searchParams.set('mode', /全部|完整|所有|全量/.test(prompt) ? 'all' : 'selected');
        endpoint.searchParams.set('window', hours <= 24 ? '24h' : '7d');
        endpoint.searchParams.set('by', 'published');
        endpoint.searchParams.set('limit', String(limit));
        if (category) endpoint.searchParams.set('category', category);
        if (search) endpoint.searchParams.set('q', search);
        if (cursor) endpoint.searchParams.set('cursor', cursor);

        const page = await this.requestItemsPage(endpoint, signal);
        const cutoff = now.getTime() - hours * 3600_000;
        const articles = page.items
            .map((item: unknown) => this.normalizeArticle(item))
            .filter((item: AiNewsArticle | null): item is AiNewsArticle => item !== null)
            .filter(article => !article.publishedAt || new Date(article.publishedAt).getTime() >= cutoff)
            .slice(0, limit);
        return {
            title: search ? `AI 搜索 · ${search}` : (category ? this.categoryTitle(category) : 'AI 热点新闻'),
            articles,
            generatedAt: now.toISOString(),
            source: this.baseUrl.hostname,
            stale: this.isStale(articles, now),
            queryKind: 'items',
            hasMore: page.hasMore,
            nextCursor: page.hasMore ? page.nextCursor : undefined,
        };
    }

    private async fetchBySource(
        sourceFilter: string,
        now: Date,
        limit: number,
        initialCursor: string | undefined,
        signal: AbortSignal,
    ): Promise<AiNewsResult> {
        const articles: AiNewsArticle[] = [];
        let cursor = initialCursor;
        let hasMore = true;
        let pages = 0;
        while (hasMore && articles.length < limit && pages < 3) {
            const endpoint = new URL('/api/v1/items', this.baseUrl);
            endpoint.searchParams.set('mode', 'all');
            endpoint.searchParams.set('window', '7d');
            endpoint.searchParams.set('limit', '100');
            if (cursor) endpoint.searchParams.set('cursor', cursor);
            const page = await this.requestItemsPage(endpoint, signal);
            articles.push(...page.items
                .map((item: unknown) => this.normalizeArticle(item))
                .filter((item: AiNewsArticle | null): item is AiNewsArticle => item !== null)
                .filter(article => article.source.toLocaleLowerCase().includes(sourceFilter.toLocaleLowerCase())));
            cursor = page.nextCursor;
            hasMore = page.hasMore;
            pages++;
        }
        return {
            title: `AI 来源 · ${sourceFilter}`,
            articles: articles.slice(0, limit),
            generatedAt: now.toISOString(),
            source: this.baseUrl.hostname,
            stale: this.isStale(articles, now),
            queryKind: 'source',
            hasMore,
            nextCursor: hasMore ? cursor : undefined,
        };
    }

    private async fetchSignals(now: Date, limit: number, signal: AbortSignal): Promise<AiNewsResult> {
        const endpoint = new URL('/api/v1/hot-topics', this.baseUrl);
        const body = await this.requestJson(endpoint, signal);
        if (!body || typeof body !== 'object' || !Array.isArray((body as any).items)) {
            throw this.error('AI_NEWS_INVALID_RESPONSE', 'AI 信号数据格式不正确', false);
        }
        const articles = (body as any).items
            .map((item: unknown) => this.normalizeArticle(item))
            .filter((item: AiNewsArticle | null): item is AiNewsArticle => item !== null)
            .slice(0, limit);
        return {
            title: 'AI 多源热点信号',
            articles,
            generatedAt: now.toISOString(),
            source: this.baseUrl.hostname,
            stale: this.isStale(articles, now),
            queryKind: 'signals',
            hasMore: false,
        };
    }

    private async fetchDaily(prompt: string, now: Date, limit: number, signal: AbortSignal): Promise<AiNewsResult> {
        const explicitDate = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(prompt)?.[1];
        const requestedDate = explicitDate || (/昨天/.test(prompt) ? this.shanghaiDate(new Date(now.getTime() - 24 * 3600_000)) : null);
        const endpoint = new URL(requestedDate ? `/api/v1/dailies/${requestedDate}` : '/api/v1/dailies/latest', this.baseUrl);
        const body = await this.requestJson(endpoint, signal);
        const report = body && typeof body === 'object' ? (body as any).report : null;
        if (!report || !Array.isArray(report.sections)) {
            throw this.error('AI_NEWS_INVALID_RESPONSE', 'AI 日报数据格式不正确', false);
        }
        const sectionArticles = report.sections.flatMap((section: any) =>
            Array.isArray(section?.items) ? section.items.map((item: any) => ({
                title: item?.title,
                links: item?.links,
                summary: item?.summary,
                source: item?.source,
                category: this.categoryFromLabel(section?.label),
            })) : [],
        );
        const flashes = Array.isArray(report.flashes) ? report.flashes : [];
        const articles = [...sectionArticles, ...flashes]
            .map((item: unknown) => this.normalizeArticle(item))
            .filter((item: AiNewsArticle | null): item is AiNewsArticle => item !== null)
            .slice(0, limit);
        return {
            title: `AI 日报 · ${String(report.date || requestedDate || this.shanghaiDate(now))}`,
            articles,
            generatedAt: String(report.generatedAt || now.toISOString()),
            source: this.baseUrl.hostname,
            stale: false,
            queryKind: 'daily',
            hasMore: false,
        };
    }

    private itemsPage(body: unknown): { items: unknown[]; hasMore: boolean; nextCursor?: string } {
        if (!body || typeof body !== 'object' || !Array.isArray((body as any).items)) {
            throw this.error('AI_NEWS_INVALID_RESPONSE', 'AI 新闻数据格式不正确', false);
        }
        const page = (body as any).page;
        if (!page || typeof page !== 'object') {
            throw this.error('AI_NEWS_INVALID_RESPONSE', 'AI 新闻分页数据格式不正确', false);
        }
        const nextCursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        return { items: (body as any).items, hasMore: page.hasMore === true && !!nextCursor, nextCursor };
    }

    private async requestItemsPage(
        endpoint: URL,
        signal: AbortSignal,
    ): Promise<{ items: unknown[]; hasMore: boolean; nextCursor?: string }> {
        try {
            return this.itemsPage(await this.requestJson(endpoint, signal));
        } catch (cause: any) {
            if (!endpoint.searchParams.has('cursor') || cause?.status !== 400) throw cause;
            endpoint.searchParams.delete('cursor');
            return this.itemsPage(await this.requestJson(endpoint, signal));
        }
    }

    private async requestJson(endpoint: URL, signal: AbortSignal): Promise<unknown> {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const combined = AbortSignal.any([signal, timeoutSignal]);
        let response: Response;
        try {
            response = await this.fetcher(endpoint, {
                method: 'GET',
                redirect: 'error',
                signal: combined,
                headers: { accept: 'application/json', 'user-agent': BROWSER_USER_AGENT },
            });
        } catch (cause: any) {
            const timedOut = timeoutSignal.aborted && !signal.aborted;
            throw this.error(timedOut ? 'AI_NEWS_TIMEOUT' : 'AI_NEWS_UNAVAILABLE', timedOut ? 'AI 新闻数据源请求超时' : `AI 新闻数据源不可用：${cause?.message || String(cause)}`, true);
        }
        if (!response.ok) {
            throw Object.assign(
                this.error('AI_NEWS_HTTP_ERROR', `AI 新闻数据源返回 HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500),
                { status: response.status },
            );
        }
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > this.maxResponseBytes) throw this.error('AI_NEWS_RESPONSE_TOO_LARGE', 'AI 新闻响应超过大小限制', false);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.maxResponseBytes) throw this.error('AI_NEWS_RESPONSE_TOO_LARGE', 'AI 新闻响应超过大小限制', false);
        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            throw this.error('AI_NEWS_INVALID_JSON', 'AI 新闻数据源返回了无效 JSON', false);
        }
    }

    private normalizeArticle(value: unknown): AiNewsArticle | null {
        if (!value || typeof value !== 'object') return null;
        const item = value as Record<string, any>;
        const title = this.text(item.title, 200);
        const rawUrl = this.text(item.links?.original || item.links?.aihot || item.url, 2048);
        const source = this.text(typeof item.source === 'object' ? item.source?.name : item.source, 100) || '未知来源';
        if (!title || !rawUrl) return null;
        let url: URL;
        try { url = new URL(rawUrl); } catch { return null; }
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        const sourceNames = Array.isArray(item.sourceNames)
            ? item.sourceNames.map((name: unknown) => this.text(name, 100)).filter(Boolean).slice(0, 12)
            : undefined;
        return {
            title,
            url: url.toString(),
            summary: this.text(item.summary, 300) || undefined,
            source,
            publishedAt: this.validDate(item.publishedAt || item.latestAt),
            category: this.text(item.category, 40) || undefined,
            sourceCount: this.nonNegativeInteger(item.sourceCount),
            signalCount: this.nonNegativeInteger(item.signalCount),
            sourceNames: sourceNames?.length ? sourceNames : undefined,
        };
    }

    private validateBaseUrl(value: string): URL {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('AI_NEWS_SOURCE_URL must be a credential-free HTTPS URL');
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        return url;
    }

    private windowHours(prompt: string): number {
        const days = /最近\s*(\d+)\s*天/.exec(prompt);
        if (days) return Math.max(1, Math.min(7, Number(days[1]))) * 24;
        if (/最近一周|这周|本周/.test(prompt)) return 7 * 24;
        if (/最近三天/.test(prompt)) return 3 * 24;
        if (/今天|过去\s*24\s*小时|最近|最新/.test(prompt)) return 24;
        return 24;
    }

    private searchTerm(prompt: string): string | undefined {
        const explicit = /(?:搜索|检索|查找|搜一下|查一下)\s*[：:]?\s*([^，。！？\n]{2,200})/i.exec(prompt)?.[1];
        const candidate = explicit || prompt.match(KNOWN_SEARCH_TERMS)?.[1];
        if (!candidate) return undefined;
        const normalized = candidate
            .replace(/(?:相关)?(?:的)?(?:AI)?(?:新闻|资讯|动态|信号).*$/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        return [...normalized].length >= 2 ? normalized : undefined;
    }

    private sourceFilter(prompt: string): string | undefined {
        const match = /(?:来源|信源)\s*[：:]?\s*([^，。！？\n]{2,100})/i.exec(prompt)?.[1];
        if (!match) return undefined;
        const normalized = match
            .replace(/(?:相关)?(?:的)?(?:AI)?(?:新闻|资讯|动态|信号).*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        return normalized || undefined;
    }

    private clampLimit(value: number): number {
        return Number.isInteger(value) ? Math.max(1, Math.min(20, value)) : 15;
    }

    private isStale(articles: AiNewsArticle[], now: Date): boolean {
        const newest = articles.map(article => article.publishedAt).filter(Boolean).sort().at(-1);
        return newest ? now.getTime() - new Date(newest).getTime() > 36 * 3600_000 : articles.length > 0;
    }

    private shanghaiDate(value: Date): string {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(value);
    }

    private nonNegativeInteger(value: unknown): number | undefined {
        const number = Number(value);
        return Number.isInteger(number) && number >= 0 ? number : undefined;
    }

    private text(value: unknown, maxLength: number): string {
        return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
    }

    private validDate(value: unknown): string | undefined {
        if (typeof value !== 'string') return undefined;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    private categoryTitle(category: string): string {
        return ({
            'ai-models': 'AI 模型动态',
            'ai-products': 'AI 产品动态',
            industry: 'AI 行业动态',
            paper: 'AI 论文研究',
            tip: 'AI 技巧与观点',
        } as Record<string, string>)[category] || 'AI 热点新闻';
    }

    private categoryFromLabel(label: unknown): string | undefined {
        return ({
            '模型发布/更新': 'ai-models',
            '产品发布/更新': 'ai-products',
            '行业动态': 'industry',
            '论文研究': 'paper',
            '技巧与观点': 'tip',
        } as Record<string, string>)[String(label || '')];
    }

    private error(code: string, message: string, retryable: boolean): Error {
        return Object.assign(new Error(message), { code, retryable });
    }
}
