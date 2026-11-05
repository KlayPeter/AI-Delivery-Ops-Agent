export function prepareReleaseInput(values: { since: string; until?: string; policyQuery: string }, operation: 'collect' | 'prepare', now = Date.now()) {
  const since = new Date(values.since).getTime(), until = values.until ? new Date(values.until).getTime() : now;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until || until > now) throw new Error('请选择有效时间段：开始早于结束，结束不晚于当前时间');
  const policyQuery = values.policyQuery.trim();
  if (!policyQuery || policyQuery.length > 500) throw new Error('请填写 1–500 字的规则关键词');
  return { since: new Date(since).toISOString(), ...(values.until ? { until: new Date(until).toISOString() } : {}), policyQuery, operation, limit: 5 };
}
