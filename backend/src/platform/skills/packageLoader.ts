import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';
import type { SkillManifest } from './contracts';
import type { SkillRegistry } from './registry';

export class SkillPackageLoader {
    constructor(private readonly registry: SkillRegistry) {}

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
            const packageRoot = path.resolve(root, entry.name);
            const manifestPath = path.join(packageRoot, 'manifest.yaml');
            let manifestText: string;
            try {
                manifestText = await readFile(manifestPath, 'utf8');
            } catch (error: any) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
            const manifest = parse(manifestText) as SkillManifest;
            const instructionsPath = this.resolveInside(packageRoot, manifest.instructionsRef || 'SKILL.md');
            const instructions = await readFile(instructionsPath, 'utf8');
            this.registry.register(manifest, instructions);
            loaded++;
        }
        return loaded;
    }

    private resolveInside(root: string, relativePath: string): string {
        if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Skill instructionsRef must be relative');
        const resolved = path.resolve(root, relativePath);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Skill instructionsRef escapes package root');
        return resolved;
    }
}
