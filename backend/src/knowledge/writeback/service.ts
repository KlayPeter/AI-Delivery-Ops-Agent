import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { contentHash, parseNote } from '../markdown/parser';
import { KnowledgeImpactService } from '../impact/service';
import { contentVersion, versionResult } from '../versions';

type Scope = { workspaceId: string; botInstanceId: string };
export const writebackConfig = z.object({ outputRoot: z.string().trim().min(1) }).strict();
const markdown = z.string().min(1).refine(value => Boolean(value.trim()) && Buffer.byteLength(value) <= 64 * 1024 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) && Buffer.from(value).toString('utf8') === value, '笔记正文必须为有效文本，最多 64 KiB');
export const prepareInput = z.object({ operation: z.literal('prepare'), sourceRunId: z.string().uuid(), title: z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/), markdown }).strict();
export const applyInput = z.object({ operation: z.literal('apply'), proposalId: z.string().uuid(), reviewedSha256: contentVersion, confirmed: z.literal(true) }).strict();
export const writebackInput = z.discriminatedUnion('operation', [prepareInput, applyInput]);
const reference = z.object({ path: z.string().min(1).max(1024), sourceKey: contentVersion, documentVersion: contentVersion, sourceKind: z.enum(['markdown', 'web']) }).strict();
const proposalSchema = z.object({ schemaVersion: z.literal('1.0'), id: z.string().uuid(), workspaceId: z.string(), botInstanceId: z.string(),
    sourceRunId: z.string().uuid(), sourceHash: contentVersion, rootKey: contentVersion, filename: z.string(), title: z.string(),
    content: z.string().max(128 * 1024), references: z.array(reference).min(1).max(10), createdAt: z.string().datetime(), checkedAt: z.string().datetime(),
    approvalSha256: contentVersion, state: z.enum(['draft', 'approved', 'saved']), approvedAt: z.string().datetime().optional(), savedAt: z.string().datetime().optional(),
}).strict().refine(value => (value.state === 'draft' || Boolean(value.approvedAt)) && (value.state !== 'saved' || Boolean(value.savedAt)), '写入状态缺少确认或保存时间');
export type NoteProposal = z.infer<typeof proposalSchema>;
type CheckVersions = (documents: NoteProposal['references']) => Promise<unknown>;
const referenceKey = (value: { sourceKey: string; path: string; documentVersion: string }) => JSON.stringify([value.sourceKey, value.path, value.documentVersion]);
function fingerprint(proposal: Omit<NoteProposal, 'approvalSha256'> | NoteProposal) {
    const { state: _state, checkedAt: _checkedAt, approvedAt: _approvedAt, savedAt: _savedAt, approvalSha256: _hash, ...fixed } = proposal as NoteProposal;
    return contentHash(JSON.stringify(fixed));
}
export function newNotePatch(proposal: Pick<NoteProposal, 'filename' | 'content'>) {
    const lines = proposal.content.slice(0, -1).split('\n');
    return `--- /dev/null\n+++ b/${proposal.filename}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
}
export class KnowledgeWritebackService {
    private tail: Promise<unknown> = Promise.resolve();
    private root?: { directory: string; key: string };
    constructor(private readonly configuredRoot: string, private readonly store: PersistentKeyValueStore, private readonly accepts: (kind: string) => boolean) {}
    drain() { return this.tail; }
    async directory() {
        const selected = path.resolve(this.configuredRoot), info = await lstat(selected);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('回写收件目录必须是已存在的普通目录，不能是符号链接');
        const directory = await realpath(selected), key = contentHash(JSON.stringify([directory, info.dev, info.ino]));
        if (this.root && this.root.key !== key) throw new Error('回写目录已移动或被替换，请重新启动并审查配置');
        return this.root ||= { directory, key };
    }
    async source(scope: Scope, runId: string) {
        z.string().uuid().parse(runId);
        const runs = new PersistentAgentRunStore(this.store), run = await runs.get(runId);
        if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.parentRunId || run.status !== 'succeeded') throw new Error('请选择当前工作区的成功根运行');
        const target = (await new KnowledgeImpactService(this.store).targets(scope, [runId]))[0]!;
        if (target.problem || !target.references.length) throw new Error('仅支持带已核验知识引用的回答和发布草稿');
        const references = target.references.map(value => reference.parse({ path: value.path, sourceKey: value.sourceKey, documentVersion: value.documentVersion, sourceKind: value.sourceKind }));
        if (references.some(value => !this.accepts(value.sourceKind))) throw new Error('原引用不属于本插件选择的知识来源');
        const artifacts = await runs.listArtifacts(runId);
        const privateJson = artifacts.find(value => value.type === 'json' && value.metadata.privateKnowledge === true)!;
        let body: string;
        if (run.capability === 'knowledge.answer') {
            const content = z.object({ claims: z.array(z.object({ text: z.string().min(1).max(6000) })).min(1).max(200) }).parse(privateJson.content);
            body = content.claims.map(claim => `- ${claim.text}`).join('\n\n');
        } else {
            const drafts = artifacts.filter(value => value.type === 'markdown' && value.mediaType === 'text/markdown' && value.metadata.privateKnowledge === true && typeof value.content === 'string');
            if (drafts.length !== 1) throw new Error('原记录缺少唯一的发布 Markdown');
            body = drafts[0]!.content as string;
        }
        return { runId, capability: run.capability, references, markdown: markdown.parse(body),
            hash: contentHash(JSON.stringify(artifacts.map(value => ({ id: value.id, type: value.type, content: value.content })).sort((a, b) => a.id.localeCompare(b.id)))) };
    }
    private async check(references: NoteProposal['references'], checkVersions: CheckVersions) {
        const result = versionResult.parse(await checkVersions(references));
        const wanted = new Set(references.map(referenceKey));
        if (result.documents.length !== wanted.size || new Set(result.documents.map(referenceKey)).size !== wanted.size || result.documents.some(value => !wanted.has(referenceKey(value)) || value.status !== 'current')) throw new Error('原引用已变化、缺失或无法核验，请重新生成并审查；没有新建笔记');
        return result.checkedAt;
    }
    private key(scope: Scope, id: string) { return ['knowledge:writeback', scope.workspaceId, scope.botInstanceId, id].map(encodeURIComponent).join(':'); }
    async get(scope: Scope, id: string) {
        z.string().uuid().parse(id);
        const proposal = proposalSchema.parse(await this.store.getIdempotencyValue(this.key(scope, id)));
        if (proposal.id !== id || proposal.workspaceId !== scope.workspaceId || proposal.botInstanceId !== scope.botInstanceId || proposal.filename !== `agent-note-${id}.md` || fingerprint(proposal) !== proposal.approvalSha256) throw new Error('笔记提案归属或内容凭证不一致');
        return proposal;
    }
    async list(scope: Scope) {
        const prefix = this.key(scope, '');
        const entries = await this.store.listIdempotencyEntries<NoteProposal>(prefix);
        const values = entries.map(entry => proposalSchema.parse(entry.value)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
        return Promise.all(values.map(value => this.get(scope, value.id)));
    }
    async prepare(scope: Scope, previewRunId: string, value: z.infer<typeof prepareInput>, checkVersions: CheckVersions, signal?: AbortSignal) {
        const input = prepareInput.parse(value); signal?.throwIfAborted();
        const source = await this.source(scope, input.sourceRunId), root = await this.directory();
        const checkedAt = await this.check(source.references, checkVersions); signal?.throwIfAborted();
        const id = z.string().uuid().parse(previewRunId), createdAt = new Date().toISOString();
        const metadata = { title: input.title, agent_note: { schemaVersion: '1.0', proposalId: id, sourceRunId: source.runId, sourceArtifactHash: source.hash, semanticSupport: 'not_verified' } };
        const content = ['---', JSON.stringify(metadata), '---', '', input.markdown, '', '---', '', '## 引用来源与保存依据', '', '```json', JSON.stringify(source.references, null, 2), '```', ''].join('\n');
        const fixed = { schemaVersion: '1.0' as const, id, workspaceId: scope.workspaceId, botInstanceId: scope.botInstanceId, sourceRunId: source.runId, sourceHash: source.hash, rootKey: root.key, filename: `agent-note-${id}.md`, title: input.title,
            content, references: source.references, createdAt, checkedAt, state: 'draft' as const };
        const proposal = proposalSchema.parse({ ...fixed, approvalSha256: fingerprint(fixed) }); parseNote(proposal.filename, Buffer.from(content));
        signal?.throwIfAborted();
        if (!await this.store.claimIdempotencyKey(this.key(scope, id), proposal)) throw new Error('此运行已有提案，请使用原预览');
        return proposal;
    }
    private async verifyFile(root: string, proposal: NoteProposal) {
        let file;
        try { file = await open(path.join(root, proposal.filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
        try {
            const info = await file.stat();
            if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size !== Buffer.byteLength(proposal.content)) throw new Error('目标笔记已存在且不符合已审查内容，未覆盖');
            const bytes = Buffer.alloc(info.size + 1); const read = await file.read(bytes, 0, bytes.length, 0);
            if (read.bytesRead !== info.size || contentHash(bytes.subarray(0, read.bytesRead)) !== contentHash(proposal.content)) throw new Error('目标笔记内容已改变，未覆盖');
            return true;
        } finally { await file.close(); }
    }
    apply(scope: Scope, value: z.infer<typeof applyInput>, checkVersions: CheckVersions, signal?: AbortSignal) {
        const pending = this.tail.then(async () => {
            const input = applyInput.parse(value); signal?.throwIfAborted();
            let proposal = await this.get(scope, input.proposalId);
            if (proposal.approvalSha256 !== input.reviewedSha256) throw new Error('确认凭证与预览不一致，请重新审查');
            const root = await this.directory(); if (root.key !== proposal.rootKey) throw new Error('收件目录与预览不一致，未写入');
            const exists = await this.verifyFile(root.directory, proposal);
            if (proposal.state === 'saved') { if (!exists) throw new Error('已保存的笔记已被移走，不会重复创建'); return proposal; }
            if (exists && proposal.state !== 'approved') throw new Error('未经确认的目标文件已存在，未覆盖');
            if (!exists) {
                const source = await this.source(scope, proposal.sourceRunId);
                if (source.hash !== proposal.sourceHash) throw new Error('原运行证据已改变，请重新生成提案');
                const checkedAt = await this.check(proposal.references, checkVersions); signal?.throwIfAborted();
                const approved = { ...proposal, state: 'approved' as const, checkedAt, approvedAt: proposal.approvedAt || new Date().toISOString() };
                if (!await this.store.compareAndSetIdempotencyKey(this.key(scope, proposal.id), proposal, approved)) throw new Error('提案状态已变化，请刷新');
                proposal = approved;
                const temporary = path.join(root.directory, `.agent-note-${randomUUID()}.tmp`), file = await open(temporary, 'wx', 0o600);
                try {
                    await file.writeFile(proposal.content); await file.sync(); await file.close();
                    await this.directory(); signal?.throwIfAborted();
                    // Publish a complete new file exclusively; existing notes are never renamed or replaced.
                    await link(temporary, path.join(root.directory, proposal.filename));
                } finally { await file.close().catch(() => {}); await unlink(temporary); }
            }
            if (!await this.verifyFile(root.directory, proposal)) throw new Error('新笔记读回失败；请核对收件目录并重试同一提案');
            const parent = await open(root.directory, constants.O_RDONLY);
            try { await parent.sync(); } finally { await parent.close(); }
            const saved = { ...proposal, state: 'saved' as const, savedAt: new Date().toISOString() };
            if (!await this.store.compareAndSetIdempotencyKey(this.key(scope, proposal.id), proposal, saved)) throw new Error('笔记已创建但回执未保存，请重试同一提案以恢复回执');
            return saved;
        });
        this.tail = pending.catch(() => {}); return pending;
    }
}
