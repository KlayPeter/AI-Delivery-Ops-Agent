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

async function main() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            root: { type: 'string' }, url: { type: 'string', multiple: true }, query: { type: 'string' }, ask: { type: 'string' }, limit: { type: 'string' },
            exclude: { type: 'string', multiple: true }, 'vault-name': { type: 'string' }, help: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log('Usage: bun run src/scripts/knowledge.ts (--root <folder> | --url <public-url> [--url <public-url> ...]) [--query <text> | --ask <question>] [--limit 1..10] [--exclude <relative-prefix>] [--vault-name <name>]\nWithout --query/--ask, refresh the index. --query uses keyword retrieval without a model. --url reads only the configured public pages (up to 5); no crawling or login. --exclude/--vault-name apply only to --root. --ask sends the question and selected snippets to the explicitly configured model (KNOWLEDGE_API_BASE, KNOWLEDGE_MODEL, KNOWLEDGE_API_KEY; optional KNOWLEDGE_PROVIDER). Index and runtime records are in memory.');
        return;
    }
    const useWeb = values.url !== undefined;
    if (useWeb === (values.root !== undefined)) throw new Error('Choose exactly one source: --root or --url');
    if (useWeb && (values.exclude || values['vault-name'])) throw new Error('--exclude and --vault-name require --root');
    const config = useWeb ? webSourceConfig.parse({ urls: values.url }) : markdownSourceConfig.parse({ root: values.root, exclude: values.exclude, vaultName: values['vault-name'] });
    const sourcePlugin = useWeb ? knowledgeWebPlugin : knowledgeMarkdownPlugin;
    const answerPlugin = useWeb ? knowledgeWebAnswerPlugin : knowledgeAnswerPlugin;
    if (values.ask !== undefined && values.query !== undefined) throw new Error('Choose --query or --ask');
    let ai: Record<string, string> | undefined;
    if (values.ask !== undefined) {
        const model = process.env.KNOWLEDGE_MODEL?.trim();
        const key = process.env.KNOWLEDGE_API_KEY?.trim();
        const base = process.env.KNOWLEDGE_API_BASE?.trim();
        if (!model || !key || !base) throw new Error('--ask requires KNOWLEDGE_API_BASE, KNOWLEDGE_MODEL and KNOWLEDGE_API_KEY; it sends retrieved snippets to that model');
        const endpoint = new URL(base);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('KNOWLEDGE_API_BASE must be an HTTP(S) URL without credentials, query or fragment');
        ai = { provider: process.env.KNOWLEDGE_PROVIDER || 'openai-compatible', api_base: endpoint.href, api_key: key, model };
        console.error(`Generation uses ${endpoint.origin}${endpoint.pathname}; your question and selected excerpts will be sent to this model service.`);
    }
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local knowledge' }, groups: [], ai } }) as any,
        1000, undefined, [], { plugins: values.ask === undefined ? [sourcePlugin] : [sourcePlugin, answerPlugin], pluginConfig: { [sourcePlugin.manifest.id]: config } });
    try {
        const input = values.ask !== undefined ? { question: values.ask, limit: values.limit === undefined ? 5 : Number(values.limit) } : values.query === undefined ? { operation: 'sync' } : {
            operation: 'search', query: values.query, limit: values.limit === undefined ? 5 : Number(values.limit),
        };
        const scope = createTriggerScope({ workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID, triggerType: 'manual', triggerId: crypto.randomUUID() });
        const trigger = createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } });
        const result = await host.dispatch(trigger, values.ask === undefined ? (useWeb ? KNOWLEDGE_WEB_CAPABILITY : KNOWLEDGE_MARKDOWN_CAPABILITY) : KNOWLEDGE_ANSWER_CAPABILITY, input);
        if (result.status === 'failed') throw new Error(result.claim.error?.message || 'Knowledge operation failed');
        console.log(JSON.stringify({ runId: result.execution!.run.id, status: result.execution!.run.status, result: result.execution!.result.data }, null, 2));
    } finally { await host.stop(); }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
