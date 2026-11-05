import type { AgentManifest } from '../../src/platform/agents/contracts';
import type { FeaturePlugin } from '../../src/platform/plugins/contracts';
import { RunToolCallBudget } from '../../src/platform/tools/budget';

const manifest: AgentManifest = {
    schemaVersion: '1.1', id: 'example.mcp-reader', name: 'MCP file reader', version: '1.0.0',
    description: 'Read one file through an explicitly selected MCP tool. The task text is the file path; no model is called.',
    runtime: { type: 'native' }, capabilities: ['example.mcp.read'], triggers: ['manual', 'agent'],
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
    outputSchema: { type: 'object' }, requirements: { tools: ['mcp.files.read'], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 15, maxSteps: 2, maxToolCalls: 1, maxAgentCalls: 0, maxOutputBytes: 512 * 1024 },
    delivery: { allowedArtifactTypes: ['text'], directDelivery: false },
};

export const mcpReaderPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'example.mcp-reader', name: manifest.name, version: '1.0.0', description: manifest.description, requires: ['connector.mcp'] },
    agents: [{ manifest, installationId: 'install-example-mcp-reader' }],
    apply(ctx) {
        ctx.delivery.nativeAgents.register(manifest.id, manifest.version, async (request, _resolved, signal) => {
            const { prompt } = request.input as { prompt: string };
            const data = await ctx.delivery.toolGateway.execute('mcp.files.read', { path: prompt }, {
                runId: request.runId, agentId: manifest.id, scope: request.scope, signal,
                allowedTools: manifest.requirements.tools, budget: new RunToolCallBudget(manifest.limits.maxToolCalls),
            }) as { content: { type: string; text?: string }[] };
            return { status: 'succeeded', data, metrics: { modelCalls: 0, toolCalls: 1 }, artifacts: [{
                type: 'text', mediaType: 'text/plain', schemaVersion: '1.0', content: data.content.filter(item => item.type === 'text').map(item => item.text || '').join('\n'),
                metadata: { mcpTool: 'mcp.files.read' },
            }] };
        });
    },
};

export default mcpReaderPlugin;
