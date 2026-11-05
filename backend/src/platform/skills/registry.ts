import type { RegisteredSkill, SkillHandler, SkillManifest, SkillMetadata } from './contracts';

const key = (id: string, version: string) => `${id}@${version}`;
const clone = <T>(value: T): T => structuredClone(value);

export class SkillRegistry {
    private readonly skills = new Map<string, RegisteredSkill>();

    register(manifest: SkillManifest, instructions: string, handler?: SkillHandler): () => void {
        if (!manifest.id.trim() || !manifest.version.trim()) throw new Error('Skill id and version are required');
        if (!manifest.name.trim() || !manifest.description.trim()) throw new Error('Skill name and description are required');
        if (!instructions.trim()) throw new Error(`Skill instructions are required: ${manifest.id}`);
        if (manifest.maxToolCalls < 0 || manifest.timeoutSeconds <= 0) throw new Error(`Skill limits are invalid: ${manifest.id}`);
        if (!manifest.compatibleAgents.length) throw new Error(`Skill compatibleAgents are required: ${manifest.id}`);
        if (manifest.execution.type === 'native' && !handler) throw new Error(`Native Skill handler is required: ${manifest.id}`);
        const definitionKey = key(manifest.id, manifest.version);
        if (this.skills.has(definitionKey)) throw new Error(`Skill already registered: ${definitionKey}`);
        this.skills.set(definitionKey, { manifest: clone(manifest), instructions, handler });
        return () => { this.skills.delete(definitionKey); };
    }

    resolve(id: string, agentId: string, version?: string): RegisteredSkill {
        const candidates = Array.from(this.skills.values())
            .filter(skill => skill.manifest.id === id && (!version || skill.manifest.version === version))
            .sort((left, right) => right.manifest.version.localeCompare(left.manifest.version, undefined, { numeric: true }));
        const skill = candidates[0];
        if (!skill) throw new Error(`Skill not found: ${version ? `${id}@${version}` : id}`);
        if (!skill.manifest.compatibleAgents.includes('*') && !skill.manifest.compatibleAgents.includes(agentId)) {
            throw new Error(`Skill is not compatible with Agent ${agentId}: ${id}`);
        }
        return { manifest: clone(skill.manifest), instructions: skill.instructions, handler: skill.handler };
    }

    list(agentId?: string): SkillMetadata[] {
        return Array.from(this.skills.values())
            .filter(skill => !agentId || skill.manifest.compatibleAgents.includes('*') || skill.manifest.compatibleAgents.includes(agentId))
            .map(skill => ({
                id: skill.manifest.id,
                version: skill.manifest.version,
                name: skill.manifest.name,
                description: skill.manifest.description,
                riskLevel: skill.manifest.riskLevel,
                compatibleAgents: [...skill.manifest.compatibleAgents],
            }));
    }
}
