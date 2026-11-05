import { z } from 'zod';
import { contentHash } from '../markdown/parser';
import { knowledgeSearchInput, rankNotes } from '../search';
import { fetchPublicPage, publicPageUrl } from './network';
import { parsePage } from './parser';

const urlInput = z.string().trim().min(1).max(1024).transform((value, ctx) => {
    try { return publicPageUrl(value).href; }
    catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid knowledge URL' }); return z.NEVER; }
});
export const webSourceConfig = z.object({
    urls: z.array(urlInput).min(1).max(5).refine(urls => new Set(urls).size === urls.length, 'Duplicate knowledge URL'),
    sourceId: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(64).default('web'),
    maxPageBytes: z.number().int().min(1).max(1024 * 1024).default(512 * 1024),
    maxTotalBytes: z.number().int().min(1).max(4 * 1024 * 1024).default(2 * 1024 * 1024),
    timeoutMs: z.number().int().min(10).max(10_000).default(5000),
}).strict();
export type WebSourceConfig = z.input<typeof webSourceConfig>;
type Page = ReturnType<typeof parsePage> & { url: string; finalUrl: string; fetchedAt: string };

export class WebKnowledgeSource {
    readonly config: z.output<typeof webSourceConfig>;
    private pages: Page[] = [];
    private tail: Promise<void> = Promise.resolve();

    constructor(config: WebSourceConfig, private readonly loadPage: typeof fetchPublicPage = fetchPublicPage) { this.config = webSourceConfig.parse(config); }

    async sync(signal?: AbortSignal) { return (await this.refresh(signal)).report; }

    async search(query: string, limit = 5, signal?: AbortSignal) {
        const input = knowledgeSearchInput.parse({ query, limit });
        const snapshot = await this.refresh(signal);
        const byUrl = new Map(snapshot.pages.map(page => [page.url, page]));
        return {
            source: snapshot.report, query: input.query, retrieval: 'keyword' as const,
            hits: rankNotes(snapshot.pages.map(page => page.note), input.query, signal).slice(0, input.limit).map(({ note, chunk, score, matching }) => {
                const page = byUrl.get(note.path)!;
                return {
                    citationId: contentHash(JSON.stringify([this.config.sourceId, note.path, note.version, chunk.index, chunk.heading, chunk.lineStart, chunk.lineEnd, chunk.text])),
                    sourceId: this.config.sourceId, path: note.path, title: note.title, documentVersion: note.version,
                    heading: chunk.heading, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, excerpt: chunk.text, score, matching,
                    openUri: page.finalUrl, sourceKind: 'web', lineBasis: 'extracted_text', fetchedAt: page.fetchedAt,
                };
            }),
        };
    }

    private refresh(signal?: AbortSignal) {
        const pending = this.tail.then(() => this.readSnapshot(signal));
        this.tail = pending.then(() => {}, () => {});
        return pending;
    }

    private async readSnapshot(signal?: AbortSignal) {
        signal?.throwIfAborted();
        const pages: Page[] = [], failures: Array<{ url: string; reason: string }> = [];
        let bytes = 0, chunks = 0;
        for (const url of this.config.urls) {
            signal?.throwIfAborted();
            try {
                const page = await this.loadPage(url, this.config.maxPageBytes, this.config.timeoutMs, signal);
                bytes += page.body.length;
                if (bytes > this.config.maxTotalBytes) throw new Error('Knowledge source exceeds total byte budget');
                const parsed = parsePage(url, page);
                chunks += parsed.note.chunks.length;
                if (chunks > 10_000) throw new Error('Knowledge source exceeds 10000 chunks');
                pages.push({ ...parsed, url, finalUrl: page.url, fetchedAt: new Date().toISOString() });
            } catch (error) {
                signal?.throwIfAborted();
                if (bytes > this.config.maxTotalBytes || chunks > 10_000) throw error;
                failures.push({ url, reason: error instanceof Error ? error.message.slice(0, 256) : 'Cannot read knowledge page' });
            }
        }
        signal?.throwIfAborted();
        const old = new Map(this.pages.map(page => [page.url, page.note.version]));
        const current = new Set(pages.map(page => page.url));
        const report = {
            sourceId: this.config.sourceId, version: contentHash(pages.map(page => `${page.url}:${page.note.version}`).sort().join('\n')),
            syncedAt: new Date().toISOString(), indexed: pages.length, partial: failures.length > 0, failed: failures.length, failures,
            added: pages.filter(page => !old.has(page.url)).map(page => page.url),
            changed: pages.filter(page => old.has(page.url) && old.get(page.url) !== page.note.version).map(page => page.url),
            removed: [...old.keys()].filter(url => !current.has(url)),
            pages: pages.map(page => ({ url: page.url, finalUrl: page.finalUrl, version: page.note.version, rawVersion: page.rawVersion,
                fetchedAt: page.fetchedAt, mediaType: page.mediaType, extraction: page.extraction })),
        };
        this.pages = pages;
        return { report, pages };
    }
}
