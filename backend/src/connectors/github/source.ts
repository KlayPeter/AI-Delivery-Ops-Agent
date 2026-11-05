import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { EnvironmentSecretResolver, type SecretResolver } from '@/platform/secrets/resolver';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = z.string().datetime({ offset: true });
export const githubConfig = z.object({
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/).refine(value => !['.', '..'].includes(value.split('/')[1]!), 'Invalid repository name'),
    baseBranch: z.string().trim().min(1).max(256).optional(),
    tokenRef: z.string().regex(/^env:\/\/[A-Z][A-Z0-9_]*$/).optional(),
    maxPages: z.number().int().min(1).max(20).default(5),
    timeoutMs: z.number().int().min(10).max(30_000).default(20_000),
}).strict();
export const githubSnapshotInput = z.object({ since: timestamp, until: timestamp.optional() }).strict();
const record = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string().nullable(), updated_at: timestamp,
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])) });
const pullRequest = record.extend({ state: z.literal('closed'), merged_at: timestamp.nullable(), base: z.object({ ref: z.string() }), merge_commit_sha: z.string().nullable() });
const issue = record.extend({ state: z.literal('open'), pull_request: z.object({}).passthrough().optional() });
const textRecord = z.object({ number: z.number().int().positive(), title: z.string().max(256), body: z.string().max(3000), labels: z.array(z.string().max(64)).max(30),
    titleTruncated: z.boolean(), bodyTruncated: z.boolean(), labelsTruncated: z.boolean(), updatedAt: timestamp, url: z.string().url(), version: z.string().regex(/^[a-f0-9]{64}$/) });
const coverage = z.object({ pages: z.number().int().min(1), exhausted: z.boolean(), duplicated: z.boolean(), outputTruncated: z.boolean() });
export const githubSnapshot = z.object({
    repository: z.string(), baseBranch: z.string(), private: z.boolean(), archived: z.boolean(),
    window: z.object({ since: timestamp, until: timestamp }), collectedAt: timestamp, version: z.string().regex(/^[a-f0-9]{64}$/),
    pullRequests: z.array(textRecord.extend({ mergedAt: timestamp, mergeCommitSha: z.string().nullable() })).max(100),
    openIssues: z.array(textRecord).max(100), coverage: z.object({ pullRequests: coverage, openIssues: coverage }),
    consistency: z.literal('live_paginated_not_atomic'),
});
export type GitHubSnapshot = z.infer<typeof githubSnapshot>;
export interface GitHubOptions { fetch?: typeof fetch; secrets?: SecretResolver }

export class GitHubRepositorySource {
    readonly config: z.output<typeof githubConfig>;
    private readonly fetch: typeof fetch;
    private readonly secrets: SecretResolver;

    constructor(config: z.input<typeof githubConfig>, options: GitHubOptions = {}) {
        this.config = githubConfig.parse(config);
        this.fetch = options.fetch || fetch;
        this.secrets = options.secrets || new EnvironmentSecretResolver();
    }

    async snapshot(value: unknown, signal?: AbortSignal): Promise<GitHubSnapshot> {
        const input = githubSnapshotInput.parse(value);
        const collectedAt = new Date().toISOString(), until = input.until || collectedAt;
        if (Date.parse(input.since) >= Date.parse(until) || Date.parse(until) > Date.parse(collectedAt)) throw new Error('GitHub window requires since < until <= now');
        signal?.throwIfAborted();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('GitHub snapshot timed out')), this.config.timeoutMs);
        const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
            const token = this.config.tokenRef ? await this.secrets.resolve(this.config.tokenRef) : undefined;
            active.throwIfAborted();
            const headers = { accept: 'application/vnd.github+json', 'user-agent': 'DeliveryOpsAgent', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) };
            const budget = { bytes: 0 };
            const prefix = `/repos/${this.config.repository}`;
            const metadata = await this.read(`${prefix}`, {}, headers, active, budget);
            const repo = z.object({ full_name: z.string(), default_branch: z.string().min(1).max(256), private: z.boolean(), archived: z.boolean() }).parse(metadata.data);
            if (repo.full_name.toLowerCase() !== this.config.repository.toLowerCase()) throw new Error('GitHub response repository does not match configured scope');
            const baseBranch = this.config.baseBranch || repo.default_branch;
            const pulls = await this.pages(`${prefix}/pulls`, { state: 'closed', base: baseBranch, sort: 'updated', direction: 'desc' }, pullRequest, headers, active, budget);
            const issues = await this.pages(`${prefix}/issues`, { state: 'open', sort: 'updated', direction: 'desc' }, issue, headers, active, budget);
            const normalize = (entry: z.infer<typeof record>, kind: 'pull' | 'issues') => {
                const labels = entry.labels.map(label => typeof label === 'string' ? label : label.name);
                const data = { number: entry.number, title: entry.title.slice(0, 256), body: (entry.body || '').slice(0, 3000),
                    labels: labels.slice(0, 30).map(label => label.slice(0, 64)), titleTruncated: entry.title.length > 256,
                    bodyTruncated: (entry.body?.length || 0) > 3000, labelsTruncated: labels.length > 30 || labels.some(label => label.length > 64),
                    updatedAt: entry.updated_at, url: `https://github.com/${repo.full_name}/${kind}/${entry.number}` };
                return { ...data, version: hash(entry) };
            };
            if (pulls.items.some(item => item.base.ref !== baseBranch)) throw new Error('GitHub pull request base branch does not match configured scope');
            const merged = pulls.items.filter(item => item.merged_at && Date.parse(item.merged_at) >= Date.parse(input.since) && Date.parse(item.merged_at) < Date.parse(until))
                .map(item => ({ ...normalize(item, 'pull'), mergedAt: item.merged_at!, mergeCommitSha: item.merge_commit_sha }))
                .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number);
            const openIssues = issues.items.filter(item => !item.pull_request).map(item => normalize(item, 'issues')).sort((a, b) => a.number - b.number);
            const data = { repository: repo.full_name, baseBranch, private: repo.private, archived: repo.archived,
                window: { since: new Date(input.since).toISOString(), until: new Date(until).toISOString() }, collectedAt,
                pullRequests: merged.slice(0, 100), openIssues: openIssues.slice(0, 100), consistency: 'live_paginated_not_atomic' as const,
                coverage: { pullRequests: { ...pulls.coverage, outputTruncated: merged.length > 100 }, openIssues: { ...issues.coverage, outputTruncated: openIssues.length > 100 } } };
            active.throwIfAborted();
            return githubSnapshot.parse({ ...data, version: hash({ ...data, collectedAt: undefined }) });
        } finally { clearTimeout(timer); }
    }

    private async pages<T extends { number: number }>(path: string, query: Record<string, string>, schema: z.ZodType<T>, headers: Record<string, string>, signal: AbortSignal, budget: { bytes: number }) {
        const items = new Map<number, T>();
        let exhausted = false, duplicated = false, pages = 0;
        for (let page = 1; page <= this.config.maxPages; page++) {
            const result = await this.read(path, { ...query, per_page: '30', page: String(page) }, headers, signal, budget);
            for (const item of z.array(schema).max(30).parse(result.data)) {
                if (items.has(item.number)) duplicated = true;
                items.set(item.number, item);
            }
            pages++;
            if (!/<[^>]+>;\s*rel="next"/.test(result.link || '')) { exhausted = true; break; }
        }
        return { items: [...items.values()], coverage: { pages, exhausted, duplicated } };
    }

    private async read(path: string, query: Record<string, string>, headers: Record<string, string>, signal: AbortSignal, budget: { bytes: number }) {
        const url = new URL(path, 'https://api.github.com');
        url.search = new URLSearchParams(query).toString();
        for (let attempt = 0; attempt < 2; attempt++) {
            signal.throwIfAborted();
            const response = await this.fetch(url, { method: 'GET', headers, redirect: 'error', signal });
            if (!response.ok) {
                await response.body?.cancel();
                const limited = response.status === 429 || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
                const transient = [502, 503, 504].includes(response.status);
                const retryAfter = response.headers.get('retry-after');
                const reset = response.headers.get('x-ratelimit-reset');
                const wait = retryAfter !== null ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())
                    : limited ? (reset && response.headers.get('x-ratelimit-remaining') === '0' ? Number(reset) * 1000 - Date.now() : 60_000) : 250;
                const retryAfterMs = Math.max(0, Number.isFinite(wait) ? wait : 60_000);
                if ((limited || transient) && attempt === 0 && retryAfterMs <= 2000) { await delay(retryAfterMs, undefined, { signal }); continue; }
                throw Object.assign(new Error(`GitHub API returned HTTP ${response.status}${limited ? '; retry after the advertised rate-limit delay' : ''}`), {
                    code: limited ? 'GITHUB_RATE_LIMITED' : `GITHUB_HTTP_${response.status}`, retryable: limited || transient, retryAfterMs: limited ? retryAfterMs : undefined,
                });
            }
            if (!response.body) throw new Error('GitHub API returned an empty response');
            const reader = response.body.getReader();
            const parts: Uint8Array[] = [];
            let bytes = 0;
            const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            try {
                while (true) {
                    signal.throwIfAborted();
                    const { done, value } = await reader.read();
                    if (done) break;
                    if ((bytes += value.byteLength) > 4 * 1024 * 1024) throw new Error('GitHub API response exceeds 4 MiB');
                    if ((budget.bytes += value.byteLength) > 16 * 1024 * 1024) throw new Error('GitHub snapshot exceeds 16 MiB');
                    parts.push(value);
                }
                signal.throwIfAborted();
                return { data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))), link: response.headers.get('link') };
            } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        throw new Error('GitHub retry exhausted');
    }
}
