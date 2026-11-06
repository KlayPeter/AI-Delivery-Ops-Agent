export async function readJsonInput(request: Request, maxBytes: number) {
    if (Number(request.headers.get('content-length')) > maxBytes) {
        void request.body?.cancel().catch(() => {});
        throw Object.assign(new Error('请求超过大小限制'), { status: 413 });
    }
    const reader = request.body?.getReader();
    if (!reader) throw new Error('缺少请求正文');
    const chunks: Uint8Array[] = []; let size = 0, timedOut = false;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, 10000);
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
        while (true) {
            request.signal.throwIfAborted();
            const { done, value } = await reader.read();
            request.signal.throwIfAborted();
            if (timedOut) throw Object.assign(new Error('读取请求超时'), { status: 408 });
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { cancel(); throw Object.assign(new Error('请求超过大小限制'), { status: 413 }); }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
