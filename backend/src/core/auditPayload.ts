const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|api[_-]?key|password|passwd|app[_-]?secret|access[_-]?key)/i;
const DEFAULT_MAX_BYTES = 64 * 1024;

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 12) return '[max-depth]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => sanitize(item, seen, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, seen, depth + 1);
    }
    return result;
}

export function sanitizeAuditPayload(payload: unknown): unknown {
    return sanitize(payload, new WeakSet<object>(), 0);
}

export function serializeAuditPayload(payload: unknown, maxBytes: number = DEFAULT_MAX_BYTES): string {
    const serialized = JSON.stringify(sanitizeAuditPayload(payload));
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= maxBytes) return serialized;
    const preview = serialized.slice(0, Math.max(0, maxBytes - 512));
    return JSON.stringify({
        truncated: true,
        original_bytes: bytes,
        preview,
    });
}
