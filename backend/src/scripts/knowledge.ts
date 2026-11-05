import { parseArgs } from 'node:util';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createTriggerEnvelope, createTriggerScope, DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { knowledgeMarkdownPlugin, KNOWLEDGE_MARKDOWN_CAPABILITY } from '@/knowledge/markdown/plugin';
import { markdownSourceConfig } from '@/knowledge/markdown/source';

async function main() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            root: { type: 'string' }, query: { type: 'string' }, limit: { type: 'string' },
            exclude: { type: 'string', multiple: true }, 'vault-name': { type: 'string' }, help: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log('Usage: bun run src/scripts/knowledge.ts --root <folder> [--query <text>] [--limit 1..10] [--exclude <relative-prefix>] [--vault-name <name>]\nWithout --query, refresh the index and print its status. Index and runtime records are in memory; no model or network is used.');
        return;
    }
    const config = markdownSourceConfig.parse({ root: values.root, exclude: values.exclude, vaultName: values['vault-name'] });
    const store = new InMemoryPersistentKeyValueStore();
    const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local knowledge' }, groups: [] } }) as any,
        1000, undefined, [], { plugins: [knowledgeMarkdownPlugin], pluginConfig: { 'knowledge.markdown': config } });
    try {
        const input = values.query === undefined ? { operation: 'sync' } : {
            operation: 'search', query: values.query, limit: values.limit === undefined ? 5 : Number(values.limit),
        };
        const scope = createTriggerScope({ workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID, triggerType: 'manual', triggerId: crypto.randomUUID() });
        const trigger = createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } });
        const result = await host.dispatch(trigger, KNOWLEDGE_MARKDOWN_CAPABILITY, input);
        if (result.status === 'failed') throw new Error(result.claim.error?.message || 'Knowledge operation failed');
        console.log(JSON.stringify({ runId: result.execution!.run.id, status: result.execution!.run.status, result: result.execution!.result.data }, null, 2));
    } finally { await host.stop(); }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
