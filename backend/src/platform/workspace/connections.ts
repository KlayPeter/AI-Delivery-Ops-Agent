import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const connectionKeys = [
    'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BOT_NAME', 'FEISHU_BOT_OPEN_ID',
    'AI_PROVIDER', 'AI_API_BASE', 'AI_API_KEY', 'AI_MODEL',
    'TAPD_WORKSPACE_ID', 'TAPD_API_BASE', 'TAPD_API_TOKEN', 'TAPD_WORKITEM_TYPE_ID',
    'KNOWLEDGE_KIND', 'KNOWLEDGE_ROOT', 'KNOWLEDGE_URLS', 'KNOWLEDGE_VAULT_NAME', 'KNOWLEDGE_EXCLUDE',
    'RELEASE_GITHUB_REPOSITORY', 'RELEASE_GITHUB_BRANCH', 'RELEASE_GITHUB_TOKEN',
] as const;
const secretKeys = new Set(['FEISHU_APP_SECRET', 'AI_API_KEY', 'TAPD_API_TOKEN', 'RELEASE_GITHUB_TOKEN']);
const settingValue = z.string().max(8192).refine(value => !value.includes('\0'));
const settingsSchema = z.partialRecord(z.enum(connectionKeys), settingValue);
const updateSchema = z.partialRecord(z.enum(connectionKeys), settingValue.nullable());
type Settings = Partial<Record<typeof connectionKeys[number], string>>;

export class LocalConnections {
    private saved: Settings = {};
    private active: Settings = {};
    private tail: Promise<unknown> = Promise.resolve();

    constructor(private readonly file: string) {}

    async initialize(): Promise<void> {
        try {
            const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 65536) {
                    throw new Error('Local connection settings must be a private regular file');
                }
                this.saved = settingsSchema.parse(JSON.parse(await file.readFile('utf8')));
            } finally { await file.close(); }
        } catch (error: any) {
            if (error.code !== 'ENOENT') throw error;
        }
        for (const key of connectionKeys) {
            if (this.saved[key] !== undefined) process.env[key] = this.saved[key];
            this.active[key] = process.env[key] || '';
        }
    }

    snapshot() {
        const values: Record<string, string> = {}, secrets: Record<string, boolean> = {};
        for (const key of connectionKeys) {
            const value = this.saved[key] ?? this.active[key] ?? '';
            if (secretKeys.has(key)) secrets[key] = Boolean(value);
            else values[key] = value;
        }
        return { values, secrets, restartRequired: connectionKeys.some(key => (this.saved[key] ?? this.active[key] ?? '') !== this.active[key]) };
    }

    save(input: unknown): Promise<ReturnType<LocalConnections['snapshot']>> {
        const task = this.tail.then(async () => {
            const update = updateSchema.parse(input);
            const next = { ...this.saved };
            for (const [key, value] of Object.entries(update)) {
                if (value === null && !secretKeys.has(key)) throw new Error('Only secret fields can be cleared with null');
                next[key as keyof Settings] = value === null ? '' : value.trim();
            }
            const merged = { ...this.active, ...next };
            if (Boolean(merged.FEISHU_APP_ID) !== Boolean(merged.FEISHU_APP_SECRET)) throw new Error('请同时填写飞书 App ID 和 App Secret');
            if (merged.FEISHU_APP_ID && !/^cli_[0-9a-fA-F]{16}$/.test(merged.FEISHU_APP_ID)) throw new Error('飞书 App ID 格式不正确');
            if (merged.AI_PROVIDER && !['openai', 'deepseek', 'google', 'gemini'].includes(merged.AI_PROVIDER)) throw new Error('不支持的模型供应商');
            if (merged.AI_API_KEY && !merged.AI_MODEL) throw new Error('请填写模型名称');
            if (merged.TAPD_WORKSPACE_ID && !/^\d+$/.test(merged.TAPD_WORKSPACE_ID)) throw new Error('TAPD Workspace ID 必须是数字');
            for (const key of ['AI_API_BASE', 'TAPD_API_BASE'] as const) {
                if (!merged[key]) continue;
                const url = new URL(merged[key]);
                if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址必须是无内嵌凭据的 HTTP/HTTPS URL');
            }
            if (merged.KNOWLEDGE_KIND && !['sample', 'markdown', 'web', 'library'].includes(merged.KNOWLEDGE_KIND)) throw new Error('知识来源类型不正确');
            if (merged.KNOWLEDGE_KIND === 'markdown') {
                if (!merged.KNOWLEDGE_ROOT || !path.isAbsolute(merged.KNOWLEDGE_ROOT)) throw new Error('请填写笔记目录的绝对路径');
                const { markdownSourceConfig } = await import('@/knowledge/markdown/source');
                markdownSourceConfig.parse({ root: merged.KNOWLEDGE_ROOT, exclude: lines(merged.KNOWLEDGE_EXCLUDE || '') });
            }
            if (merged.KNOWLEDGE_KIND === 'web') {
                const { webSourceConfig } = await import('@/knowledge/web/source');
                webSourceConfig.parse({ urls: lines(merged.KNOWLEDGE_URLS || '') });
            }
            if (merged.RELEASE_GITHUB_REPOSITORY) {
                const { githubConfig } = await import('@/connectors/github/source');
                githubConfig.parse({ repository: merged.RELEASE_GITHUB_REPOSITORY, baseBranch: merged.RELEASE_GITHUB_BRANCH || undefined });
            }
            await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            const file = await open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(JSON.stringify(next));
                await file.sync();
                await file.close();
                await rename(temporary, this.file);
            } catch (error) {
                await file.close().catch(() => {});
                await unlink(temporary).catch(() => {});
                throw error;
            }
            this.saved = next;
            return this.snapshot();
        });
        this.tail = task.catch(() => {});
        return task;
    }
}

export function lines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

export function isLocalWorkspaceRequest(request: Request): boolean {
    const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    try {
        if (!loopback(new URL(request.url).hostname) || request.headers.get('sec-fetch-site') === 'cross-site') return false;
        const origin = request.headers.get('origin');
        return !origin || (['http:', 'https:'].includes(new URL(origin).protocol) && loopback(new URL(origin).hostname));
    } catch { return false; }
}
