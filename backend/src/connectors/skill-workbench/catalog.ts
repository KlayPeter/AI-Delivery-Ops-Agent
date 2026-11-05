import { z } from 'zod';
import { PROMPT_SKILL, sha256, validateBundle } from './source';

const review = z.object({ bundle: z.unknown(), reviewedSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmedPromptOnly: z.literal(true), confirmedLicense: z.literal(true) }).strict();
export const promptConfig = z.union([review, z.object({ skills: z.array(review).min(1).max(8) }).strict()]);

export function preparePromptSkills(value: unknown) {
    const config = promptConfig.parse(value);
    if (Buffer.byteLength(JSON.stringify(config)) > 512 * 1024) throw new Error('Skill 配置总量超过 512 KiB，请减少所选项');
    const multiple = 'skills' in config;
    const entries = (multiple ? config.skills : [config]).map(entry => {
        const { bundle, skill } = validateBundle(entry.bundle);
        if (entry.reviewedSha256 !== bundle.sha256) throw new Error('已审查的 Skill 内容指纹不一致');
        const source = `https://github.com/${bundle.owner.toLowerCase()}/${bundle.repo.toLowerCase()}/blob/${bundle.commit}/${bundle.filePath}`;
        const identity = sha256(JSON.stringify([source, bundle.sha256]));
        const id = multiple ? `${PROMPT_SKILL}.${identity}` : PROMPT_SKILL;
        return { bundle, skill: { ...skill, manifest: { ...skill.manifest, id } }, identity };
    });
    if (new Set(entries.map(entry => entry.identity)).size !== entries.length) throw new Error('配置含重复的 Skill 来源和版本');
    return entries;
}
