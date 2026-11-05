import { lstat, readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { readWorkspaceArtifact } from '@/platform/workspace/artifactFiles';
import type { SkillManifest } from './contracts';
import type { SkillRegistry } from './registry';

export type AgentSkillGrants = Omit<SkillManifest, 'schemaVersion' | 'name' | 'description' | 'execution' | 'instructionsRef'>;

export async function readAgentSkill(packageRoot: string, grants: AgentSkillGrants): Promise<{ manifest: SkillManifest; instructions: string }> {
    const filename = path.join(packageRoot, 'SKILL.md'), info = await lstat(filename);
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('Agent Skill must be a regular SKILL.md file within 128 KiB');
    const text = await readWorkspaceArtifact(packageRoot, filename, '.md');
    if (!text || Buffer.byteLength(text) > 128 * 1024) throw new Error('Agent Skill instructions are unavailable or too large');
    const { manifest, instructions } = parseAgentSkill(text, path.basename(path.resolve(packageRoot)), grants);
    return { manifest, instructions };
}

export function parseAgentSkill(text: string, directoryName: string, grants: AgentSkillGrants) {
    if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Agent Skill exceeds 128 KiB');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match || Buffer.byteLength(match[1]!) > 8192) throw new Error('Agent Skill requires bounded YAML frontmatter');
    const frontmatter = parse(match[1]!);
    const metadata = z.object({
        name: z.string().min(1).refine(value => [...value].length <= 64 && value === value.toLowerCase() && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value)),
        description: z.string().trim().min(1).refine(value => [...value].length <= 1024),
    }).parse(frontmatter);
    if (metadata.name !== directoryName) throw new Error('Agent Skill name must match its directory');
    const instructions = text.slice(match[0].length).trim();
    if (!instructions) throw new Error('Agent Skill instructions must not be empty');
    return { manifest: { ...grants, schemaVersion: '1.0' as const, ...metadata, instructionsRef: 'SKILL.md', execution: { type: 'prompt' as const } }, instructions, declarations: { license: typeof frontmatter.license === 'string' ? frontmatter.license.slice(0, 1024) : '', compatibility: typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility.slice(0, 1024) : '', allowedTools: typeof frontmatter['allowed-tools'] === 'string' ? frontmatter['allowed-tools'].slice(0, 1024) : '' } };
}

export class SkillPackageLoader {
    constructor(private readonly registry: Pick<SkillRegistry, 'register'>) {}

    async loadDirectory(root: string): Promise<number> {
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        } catch (error: any) {
            if (error?.code === 'ENOENT') return 0;
            throw error;
        }

        let loaded = 0;
        for (const entry of entries.filter(item => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
            if (await this.loadPackage(path.resolve(root, entry.name))) loaded++;
        }
        return loaded;
    }

    async loadPackage(packageRoot: string): Promise<(() => void) | undefined> {
        let manifestText: string;
        try {
            manifestText = await readFile(path.join(packageRoot, 'manifest.yaml'), 'utf8');
        } catch (error: any) {
            if (error?.code === 'ENOENT') return undefined;
            throw error;
        }
        const manifest = parse(manifestText) as SkillManifest;
        const instructionsPath = this.resolveInside(packageRoot, manifest.instructionsRef || 'SKILL.md');
        const instructions = await readFile(instructionsPath, 'utf8');
        return this.registry.register(manifest, instructions);
    }

    private resolveInside(root: string, relativePath: string): string {
        if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Skill instructionsRef must be relative');
        const resolved = path.resolve(root, relativePath);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Skill instructionsRef escapes package root');
        return resolved;
    }
}
