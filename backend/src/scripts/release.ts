import { parseArgs } from 'node:util';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createTriggerEnvelope, createTriggerScope, DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { githubPlugin } from '@/connectors/github/plugin';
import { githubConfig } from '@/connectors/github/source';
import { knowledgeMarkdownPlugin } from '@/knowledge/markdown/plugin';
import { markdownSourceConfig } from '@/knowledge/markdown/source';
import { knowledgeWebPlugin } from '@/knowledge/web/plugin';
import { webSourceConfig } from '@/knowledge/web/source';
import { readKnowledgeModelConfig } from '@/knowledge/modelConfiguration';
import { releasePlugin, releaseInput, RELEASE_PREPARE_CAPABILITY } from '@/domains/release/plugin';
import { webReleasePlugin } from '@/domains/release/webPlugin';
import { SQLitePersistentKeyValueStore } from '@/platform/persistence/sqliteStore';

async function main() {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
        repository: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, 'base-branch': { type: 'string' }, 'token-ref': { type: 'string' },
        root: { type: 'string' }, url: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true }, 'vault-name': { type: 'string' },
        'policy-query': { type: 'string' }, limit: { type: 'string' }, collect: { type: 'boolean' }, help: { type: 'boolean' },
        state: { type: 'string' },
    } });
    if (values.help) {
        console.log('Usage: bun run src/scripts/release.ts --repository owner/repo --since <ISO timestamp> [--until <ISO timestamp>] (--root <folder> | --url <public-url> ...) [--collect] [--policy-query <text>] [--token-ref env://GITHUB_TOKEN] [--base-branch <name>] [--exclude <prefix>] [--vault-name <name>] [--limit 1..10] [--state <private-sqlite-file>]\n--collect reads repository facts and policy snippets without a model. Otherwise, explicit KNOWLEDGE_API_BASE/MODEL/API_KEY are required; repository facts and selected personal excerpts are sent to that model. Read-only preparation: no GitHub writes. Records remain in memory unless --state is supplied; saved records include private facts and excerpts.');
        return;
    }
    const web = values.url !== undefined;
    if (web === (values.root !== undefined)) throw new Error('Choose exactly one source: --root or --url');
    if (web && (values.exclude || values['vault-name'])) throw new Error('--exclude and --vault-name require --root');
    const connectorConfig = githubConfig.parse({ repository: values.repository, baseBranch: values['base-branch'], tokenRef: values['token-ref'] });
    const sourceConfig = web ? webSourceConfig.parse({ urls: values.url }) : markdownSourceConfig.parse({ root: values.root, exclude: values.exclude, vaultName: values['vault-name'] });
    const input = releaseInput.parse({ since: values.since, ...(values.until ? { until: values.until } : {}), operation: values.collect ? 'collect' : 'prepare', policyQuery: values['policy-query'], limit: values.limit === undefined ? undefined : Number(values.limit) });
    const ai = values.collect ? undefined : readKnowledgeModelConfig('Release preparation');
    if (ai) console.error(`Generation uses ${ai.api_base}; repository facts and selected personal excerpts will be sent to this model service.`);
    const store = values.state ? await SQLitePersistentKeyValueStore.open(values.state) : new InMemoryPersistentKeyValueStore();
    if (store instanceof SQLitePersistentKeyValueStore) console.error(`Runtime records are saved in ${store.filename}; the file contains private repository facts and excerpts.`);
    const source = web ? knowledgeWebPlugin : knowledgeMarkdownPlugin;
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local release preparation' }, groups: [], ai } }) as any,
        1000, undefined, [], { plugins: [web ? webReleasePlugin : releasePlugin, githubPlugin, source],
            pluginConfig: { 'connector.github': connectorConfig, [source.manifest.id]: sourceConfig } });
    try {
        const scope = createTriggerScope({ workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID, triggerType: 'manual', triggerId: crypto.randomUUID() });
        const result = await host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), RELEASE_PREPARE_CAPABILITY, input);
        if (result.status === 'failed') throw new Error(result.claim.error?.message || 'Release preparation failed');
        console.log(JSON.stringify({ runId: result.execution!.run.id, status: result.execution!.run.status, result: result.execution!.result.data }, null, 2));
    } finally { try { await host.stop(); } finally { if (store instanceof SQLitePersistentKeyValueStore) store.close(); } }
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
