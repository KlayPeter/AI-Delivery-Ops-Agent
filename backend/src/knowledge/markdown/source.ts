import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { contentHash, parseNote, resolveNoteLinks, type MarkdownNote, type ResolvedNoteLink } from './parser';
import { knowledgeSearchInput, rankNotes } from '../search';

const excludedPath = z.string().trim().min(1).refine(value => !path.isAbsolute(value) && !value.startsWith('\\')
    && !/^[A-Za-z]:|[\0*?\[\]]/.test(value) && !value.replace(/\\/g, '/').split('/').some(part => part === '..' || part === '.'), 'Use a relative file or directory prefix, without glob patterns');

export const markdownSourceConfig = z.object({
    root: z.string().trim().min(1),
    sourceId: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(64).default('personal'),
    vaultName: z.string().trim().min(1).max(256).optional(),
    exclude: z.array(excludedPath).max(100).default([]),
    maxFiles: z.number().int().min(1).max(2000).default(2000),
    maxFileBytes: z.number().int().min(1).max(1024 * 1024).default(1024 * 1024),
    maxTotalBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(32 * 1024 * 1024),
}).strict();
export type MarkdownSourceConfig = z.input<typeof markdownSourceConfig>;

interface Snapshot {
    notes: MarkdownNote[];
    links: Map<string, ResolvedNoteLink[]>;
    report: {
        sourceId: string; version: string; syncedAt: string; indexed: number; added: string[]; changed: string[]; removed: string[];
        failed: number; partial: boolean; failures: Array<{ path: string; reason: string }>; skipped: number; unsupportedAttachments: number;
        resolvedLinks: number; ambiguousLinks: number; missingLinks: number;
        addedCount: number; changedCount: number; removedCount: number; changesTruncated: boolean;
    };
}

export class MarkdownKnowledgeSource {
    readonly config: z.output<typeof markdownSourceConfig>;
    private snapshot?: Snapshot;
    private tail: Promise<void> = Promise.resolve();

    constructor(config: MarkdownSourceConfig) { this.config = markdownSourceConfig.parse(config); }

    async sync(signal?: AbortSignal) { return structuredClone((await this.refresh(signal)).report); }

    async search(query: string, limit = 5, signal?: AbortSignal) {
        const input = knowledgeSearchInput.parse({ query, limit });
        const snapshot = await this.refresh(signal);
        const scored = rankNotes(snapshot.notes, input.query, signal);
        return {
            source: structuredClone(snapshot.report), query: input.query, retrieval: 'keyword' as const,
            hits: scored.slice(0, input.limit).map(({ note, chunk, score, matching }) => ({
                citationId: contentHash(JSON.stringify([this.config.sourceId, note.path, note.version, chunk.index, chunk.heading, chunk.lineStart, chunk.lineEnd, chunk.text])),
                sourceId: this.config.sourceId, path: note.path, title: note.title, documentVersion: note.version,
                heading: chunk.heading, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, excerpt: chunk.text,
                score, matching,
                openUri: this.config.vaultName ? `obsidian://open?vault=${encodeURIComponent(this.config.vaultName)}&file=${encodeURIComponent(note.path)}` : undefined,
                links: snapshot.links.get(note.path)!.slice(0, 3).map(link => ({ ...link, paths: link.paths.slice(0, 3) })),
            })),
        };
    }

    private refresh(signal?: AbortSignal): Promise<Snapshot> {
        const pending = this.tail.then(() => this.readSnapshot(signal));
        this.tail = pending.then(() => {}, () => {});
        return pending;
    }

    private async readSnapshot(signal?: AbortSignal): Promise<Snapshot> {
        signal?.throwIfAborted();
        const root = await realpath(this.config.root);
        if (!(await lstat(root)).isDirectory()) throw new Error('Knowledge root must be a directory');
        const old = new Map(this.snapshot?.notes.map(note => [note.path, note]) || []);
        const notes: MarkdownNote[] = [];
        const failures: Array<{ path: string; reason: string }> = [];
        const excluded = this.config.exclude.map(value => value.replace(/\\/g, '/').replace(/\/$/, ''));
        let entries = 0, files = 0, bytes = 0, skipped = 0, failed = 0, unsupportedAttachments = 0, chunks = 0;
        async function walk(directory: string, relative: string, depth: number, source: MarkdownKnowledgeSource): Promise<void> {
            signal?.throwIfAborted();
            if (depth > 32) throw new Error('Knowledge directory depth exceeds 32');
            for await (const child of await opendir(directory)) {
                signal?.throwIfAborted();
                if (++entries > 10_000) throw new Error('Knowledge scan exceeds 10000 directory entries');
                const relativePath = relative ? `${relative}/${child.name}` : child.name;
                if (Buffer.byteLength(relativePath) > 1024) throw new Error('Knowledge path exceeds 1024 bytes');
                if (child.name.startsWith('.') || excluded.some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`)) || child.isSymbolicLink()) { skipped++; continue; }
                const filename = path.join(directory, child.name);
                const resolved = await realpath(filename);
                const boundary = path.relative(root, resolved);
                if (boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) throw new Error('Knowledge file escaped its root');
                if (child.isDirectory()) { await walk(filename, relativePath, depth + 1, source); continue; }
                if (!child.isFile() || path.extname(child.name).toLowerCase() !== '.md') { unsupportedAttachments++; continue; }
                if (++files > source.config.maxFiles) throw new Error('Knowledge scan exceeds configured file budget');
                let handle;
                try {
                    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK);
                    const info = await handle.stat();
                    if (!info.isFile() || info.size > source.config.maxFileBytes) throw new Error('File exceeds size budget or is not a regular file');
                    const buffer = Buffer.alloc(source.config.maxFileBytes + 1);
                    let size = 0;
                    while (size < buffer.length) {
                        signal?.throwIfAborted();
                        const read = await handle.read(buffer, size, buffer.length - size, size);
                        if (!read.bytesRead) break;
                        size += read.bytesRead;
                    }
                    if (size > source.config.maxFileBytes) throw new Error('File exceeds size budget');
                    bytes += size;
                    if (bytes > source.config.maxTotalBytes) throw new Error('Knowledge scan exceeds total byte budget');
                    const raw = buffer.subarray(0, size);
                    const previous = old.get(relativePath);
                    const note = previous?.version === contentHash(raw) ? previous : parseNote(relativePath, raw);
                    chunks += note.chunks.length;
                    if (chunks > 20_000) throw new Error('Knowledge scan exceeds 20000 chunks');
                    notes.push(note);
                } catch (error) {
                    signal?.throwIfAborted();
                    if (bytes > source.config.maxTotalBytes || chunks > 20_000) throw error;
                    failed++;
                    if (failures.length < 25) failures.push({ path: relativePath, reason: error instanceof Error ? error.message.slice(0, 256) : 'Cannot read note' });
                } finally { await handle?.close(); }
            }
        }
        await walk(root, '', 0, this);
        signal?.throwIfAborted();
        const linksByPath = resolveNoteLinks(notes);
        const links = [...linksByPath.values()].flat();
        const current = new Set(notes.map(note => note.path));
        const added = notes.filter(note => !old.has(note.path)).map(note => note.path).sort();
        const changed = notes.filter(note => old.has(note.path) && old.get(note.path)!.version !== note.version).map(note => note.path).sort();
        const removed = [...old.keys()].filter(name => !current.has(name)).sort();
        const snapshot: Snapshot = {
            notes, links: linksByPath,
            report: {
                sourceId: this.config.sourceId, version: contentHash(notes.map(note => `${note.path}:${note.version}`).sort().join('\n')),
                syncedAt: new Date().toISOString(), indexed: notes.length,
                added: added.slice(0, 25), changed: changed.slice(0, 25), removed: removed.slice(0, 25),
                addedCount: added.length, changedCount: changed.length, removedCount: removed.length,
                changesTruncated: [added, changed, removed].some(list => list.length > 25), failed, partial: failed > 0, failures, skipped, unsupportedAttachments,
                resolvedLinks: links.filter(link => link.status === 'resolved').length,
                ambiguousLinks: links.filter(link => link.status === 'ambiguous').length,
                missingLinks: links.filter(link => link.status === 'missing').length,
            },
        };
        this.snapshot = snapshot;
        return snapshot;
    }
}
