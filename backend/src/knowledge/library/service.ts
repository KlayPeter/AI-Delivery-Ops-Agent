import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, link, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { DEFAULT_WORKSPACE_ID, DEFAULT_BOT_INSTANCE_ID } from '@/platform/runtime/scope';
import { contentHash, parseNote } from '@/knowledge/markdown/parser';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';

type Scope = { workspaceId: string; botInstanceId: string };
export const librarySources = ['knowledge.page.capture', 'knowledge.document.convert'];
const scopeDefault = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
const itemSchema = z.object({ schemaVersion: z.literal('1.0'), id: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(200),
    runId: z.string().uuid(), artifactId: z.string().uuid(), importedSha256: z.string().regex(/^[a-f0-9]{64}$/), savedAt: z.string().datetime(),
    workspaceId: z.string(), botInstanceId: z.string(), sourceCapability: z.enum(['knowledge.page.capture', 'knowledge.document.convert']),
}).strict();
export type LibraryItem = z.infer<typeof itemSchema>;
export const libraryRoot = (dataPath: string, scope: Scope = scopeDefault) => path.join(dataPath, 'knowledge-library', contentHash(JSON.stringify([scope.workspaceId, scope.botInstanceId])).slice(0, 32));

export class KnowledgeLibrary {
    private tail: Promise<unknown> = Promise.resolve();
    private readonly roots = new Map<string, Promise<string>>();
    constructor(private readonly dataPath: string, private readonly store: PersistentKeyValueStore) {}
    initialize(scope: Scope = scopeDefault) {
        const root = libraryRoot(this.dataPath, scope);
        let ready = this.roots.get(root);
        if (!ready) {
            ready = (async () => {
                for (const directory of [path.dirname(root), root]) {
                    await mkdir(directory, { recursive: true, mode: 0o700 });
                    const info = await lstat(directory);
                    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('资料库必须使用应用的私有目录');
                }
                // shortcut: one backend owns a data directory; add a shared lock before multi-process hosting.
                for (const name of await readdir(root)) if (/^\.[a-f0-9-]{36}\.tmp$/.test(name)) {
                    const info = await lstat(path.join(root, name));
                    if (!info.isFile() || (info.mode & 0o077) || info.nlink > 2) throw new Error('资料库暂存文件无效');
                    await unlink(path.join(root, name));
                }
                return root;
            })();
            this.roots.set(root, ready);
            ready.catch(() => { this.roots.delete(root); });
        }
        return ready;
    }
    source(scope: Scope = scopeDefault) { return new MarkdownKnowledgeSource({ root: libraryRoot(this.dataPath, scope), sourceId: 'workspace-library' }); }
    private async read(filename: string, scope: Scope) {
        const file = await open(path.join(libraryRoot(this.dataPath, scope), filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let raw: Buffer;
        try {
            const info = await file.stat();
            if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 1024 * 1024) throw new Error('资料库文件无效或超过大小上限');
            raw = await file.readFile();
            if (raw.length > 1024 * 1024) throw new Error('资料库文件超过大小上限');
        } finally { await file.close(); }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        const end = text.indexOf('\n---\n\n', 4);
        if (!text.startsWith('---\n') || end < 0 || end > 8192) throw new Error('资料库来源记录无效');
        const item = itemSchema.parse(JSON.parse(text.slice(4, end)));
        if (`${item.id}.md` !== filename || item.workspaceId !== scope.workspaceId || item.botInstanceId !== scope.botInstanceId
            || item.id !== contentHash(JSON.stringify([item.runId, item.artifactId]))) throw new Error('资料库来源不属于当前范围');
        const markdown = text.slice(end + 6);
        return { item, bytes: raw.length, modified: contentHash(markdown) !== item.importedSha256 };
    }
    async list(scope: Scope = scopeDefault) {
        const root = libraryRoot(this.dataPath, scope);
        for (const directory of [path.dirname(root), root]) {
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('资料库目录无效');
        }
        const names = (await readdir(root)).filter(name => /^[a-f0-9]{64}\.md$/.test(name));
        if (names.length > 100) throw new Error('资料库超过 100 份资料，请先整理本地目录');
        const entries = [];
        for (const name of names) entries.push(await this.read(name, scope));
        return entries.sort((a, b) => b.item.savedAt.localeCompare(a.item.savedAt));
    }
    save(scope: Scope, runId: string, signal?: AbortSignal) {
        const task = this.tail.then(async () => {
            signal?.throwIfAborted();
            z.string().uuid().parse(runId);
            const runs = new PersistentAgentRunStore(this.store), run = await runs.get(runId);
            if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId || run.status !== 'succeeded'
                || !librarySources.includes(run.capability)) throw new Error('只能收录当前范围内成功的网页或文档结果');
            const artifacts = (await runs.listArtifacts(runId)).filter(artifact => artifact.type === 'markdown' && artifact.mediaType === 'text/markdown' && artifact.metadata.privateKnowledge === true);
            if (artifacts.length !== 1 || typeof artifacts[0]!.content !== 'string') throw new Error('结果没有唯一的私有 Markdown 资料');
            const artifact = artifacts[0]!, markdown = artifact.content as string;
            if (!markdown.trim() || Buffer.byteLength(markdown) > 768 * 1024) throw new Error('资料为空或超过收录上限');
            const item = itemSchema.parse({ schemaVersion: '1.0', id: contentHash(JSON.stringify([runId, artifact.id])),
                title: (typeof artifact.metadata.title === 'string' ? artifact.metadata.title.trim().slice(0, 200) : '') || '已收录资料',
                runId, artifactId: artifact.id, importedSha256: contentHash(markdown), savedAt: new Date().toISOString(),
                workspaceId: scope.workspaceId, botInstanceId: scope.botInstanceId, sourceCapability: run.capability });
            const root = await this.initialize(scope), entries = await this.list(scope);
            const existing = entries.find(entry => entry.item.id === item.id);
            if (existing) {
                if (existing.modified || existing.item.importedSha256 !== item.importedSha256) throw new Error('已收录资料有变化，未覆盖现有文件');
                return { ...existing.item, duplicate: true };
            }
            const raw = Buffer.from(`---\n${JSON.stringify(item)}\n---\n\n${markdown}`);
            parseNote(`${item.id}.md`, raw);
            if (entries.length >= 100 || entries.reduce((size, entry) => size + entry.bytes, raw.length) > 20 * 1024 * 1024) throw new Error('资料库已达 100 份或 20 MiB 上限，请先整理本地目录');
            const temporary = path.join(root, `.${randomUUID()}.tmp`), target = path.join(root, `${item.id}.md`);
            const file = await open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(raw); await file.sync(); await file.close(); signal?.throwIfAborted();
                await link(temporary, target);
            } finally { await file.close().catch(() => {}); await unlink(temporary); }
            return { ...item, duplicate: false };
        });
        this.tail = task.catch(() => {}); return task;
    }
}
