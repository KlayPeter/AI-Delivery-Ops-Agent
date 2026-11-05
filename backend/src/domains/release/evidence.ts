import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GitHubSnapshot } from '@/connectors/github/source';
import { citationReference, verifyCitations, type EvidenceHit } from '@/knowledge/answer/evidence';

export interface ReleaseEvidence {
    citationId: string; kind: 'pull_request' | 'issue' | 'knowledge'; number?: number;
    path: string; title: string; documentVersion: string; excerpt: string; openUri?: string; lineBasis?: string; fetchedAt?: string; truncated?: boolean;
}
const citations = z.array(citationReference).min(1).max(4);
const numbers = z.array(z.number().int().positive()).max(10);
const draftSchema = z.object({
    entries: z.array(z.object({ number: z.number().int().positive(), summary: z.string().trim().min(1).max(1000), citations }).strict()).max(30),
    findings: z.array(z.object({ kind: z.enum(['policy', 'issue']), severity: z.enum(['potential_blocker', 'needs_review']),
        text: z.string().trim().min(1).max(1500), pullRequests: numbers, issues: numbers, citations }).strict()).max(20),
}).strict();
export type ReleaseDraft = z.infer<typeof draftSchema>;

export function releaseEvidence(snapshot: GitHubSnapshot, notes: readonly EvidenceHit[]): ReleaseEvidence[] {
    const fact = (item: GitHubSnapshot['openIssues'][number], kind: 'pull_request' | 'issue'): ReleaseEvidence => ({
        citationId: createHash('sha256').update(JSON.stringify([snapshot.repository, kind, item.number, item.version])).digest('hex'),
        kind, number: item.number, path: item.url, openUri: item.url, title: item.title, documentVersion: item.version,
        truncated: item.bodyTruncated || item.titleTruncated || item.labelsTruncated,
        excerpt: `Title: ${item.title}\nLabels: ${item.labels.join(', ')}\n${item.body}`,
    });
    return [...snapshot.pullRequests.map(item => fact(item, 'pull_request')), ...snapshot.openIssues.map(item => fact(item, 'issue')),
        ...notes.map(hit => ({ ...hit, kind: 'knowledge' as const }))];
}

export function verifyReleaseDraft(text: string, evidence: readonly ReleaseEvidence[]): ReleaseDraft {
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Release model output exceeds 64 KiB');
    const draft = draftSchema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1')));
    verifyCitations([...draft.entries, ...draft.findings], evidence);
    const prs = new Map(evidence.filter(item => item.kind === 'pull_request').map(item => [item.number!, item]));
    const issues = new Map(evidence.filter(item => item.kind === 'issue').map(item => [item.number!, item]));
    const byId = new Map(evidence.map(item => [item.citationId, item]));
    if (draft.entries.length !== prs.size || new Set(draft.entries.map(entry => entry.number)).size !== prs.size) throw new Error('Release draft must cover each supplied PR exactly once');
    const cites = (refs: z.infer<typeof citations>, kind: ReleaseEvidence['kind'], number?: number) => refs.some(ref => {
        const source = byId.get(ref.citationId)!;
        return source.kind === kind && (number === undefined || source.number === number);
    });
    for (const entry of draft.entries) if (!prs.has(entry.number) || !cites(entry.citations, 'pull_request', entry.number)) throw new Error('Release entry must cite its actual PR evidence');
    for (const finding of draft.findings) {
        for (const number of finding.pullRequests) if (!prs.has(number) || !cites(finding.citations, 'pull_request', number)) throw new Error('Finding refers to an unknown or uncited PR');
        for (const number of finding.issues) if (!issues.has(number) || !cites(finding.citations, 'issue', number)) throw new Error('Finding refers to an unknown or uncited issue');
        if (finding.kind === 'policy' && (!finding.pullRequests.length || !cites(finding.citations, 'knowledge'))) throw new Error('Policy findings require both PR and knowledge evidence');
        if (finding.kind === 'issue' && !finding.issues.length) throw new Error('Issue findings require actual issue evidence');
    }
    return draft;
}

const escape = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
export function renderReleaseDraft(snapshot: GitHubSnapshot, draft: ReleaseDraft, evidence: readonly ReleaseEvidence[], warnings: readonly string[]) {
    const references = (refs: z.infer<typeof citations>) => refs.map(ref => `[${evidence.findIndex(item => item.citationId === ref.citationId) + 1}]`).join(' ');
    return [`# 发布准备草稿`, '', `仓库：${escape(snapshot.repository)}；分支：${escape(snapshot.baseBranch)}`,
        `合并区间：[${snapshot.window.since}, ${snapshot.window.until})；Issue 为当前开放状态。`, '',
        '> 需要人工复核；引用存在与引文吻合不证明语义正确，也不表示具备发布条件。', '',
        ...warnings.map(warning => `- 注意：${escape(warning)}`), '', '## 更新', '',
        ...draft.entries.map(entry => `- [#${entry.number}](https://github.com/${snapshot.repository}/pull/${entry.number}) ${escape(entry.summary)} ${references(entry.citations)}`), '',
        '## 潜在阻塞与待确认', '', ...(draft.findings.length ? draft.findings.map(finding => `- ${escape(finding.text)} ${references(finding.citations)}`) : ['本轮草稿未提出事项，仍需人工复核。']), '',
        '## 证据', '', ...evidence.map((item, index) => {
            const target = item.openUri && /^(https?:|obsidian:)/.test(item.openUri) ? new URL(item.openUri).href.replace(/>/g, '%3E') : undefined;
            return `- [${index + 1}] ${escape(item.title)} · ${escape(item.path)} · 版本 ${item.documentVersion}${target ? ` · [原文](<${target}>)` : ''}`;
        }), ''].join('\n');
}
