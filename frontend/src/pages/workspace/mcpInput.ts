export function mcpArguments(value: string): Record<string, unknown> {
  if (new TextEncoder().encode(value).length > 32768) throw new Error('参数最多 32 KiB');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('请填写有效的 JSON 对象'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}
