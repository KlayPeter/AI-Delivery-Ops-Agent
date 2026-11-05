import type { FeaturePlugin } from '../../src/platform/plugins/contracts';
import type { AgentManifest } from '../../src/platform/agents/contracts';

const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'example.echo', name: 'Echo example', version: '1.0.0',
    description: 'A native plugin example that needs no model or external credentials.',
    runtime: { type: 'native' }, capabilities: ['example.echo'], triggers: ['manual', 'agent'],
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 5, maxSteps: 1, maxToolCalls: 0, maxAgentCalls: 0, maxOutputBytes: 4096 },
    delivery: { allowedArtifactTypes: ['text'], directDelivery: false },
};

export const echoPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'example.echo', name: 'Echo example', version: '1.0.0', description: manifest.description },
    agents: [{ manifest, installationId: 'install-example-echo' }],
    apply(ctx) {
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async request => {
            const { text } = request.input as { text: string };
            return {
                status: 'succeeded', data: { text },
                artifacts: [{ type: 'text', mediaType: 'text/plain', schemaVersion: '1.0', content: text }],
            };
        });
    },
};

export default echoPlugin;
