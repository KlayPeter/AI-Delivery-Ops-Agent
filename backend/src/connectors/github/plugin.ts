import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { requirePersonalScope } from '@/knowledge/scope';
import { GitHubRepositorySource, githubConfig, type GitHubOptions } from './source';

export const GITHUB_SNAPSHOT_TOOL = 'github.repository.snapshot';
export function createGitHubPlugin(options: GitHubOptions = {}): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'connector.github', name: 'GitHub repository facts', version: '1.0.0', description: 'Read merged PRs in a time window and currently open issues from one explicitly configured GitHub repository.' },
        Config: githubConfig,
        apply(ctx, config) {
            const source = new GitHubRepositorySource(githubConfig.parse(config), options);
            ctx.delivery.tools.register({
                id: GITHUB_SNAPSHOT_TOOL, version: '1.0.0', description: 'Read the configured repository only. Returns merged PRs in [since, until), current open issues, versions and pagination/truncation coverage; not an atomic historical snapshot.',
                inputSchema: { type: 'object', required: ['since'], properties: { since: { type: 'string' }, until: { type: 'string' } } },
                outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'low', idempotent: true, timeoutSeconds: 35,
            }, async (input, execution) => {
                requirePersonalScope(execution.scope);
                return source.snapshot(input, execution.signal);
            });
        },
    };
}
export const githubPlugin = createGitHubPlugin();
export default githubPlugin;
