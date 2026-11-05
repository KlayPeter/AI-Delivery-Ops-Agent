import { standardModelPlugins } from '@/platform/models/providers';
import { parseArgs } from 'node:util';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createTriggerEnvelope, createTriggerScope, DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { knowledgeMarkdownPlugin, KNOWLEDGE_MARKDOWN_CAPABILITY } from '@/knowledge/markdown/plugin';
import { markdownSourceConfig } from '@/knowledge/markdown/source';
import { knowledgeAnswerPlugin, KNOWLEDGE_ANSWER_CAPABILITY } from '@/knowledge/answer/plugin';
import { knowledgeWebPlugin, KNOWLEDGE_WEB_CAPABILITY } from '@/knowledge/web/plugin';
import { knowledgeWebAnswerPlugin } from '@/knowledge/web/answerPlugin';
import { webSourceConfig } from '@/knowledge/web/source';
import { readKnowledgeModelConfig } from '@/knowledge/modelConfiguration';
import { SQLitePersistentKeyValueStore } from '@/platform/persistence/sqliteStore';
import { knowledgeImpactPlugin, KNOWLEDGE_IMPACT_CAPABILITY } from '@/knowledge/impact/plugin';
import { knowledgeWebImpactPlugin } from '@/knowledge/impact/webPlugin';

async function main() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            root: { type: 'string' }, url: { type: 'string', multiple: true }, query: { type: 'string' }, ask: { type: 'string' }, limit: { type: 'string' },
            state: { type: 'string' }, 'check-run': { type: 'string', multiple: true }, 'impact-status': { type: 'boolean' },
            exclude: { type: 'string', multiple: true }, 'vault-name': { type: 'string' }, help: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log('Usage: bun run src/scripts/knowledge.ts (--root <folder> | --url <public-url> [--url <public-url> ...]) [--query <text> | --ask <question> | --check-run <run-id> ...] [--state <private-sqlite-file>] [--impact-status] [--limit 1..10] [--exclude <relative-prefix>] [--vault-name <name>]\nWithout --query/--ask/--check-run, refresh the index. --query uses keyword retrieval without a model. --url reads only configured public pages (up to 5). --check-run requires --state and checks actual cited document versions; --impact-status reads the last assessment without refreshing. --ask sends selected snippets to explicit KNOWLEDGE_API_BASE/MODEL/API_KEY (KNOWLEDGE_PROVIDER=ollama allows a keyless loopback endpoint). Records are in memory unless --state is supplied; the index is always rebuilt.');
        return;
    }
    const useWeb = values.url !== undefined;
    if (useWeb === (values.root !== undefined)) throw new Error('Choose exactly one source: --root or --url');
    if (useWeb && (values.exclude || values['vault-name'])) throw new Error('--exclude and --vault-name require --root');
    const config = useWeb ? webSourceConfig.parse({ urls: values.url }) : markdownSourceConfig.parse({ root: values.root, exclude: values.exclude, vaultName: values['vault-name'] });
    const sourcePlugin = useWeb ? knowledgeWebPlugin : knowledgeMarkdownPlugin;
    const answerPlugin = useWeb ? knowledgeWebAnswerPlugin : knowledgeAnswerPlugin;
    if (values.ask !== undefined && values.query !== undefined) throw new Error('Choose --query or --ask');
    if (values['check-run'] && (values.ask !== undefined || values.query !== undefined)) throw new Error('Choose --check-run, --query or --ask');
    if (values['check-run'] && !values.state) throw new Error('--check-run requires --state with previously saved runs');
    if (values['impact-status'] && !values['check-run']) throw new Error('--impact-status requires --check-run');
    let ai: Record<string, string> | undefined;
    if (values.ask !== undefined) {
        ai = readKnowledgeModelConfig('--ask');
        console.error(`Generation uses ${ai.api_base}; your question and selected excerpts will be sent to this model service.`);
    }
    const store = values.state ? await SQLitePersistentKeyValueStore.open(values.state) : new InMemoryPersistentKeyValueStore();
    if (store instanceof SQLitePersistentKeyValueStore) console.error(`Runtime records are saved in ${store.filename}; the file contains private questions and excerpts.`);
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local knowledge' }, groups: [], ai } }) as any,
        1000, undefined, [], { plugins: values['check-run'] ? [sourcePlugin, useWeb ? knowledgeWebImpactPlugin : knowledgeImpactPlugin]
            : values.ask === undefined ? [sourcePlugin] : [...standardModelPlugins, sourcePlugin, answerPlugin], pluginConfig: { [sourcePlugin.manifest.id]: config } });
    try {
        const input = values['check-run'] ? { runIds: values['check-run'], operation: values['impact-status'] ? 'status' : 'check' }
            : values.ask !== undefined ? { question: values.ask, limit: values.limit === undefined ? 5 : Number(values.limit) } : values.query === undefined ? { operation: 'sync' } : {
            operation: 'search', query: values.query, limit: values.limit === undefined ? 5 : Number(values.limit),
        };
        const scope = createTriggerScope({ workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID, triggerType: 'manual', triggerId: crypto.randomUUID() });
        const trigger = createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } });
        const result = await host.dispatch(trigger, values['check-run'] ? KNOWLEDGE_IMPACT_CAPABILITY : values.ask === undefined ? (useWeb ? KNOWLEDGE_WEB_CAPABILITY : KNOWLEDGE_MARKDOWN_CAPABILITY) : KNOWLEDGE_ANSWER_CAPABILITY, input);
        if (result.status === 'failed') throw new Error(result.claim.error?.message || 'Knowledge operation failed');
        console.log(JSON.stringify({ runId: result.execution!.run.id, status: result.execution!.run.status, result: result.execution!.result.data }, null, 2));
    } finally { try { await host.stop(); } finally { if (store instanceof SQLitePersistentKeyValueStore) store.close(); } }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
