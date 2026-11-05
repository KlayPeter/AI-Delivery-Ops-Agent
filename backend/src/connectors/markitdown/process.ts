import { z } from 'zod';
import * as path from 'node:path';

const resultSchema = z.object({ markdown: z.string().min(1).max(512 * 1024), title: z.string().nullable().optional(), version: z.literal('0.1.9') });
export async function runMarkItDown(python: string, bytes?: Buffer, extension?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const child = Bun.spawn([python, '-I', path.join(import.meta.dir, 'convert.py'), ...(extension ? [extension] : [])], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: process.env.PATH || '', PYTHONUTF8: '1' },
    });
    let exceeded = false;
    const timer = setTimeout(() => child.kill(9), bytes ? 45_000 : 30_000);
    const abort = () => { child.kill(9); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        if (signal?.aborted) child.kill();
        if (bytes) child.stdin.write(bytes);
        child.stdin.end();
        const read = async () => {
            const chunks: Uint8Array[] = []; let size = 0;
            const reader = child.stdout.getReader();
            try { while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                size += chunk.value.length;
                if (size > 512 * 1024 + 1024) { exceeded = true; child.kill(9); throw new Error('转换正文超过输出上限'); }
                chunks.push(chunk.value);
            } } finally { reader.releaseLock(); }
            return Buffer.concat(chunks).toString('utf8');
        };
        const [output, status] = await Promise.all([read(), child.exited]);
        signal?.throwIfAborted();
        if (status !== 0) throw new Error(exceeded ? '转换正文超过输出上限' : '转换失败，请检查文件是否损坏、加密或超出处理预算，以及本地 MarkItDown 环境是否完整');
        const parsed = JSON.parse(output);
        return bytes ? resultSchema.parse(parsed) : z.object({ version: z.literal('0.1.9') }).parse(parsed);
    } catch (error) {
        child.kill(9); await child.exited;
        signal?.throwIfAborted();
        throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
