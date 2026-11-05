export const repository = 'example/project';
export const window = { since: '2026-10-01T00:00:00Z', until: '2026-10-08T00:00:00Z' };
export const pr = (number = 1, patch: Record<string, unknown> = {}) => ({ number, title: 'Change public API', body: 'This PR changes the public API. Migration notes are not included.',
    labels: [{ name: 'breaking-change' }], updated_at: '2026-10-02T00:00:00Z', state: 'closed', merged_at: '2026-10-02T00:00:00Z',
    base: { ref: 'main' }, merge_commit_sha: 'a'.repeat(40), ...patch });
export const openIssue = (number = 2, patch: Record<string, unknown> = {}) => ({ number, title: 'Release documentation review', body: 'Review migration instructions before release.',
    labels: [{ name: 'release' }], updated_at: '2026-10-03T00:00:00Z', state: 'open', ...patch });

export function githubFixture() {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const state = { pulls: [pr()], issues: [openIssue()], archived: false, nextPullPage: false, nextIssuePage: false,
        override: undefined as undefined | ((url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        calls.push({ url, init });
        const overridden = await state.override?.(url, init);
        if (overridden) return overridden;
        if (url.pathname === `/repos/${repository}`) return Response.json({ full_name: repository, default_branch: 'main', private: false, archived: state.archived });
        if (url.pathname.endsWith('/pulls')) return Response.json(state.pulls, { headers: state.nextPullPage ? { link: '<https://untrusted.example/next>; rel="next"' } : {} });
        if (url.pathname.endsWith('/issues')) return Response.json(state.issues, { headers: state.nextIssuePage ? { link: '<https://untrusted.example/next>; rel="next"' } : {} });
        throw new Error('Unexpected fixture URL');
    }) as typeof globalThis.fetch;
    return { calls, state, fetch };
}
