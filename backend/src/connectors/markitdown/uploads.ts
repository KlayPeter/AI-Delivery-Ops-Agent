import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const formats = ['.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const metadata = z.object({ id: z.string().uuid(), name: z.string().min(1).max(200), extension: z.enum(formats), size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().int(), workspaceId: z.string(), botInstanceId: z.string() }).strict();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class DocumentUploads {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly root: string) {}
    private async read(filename: string, limit: number) {
        const file = await open(path.join(this.root, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const info = await file.stat();
            if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > limit) throw new Error('无效的本地文档暂存文件');
            const bytes = await file.readFile(); if (bytes.length > limit) throw new Error('暂存文件超过大小上限'); return bytes;
        } finally { await file.close(); }
    }
    async save(name: string, bytes: Buffer) {
        const extension = path.extname(name).toLowerCase();
        if (!name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name) || !formats.includes(extension as typeof formats[number]) || !bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error('请选择 10 MiB 以内的 PDF、Word、PPT、Excel、TXT 或 Markdown 文件');
        const task = this.tail.then(async () => {
            await mkdir(this.root, { recursive: true, mode: 0o700 });
            const directory = await lstat(this.root);
            if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('文档暂存目录必须是私有目录');
            const names = await readdir(this.root);
            for (const filename of names) if (/^[a-f0-9-]{36}\.(json|bin)$/.test(filename)) {
                const info = await lstat(path.join(this.root, filename));
                if (info.isFile() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 86400_000) await unlink(path.join(this.root, filename));
            }
            if ((await readdir(this.root)).length + 2 > 40) throw new Error('文档暂存区已满，请等待过期清理或清理暂存目录后重试');
            const value = metadata.parse({ id: randomUUID(), name, extension, size: bytes.length, sha256: digest(bytes), createdAt: Date.now(), workspaceId: 'workspace-default', botInstanceId: 'bot-default' });
            try {
                for (const [suffix, body] of [['bin', bytes], ['json', Buffer.from(JSON.stringify(value))]] as const) {
                    const file = await open(path.join(this.root, `${value.id}.${suffix}`), 'wx', 0o600);
                    try { await file.writeFile(body); } finally { await file.close(); }
                }
            } catch (error) { await this.remove(value.id); throw error; }
            return value;
        });
        this.tail = task.catch(() => {}); return task;
    }
    async load(id: string, scope: { workspaceId: string; botInstanceId: string }) {
        z.string().uuid().parse(id);
        const value = metadata.parse(JSON.parse((await this.read(`${id}.json`, 4096)).toString('utf8')));
        if (value.id !== id || value.workspaceId !== scope.workspaceId || value.botInstanceId !== scope.botInstanceId || Date.now() - value.createdAt > 86400_000) throw new Error('文档暂存记录不属于当前工作区或已过期，请重新选择文件');
        const bytes = await this.read(`${id}.bin`, MAX_DOCUMENT_BYTES);
        if (bytes.length !== value.size || digest(bytes) !== value.sha256) throw new Error('文档暂存内容已变化，请重新上传');
        return { metadata: value, bytes };
    }
    async remove(id: string) {
        z.string().uuid().parse(id);
        await Promise.all(['bin', 'json'].map(suffix => unlink(path.join(this.root, `${id}.${suffix}`)).catch((error: any) => { if (error.code !== 'ENOENT') throw error; })));
    }
}
