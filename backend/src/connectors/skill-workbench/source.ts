import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fetchPublicPage, publicWebTransport, type WebTransport } from '@/knowledge/web/network';
import { parseAgentSkill, type AgentSkillGrants } from '@/platform/skills/packageLoader';

export const PROMPT_AGENT = 'native.imported-skill', PROMPT_SKILL = 'community.imported-prompt';
export const promptInputSchema = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } }, additionalProperties: false };
export const promptInput = z.object({ prompt: z.string().trim().min(1).max(8000) }).strict();
export const grants: AgentSkillGrants = { id: PROMPT_SKILL, version: '1.0.0', inputSchema: promptInputSchema, outputSchema: { type: 'string', minLength: 1, maxLength: 256 * 1024 }, allowedTools: [], compatibleAgents: [PROMPT_AGENT], riskLevel: 'medium', maxToolCalls: 0, timeoutSeconds: 45 };
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
export function parseSkillUrl(value: string) {
    const url = new URL(z.string().max(1024).parse(value));
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || /\\|%|(?:^|\/)\.\.(?:\/|$)/.test(value)) throw new Error('请提供公开 GitHub 的 SKILL.md 文件链接，不含查询、凭据或编码路径');
    const [owner, repo, view, ref, ...parts] = url.pathname.slice(1).split('/');
    name.parse(owner); name.parse(repo); name.parse(ref);
    if (view !== 'blob' || parts.length < 2 || parts.length > 20 || parts.at(-1) !== 'SKILL.md' || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || ['.', '..'].includes(part))) throw new Error('请使用 github.com/组织/仓库/blob/分支或提交/技能目录/SKILL.md；暂不支持含斜杠的分支或非 ASCII 路径');
    return { owner: owner!, repo: repo!, ref: ref!, filePath: parts.join('/'), directoryName: parts.at(-2)! };
}
const pinned = (owner: string, repo: string, commit: string, file: string, raw = false) => raw ? `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${file}` : `https://github.com/${owner}/${repo}/blob/${commit}/${file}`;
const bundleSchema = z.object({ schemaVersion: z.literal('1.0'), requestedUrl: z.string().max(1024), owner: name, repo: name, commit: z.string().regex(/^[a-f0-9]{40}$/), filePath: z.string().max(700), skillUrl: z.string().max(1024), rawUrl: z.string().max(1024), rawSkill: z.string().max(128 * 1024), sha256: digest, inspectedAt: z.string().datetime(),
    license: z.object({ path: z.string().max(700), url: z.string().max(1024), text: z.string().max(64 * 1024), sha256: digest }).strict().nullable(),
}).strict();
export type SkillBundle = z.infer<typeof bundleSchema>;
export function validateBundle(value: unknown) {
    const bundle = bundleSchema.parse(value), source = parseSkillUrl(bundle.requestedUrl);
    if (source.owner !== bundle.owner || source.repo !== bundle.repo || source.filePath !== bundle.filePath || bundle.skillUrl !== pinned(bundle.owner, bundle.repo, bundle.commit, bundle.filePath) || bundle.rawUrl !== pinned(bundle.owner, bundle.repo, bundle.commit, bundle.filePath, true) || sha256(bundle.rawSkill) !== bundle.sha256) throw new Error('Skill 来源或内容指纹不一致');
    if (bundle.license && (!/^(?:[A-Za-z0-9_.-]+\/)*LICENSE(?:\.txt|\.md)?$/i.test(bundle.license.path) || bundle.license.path.split('/').some(part => ['.', '..'].includes(part)) || bundle.license.url !== pinned(bundle.owner, bundle.repo, bundle.commit, bundle.license.path) || Buffer.byteLength(bundle.license.text) > 64 * 1024 || sha256(bundle.license.text) !== bundle.license.sha256)) throw new Error('许可来源或内容指纹不一致');
    const skill = parseAgentSkill(bundle.rawSkill, source.directoryName, grants);
    return { bundle, skill };
}
async function githubText(url: string, maxBytes: number, signal: AbortSignal, transport: WebTransport, accept = 'text/plain') {
    const page = await fetchPublicPage(url, maxBytes, 10000, signal, { resolve: host => transport.resolve(host), request(target, address, bytes, active) {
        if (target.href !== url || !['api.github.com', 'raw.githubusercontent.com'].includes(target.hostname) || target.protocol !== 'https:') throw new Error('GitHub 读取拒绝重定向或来源变化');
        return transport.request(target, address, bytes, active, accept);
    } });
    if (page.url !== url) throw new Error('GitHub 来源发生变化');
    return new TextDecoder('utf-8', { fatal: true }).decode(page.body);
}
export async function inspectSkill(url: string, signal: AbortSignal, transport: WebTransport = publicWebTransport): Promise<SkillBundle> {
    const source = parseSkillUrl(url); signal.throwIfAborted();
    const commit = /^[a-f0-9]{40}$/.test(source.ref) ? source.ref : (await githubText(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${source.ref}`, 1024, signal, transport, 'application/vnd.github.sha')).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('GitHub 未返回完整提交 SHA');
    const rawUrl = pinned(source.owner, source.repo, commit, source.filePath, true), rawSkill = await githubText(rawUrl, 128 * 1024, signal, transport);
    const skill = parseAgentSkill(rawSkill, source.directoryName, grants), declaredFile = /\b(LICENSE(?:\.txt|\.md)?)\b/i.exec(skill.declarations.license)?.[1];
    const licensePath = declaredFile ? source.filePath.slice(0, -'SKILL.md'.length) + declaredFile : 'LICENSE';
    let license: SkillBundle['license'] = null;
    try { const text = await githubText(pinned(source.owner, source.repo, commit, licensePath, true), 64 * 1024, signal, transport); license = { path: licensePath, url: pinned(source.owner, source.repo, commit, licensePath), text, sha256: sha256(text) }; }
    catch { signal.throwIfAborted(); }
    const bundle = { schemaVersion: '1.0' as const, requestedUrl: url, owner: source.owner, repo: source.repo, commit, filePath: source.filePath, skillUrl: pinned(source.owner, source.repo, commit, source.filePath), rawUrl, rawSkill, sha256: sha256(rawSkill), inspectedAt: new Date().toISOString(), license };
    return validateBundle(bundle).bundle;
}
