import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { composeProfiles, compositionInput } from './compose';

const limit = 3 * 1024 * 1024;
const revision = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const confirmation = z.object({ expectedRevision: revision, confirmed: z.literal(true) }).strict();
const saveInput = compositionInput.extend(confirmation.shape).strict();
const activationInput = confirmation.extend({ enabled: z.boolean() }).strict();
const recordSchema = compositionInput.extend({ apiVersion: z.literal('1.0'), enabled: z.boolean() }).strict();
type Record = z.infer<typeof recordSchema>;
type Saved = { record: Record; revision: string; profile: ReturnType<typeof composeProfiles> };
export class ProfileConflict extends Error {}

export class SavedPluginProfiles {
    private readonly file: string;
    // shortcut: serializes one Host; add process locking if shared data directories become supported.
    private tail: Promise<unknown> = Promise.resolve();
    constructor(dataPath: string, private readonly appliedRevision: string | null = null, private readonly externalFile = Boolean(process.env.AGENT_PLUGINS_FILE)) {
        this.file = path.join(dataPath, 'plugin-profile.json');
    }

    async read(): Promise<Saved | null> {
        let file;
        try {
            file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > limit) throw new Error('Saved plugin profile must be a private regular file');
            const bytes = Buffer.alloc(limit + 1);
            let size = 0;
            while (size < bytes.length) {
                const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
                if (!bytesRead) break;
                size += bytesRead;
            }
            if (size > limit) throw new Error('Saved plugin profile exceeds byte limit');
            const text = bytes.subarray(0, size).toString('utf8'), record = recordSchema.parse(JSON.parse(text));
            return { record, revision: createHash('sha256').update(text).digest('hex'), profile: composeProfiles({ files: record.files }) };
        } catch (error: any) {
            if (error.code === 'ENOENT') return null;
            throw error;
        } finally { await file?.close(); }
    }

    private present(saved: Saved | null) {
        return { editable: !this.externalFile, revision: saved?.revision ?? null, enabled: saved?.record.enabled ?? false,
            pending: !this.externalFile && (saved?.revision ?? null) !== this.appliedRevision, ...(saved ? { profile: saved.profile } : {}) };
    }
    async snapshot() { return this.present(await this.read()); }

    async save(value: unknown) {
        const input = saveInput.parse(value);
        return this.change(input.expectedRevision, () => ({ apiVersion: '1.0', enabled: true, files: input.files }));
    }
    async activate(value: unknown) {
        const input = activationInput.parse(value);
        return this.change(input.expectedRevision, current => {
            if (!current) throw new ProfileConflict('尚未保存组合，请先选择配置并预览。');
            return { ...current, enabled: input.enabled };
        });
    }

    private change(expected: string | null, next: (current: Record | null) => Record) {
        const task = this.tail.then(async () => {
            if (this.externalFile) throw new ProfileConflict('显式配置文件正在管理插件，请按原方式修改该文件。');
            const current = await this.read();
            if ((current?.revision ?? null) !== expected) throw new ProfileConflict('已保存组合已变化，请刷新并重新核对。');
            const record = recordSchema.parse(next(current?.record ?? null)), profile = composeProfiles({ files: record.files });
            const text = JSON.stringify(record);
            if (Buffer.byteLength(text) > limit) throw new Error('Saved plugin profile exceeds byte limit');
            await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(text); await file.sync(); await file.close(); await rename(temporary, this.file); }
            catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
            return this.present({ record, profile, revision: createHash('sha256').update(text).digest('hex') });
        });
        this.tail = task.catch(() => {});
        return task;
    }
}
