import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { JsonSchema } from '@/platform/agents/contracts';
import type { FeaturePlugin } from './contracts';

const id = z.string().regex(/^[a-z][a-z0-9.-]*$/).max(160);
const version = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const jsonSchema = z.custom<JsonSchema>(value => value !== null && typeof value === 'object' && !Array.isArray(value) && z.record(z.string(), z.json()).safeParse(value).success);
const definition = z.object({
    id, title: z.string().trim().min(1).max(160), version, agentId: id, capability: id,
    expectedStatus: z.enum(['succeeded', 'failed', 'cancelled']).default('succeeded'),
    artifacts: z.array(z.object({ id, type: z.enum(['json', 'markdown', 'text']), schema: jsonSchema }).strict()).min(1).max(8),
    steps: z.array(z.object({ id, kind: z.enum(['tool', 'model', 'skill']), name: z.string().min(1).max(200), status: z.enum(['succeeded', 'failed', 'cancelled']).default('succeeded') }).strict()).max(16).default([]),
}).strict();
export type RunCheckDefinition = z.input<typeof definition>;
export type RegisteredRunCheck = z.output<typeof definition> & { provider: { pluginId: string; pluginVersion: string }; hash: string };
export const checkHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class RunCheckRegistry {
    private readonly entries = new Map<string, RegisteredRunCheck>();
    register(owner: Pick<FeaturePlugin, 'manifest' | 'agents'>, input: RunCheckDefinition): () => void {
        if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new Error('Result check exceeds 64 KiB');
        const parsed = definition.parse(input);
        if (!parsed.id.startsWith(`${owner.manifest.id}.`) || !owner.agents?.some(agent => agent.manifest.id === parsed.agentId && agent.manifest.capabilities.includes(parsed.capability))) throw new Error('Result check must target an Agent owned by its plugin');
        if (this.entries.has(parsed.id) || this.entries.size >= 100) throw new Error(`Duplicate or excessive result check: ${parsed.id}`);
        const keys = [...parsed.artifacts.map(item => `artifact:${item.id}`), ...parsed.steps.map(item => `step:${item.id}`)];
        if (new Set(keys).size !== keys.length) throw new Error('Duplicate result check assertion ID');
        for (const artifact of parsed.artifacts) {
            try { new AjvJsonSchemaValidator().getValidator(artifact.schema); }
            catch { throw new Error(`Invalid result check JSON Schema: ${parsed.id}`); }
        }
        const data = structuredClone({ ...parsed, provider: { pluginId: owner.manifest.id, pluginVersion: owner.manifest.version } });
        const registered = { ...data, hash: checkHash(data) };
        this.entries.set(parsed.id, registered);
        return () => { if (this.entries.get(parsed.id) === registered) this.entries.delete(parsed.id); };
    }
    require(id: string): RegisteredRunCheck {
        const entry = this.entries.get(id); if (!entry) throw new Error('所选验收规则未安装或已移除'); return structuredClone(entry);
    }
    list() { return [...this.entries.values()].map(({ artifacts, steps, ...metadata }) => ({ ...structuredClone(metadata), artifactChecks: artifacts.length, stepChecks: steps.length })); }
}
