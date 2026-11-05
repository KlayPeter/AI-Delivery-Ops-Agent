import { describe, expect, test } from 'bun:test';
import { GitHubRepositorySource, githubConfig } from '@/connectors/github/source';
import { MapSecretResolver } from '@/platform/secrets/resolver';
import { githubFixture, repository, window, pr, openIssue } from './helpers/github';

describe('GitHub repository facts', () => {
    test('reads only configured repository and branch, applies a half-open merged window and excludes PR-shaped issues', async () => {
        const f = githubFixture();
        f.state.pulls = [pr(1), pr(3, { merged_at: window.since }), pr(4, { merged_at: window.until }), pr(5, { merged_at: null }), pr(6, { merged_at: '2026-09-30T23:59:59Z' })];
        f.state.issues.push(openIssue(7, { pull_request: { url: 'ignored' } }));
        const source = new GitHubRepositorySource({ repository }, f);
        const result = await source.snapshot(window);
        expect(result.pullRequests.map(item => item.number)).toEqual([3, 1]);
        expect(result.openIssues.map(item => item.number)).toEqual([2]);
        expect(result.consistency).toBe('live_paginated_not_atomic');
        expect(result.coverage.pullRequests.exhausted).toBe(true);
        expect(f.calls).toHaveLength(3);
        for (const call of f.calls) {
            expect(call.url.origin).toBe('https://api.github.com');
            expect(call.init?.method).toBe('GET');
            expect(call.init?.redirect).toBe('error');
        }
        expect(f.calls[1]!.url.searchParams.get('base')).toBe('main');
        expect((await source.snapshot(window)).version).toBe(result.version);
    });

    test('rejects caller scope overrides and invalid or future windows before network IO', async () => {
        const f = githubFixture(), source = new GitHubRepositorySource({ repository }, f);
        for (const input of [{ ...window, repository: 'another/repo' }, { since: window.until, until: window.since }, { since: 'not-a-date' }, { since: window.since, until: '2099-01-01T00:00:00Z' }]) await expect(source.snapshot(input)).rejects.toThrow();
        for (const value of ['https://github.com/a/b', 'a/../b', 'a/..', 'a/b?token=secret']) expect(() => githubConfig.parse({ repository: value })).toThrow();
        expect(() => githubConfig.parse({ repository, tokenRef: 'inline-secret' })).toThrow();
        expect(f.calls).toHaveLength(0);
    });

    test('uses an explicit Secret reference, does not return it and never follows next-link URLs', async () => {
        const f = githubFixture(); f.state.nextPullPage = true;
        const result = await new GitHubRepositorySource({ repository, maxPages: 2, tokenRef: 'env://TEST_TOKEN' }, { ...f, secrets: new MapSecretResolver({ 'env://TEST_TOKEN': 'fixture-private-token' }) }).snapshot(window);
        expect(result.coverage.pullRequests).toMatchObject({ pages: 2, exhausted: false, duplicated: true });
        expect(f.calls.every(call => call.url.origin === 'https://api.github.com')).toBe(true);
        expect(new Headers(f.calls[0]!.init!.headers).get('authorization')).toBe('Bearer fixture-private-token');
        expect(JSON.stringify(result)).not.toContain('fixture-private-token');
        expect(f.calls[2]!.url.searchParams.get('page')).toBe('2');
    });

    test('keeps body truncation and response versions visible and never treats closed-unmerged PRs as releases', async () => {
        const f = githubFixture(); f.state.pulls = [pr(1, { body: 'a'.repeat(3001) })];
        const source = new GitHubRepositorySource({ repository }, f);
        const first = await source.snapshot(window);
        expect(first.pullRequests[0]).toMatchObject({ bodyTruncated: true, url: `https://github.com/${repository}/pull/1` });
        expect(first.pullRequests[0]!.body).toHaveLength(3000);
        f.state.pulls = [pr(1, { body: 'a'.repeat(3000) + 'b' })];
        const next = await source.snapshot(window);
        expect(next.pullRequests[0]!.version).not.toBe(first.pullRequests[0]!.version);
        f.state.pulls = [pr(1, { merged_at: null })];
        expect((await source.snapshot(window)).pullRequests).toEqual([]);
    });

    test('retries a short advertised rate limit once, but never retries earlier than a longer reset', async () => {
        const f = githubFixture();
        let attempts = 0;
        f.state.override = () => ++attempts === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : undefined;
        await new GitHubRepositorySource({ repository }, f).snapshot(window);
        expect(f.calls).toHaveLength(4);
        f.calls.length = 0;
        f.state.override = () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) } });
        try { await new GitHubRepositorySource({ repository }, f).snapshot(window); throw new Error('Expected rate-limit failure'); }
        catch (error: any) { expect(error.code).toBe('GITHUB_RATE_LIMITED'); expect(error.retryAfterMs).toBeGreaterThan(50_000); }
        expect(f.calls).toHaveLength(1);
    });

    test('fails explicitly on authorization, malformed payloads and wrong branch rather than returning empty facts', async () => {
        for (const response of [new Response('', { status: 401 }), new Response('not-json'), Response.json({ full_name: 'another/repo' })]) {
            const f = githubFixture(); f.state.override = () => response;
            await expect(new GitHubRepositorySource({ repository }, f).snapshot(window)).rejects.toThrow();
        }
        const f = githubFixture(); f.state.pulls = [pr(1, { base: { ref: 'other' } })];
        await expect(new GitHubRepositorySource({ repository }, f).snapshot(window)).rejects.toThrow('base branch');
    });

    test('honors cancellation, request timeout and a response byte budget', async () => {
        const f = githubFixture(), stopped = new AbortController(); stopped.abort(new Error('stop snapshot'));
        await expect(new GitHubRepositorySource({ repository }, f).snapshot(window, stopped.signal)).rejects.toThrow('stop snapshot');
        expect(f.calls).toHaveLength(0);
        f.state.override = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
        await expect(new GitHubRepositorySource({ repository, timeoutMs: 10 }, f).snapshot(window)).rejects.toThrow('timed out');
        f.state.override = () => new Response('x'.repeat(4 * 1024 * 1024 + 1));
        await expect(new GitHubRepositorySource({ repository }, f).snapshot(window)).rejects.toThrow('4 MiB');
    });
});
