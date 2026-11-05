export async function readSmallJsonBody(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
    if (!request.body || Number(request.headers.get('content-length')) > maxBytes) throw new Error(`配置请求超过 ${maxBytes / 1024} KiB 或缺少正文`);
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    const active = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const abort = () => { void reader.cancel().catch(() => {}); };
    active.addEventListener('abort', abort, { once: true });
    let bytes = 0;
    try {
        active.throwIfAborted();
        while (true) {
            const chunk = await reader.read(); active.throwIfAborted(); if (chunk.done) break;
            bytes += chunk.value.length; if (bytes > maxBytes) throw new Error(`配置请求超过 ${maxBytes / 1024} KiB`); chunks.push(chunk.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { active.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
