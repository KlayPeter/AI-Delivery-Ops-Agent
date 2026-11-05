export type ExternalApiProvider = 'feishu' | 'tapd';

interface OperationCounter {
    provider: ExternalApiProvider;
    scope: string;
    operation: string;
    calls: number;
    successes: number;
    failures: number;
    meteredCalls: number;
    totalDurationMs: number;
    maxDurationMs: number;
    lastCalledAt?: string;
    lastFailureAt?: string;
}

interface CircuitState {
    provider: ExternalApiProvider;
    scope: string;
    reason: string;
    openedAt: string;
    openUntil: string;
}

export interface ObserveExternalApiOptions<T> {
    provider: ExternalApiProvider;
    scope?: string;
    operation: string;
    metered?: boolean;
    request: () => Promise<T>;
    isSuccess?: (result: T) => boolean;
}

const startedAt = new Date().toISOString();
const counters = new Map<string, OperationCounter>();
const circuits = new Map<string, CircuitState>();

function resourceKey(provider: ExternalApiProvider, scope: string): string {
    return JSON.stringify([provider, scope]);
}

function getCounter(provider: ExternalApiProvider, scope: string, operation: string): OperationCounter {
    const key = JSON.stringify([provider, scope, operation]);
    const existing = counters.get(key);
    if (existing) return existing;
    const created: OperationCounter = {
        provider,
        scope,
        operation,
        calls: 0,
        successes: 0,
        failures: 0,
        meteredCalls: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
    };
    counters.set(key, created);
    return created;
}

export function normalizeExternalApiOperation(method: string, rawUrl: string): string {
    let pathname = rawUrl;
    try {
        pathname = new URL(rawUrl, 'https://local.invalid').pathname;
    } catch {}
    pathname = pathname
        .replace(/\/users\/[^/]+/g, '/users/:user_id')
        .replace(/\/departments\/[^/]+/g, '/departments/:department_id')
        .replace(/\/chats\/[^/]+/g, '/chats/:chat_id')
        .replace(/\/messages\/[^/]+/g, '/messages/:message_id')
        .replace(/\/reactions\/[^/]+/g, '/reactions/:reaction_id')
        .replace(/\/resources\/[^/]+/g, '/resources/:resource_key');
    return `${method.toUpperCase()} ${pathname}`;
}

export async function observeExternalApiCall<T>(options: ObserveExternalApiOptions<T>): Promise<T> {
    const current = getCounter(options.provider, options.scope || 'default', options.operation);
    const started = performance.now();
    current.calls++;
    if (options.metered !== false) current.meteredCalls++;
    current.lastCalledAt = new Date().toISOString();
    try {
        const result = await options.request();
        if ((options.isSuccess || (() => true))(result)) current.successes++;
        else {
            current.failures++;
            current.lastFailureAt = new Date().toISOString();
        }
        return result;
    } catch (error) {
        current.failures++;
        current.lastFailureAt = new Date().toISOString();
        throw error;
    } finally {
        const duration = Math.max(0, Math.round(performance.now() - started));
        current.totalDurationMs += duration;
        current.maxDurationMs = Math.max(current.maxDurationMs, duration);
    }
}

export function openExternalApiCircuit(provider: ExternalApiProvider, reason: string, openUntil: Date, scope: string = 'default'): void {
    circuits.set(resourceKey(provider, scope), {
        provider,
        scope,
        reason,
        openedAt: new Date().toISOString(),
        openUntil: openUntil.toISOString(),
    });
}

export function externalApiCircuit(provider: ExternalApiProvider, scope: string = 'default', now: Date = new Date()): CircuitState | null {
    const key = resourceKey(provider, scope);
    const circuit = circuits.get(key);
    if (!circuit) return null;
    if (Date.parse(circuit.openUntil) > now.getTime()) return { ...circuit };
    circuits.delete(key);
    return null;
}

function activeCircuits(provider: ExternalApiProvider, now: Date): CircuitState[] {
    return Array.from(circuits.values())
        .filter(circuit => circuit.provider === provider)
        .filter(circuit => externalApiCircuit(provider, circuit.scope, now) !== null)
        .filter(circuit => circuits.get(resourceKey(provider, circuit.scope)) === circuit)
        .map(circuit => ({ ...circuit }))
        .sort((left, right) => left.scope.localeCompare(right.scope));
}

export function externalApiHealthSnapshot(now: Date = new Date()) {
    const observationWindowMs = Math.max(0, now.getTime() - Date.parse(startedAt));
    const providers = (['feishu', 'tapd'] as const).map(provider => {
        const operations = Array.from(counters.values())
            .filter(current => current.provider === provider)
            .map(current => ({
                scope: current.scope,
                operation: current.operation,
                calls: current.calls,
                metered_calls: current.meteredCalls,
                successes: current.successes,
                failures: current.failures,
                failure_rate: current.calls ? Number((current.failures / current.calls).toFixed(4)) : 0,
                average_duration_ms: current.calls ? Math.round(current.totalDurationMs / current.calls) : 0,
                max_duration_ms: current.maxDurationMs,
                last_called_at: current.lastCalledAt,
                last_failure_at: current.lastFailureAt,
            }))
            .sort((left, right) => right.calls - left.calls || left.scope.localeCompare(right.scope) || left.operation.localeCompare(right.operation));
        const calls = operations.reduce((sum, item) => sum + item.calls, 0);
        const meteredCalls = operations.reduce((sum, item) => sum + item.metered_calls, 0);
        const failures = operations.reduce((sum, item) => sum + item.failures, 0);
        const providerCircuits = activeCircuits(provider, now);
        const scopeNames = Array.from(new Set([
            ...operations.map(item => item.scope),
            ...providerCircuits.map(item => item.scope),
        ])).sort();
        const scopes = scopeNames.map(scope => {
            const scopedOperations = operations.filter(item => item.scope === scope);
            const scopedCalls = scopedOperations.reduce((sum, item) => sum + item.calls, 0);
            const scopedMeteredCalls = scopedOperations.reduce((sum, item) => sum + item.metered_calls, 0);
            const scopedFailures = scopedOperations.reduce((sum, item) => sum + item.failures, 0);
            const circuit = providerCircuits.find(item => item.scope === scope) || null;
            const quotaLimit = provider === 'feishu' ? 1_000_000 : null;
            const projectedMonthlyCalls = quotaLimit && observationWindowMs >= 3_600_000 && scopedMeteredCalls > 0
                ? Math.round(scopedMeteredCalls / observationWindowMs * 30 * 24 * 60 * 60 * 1000)
                : null;
            const health = circuit
                ? 'quota_exhausted'
                : projectedMonthlyCalls !== null && projectedMonthlyCalls >= quotaLimit!
                    ? 'critical'
                    : projectedMonthlyCalls !== null && projectedMonthlyCalls >= quotaLimit! * 0.8
                        ? 'warning'
                        : scopedCalls > 0 && scopedFailures / scopedCalls >= 0.05
                            ? 'degraded'
                            : scopedCalls > 0 ? 'healthy' : 'unknown';
            return {
                scope,
                health,
                calls: scopedCalls,
                metered_calls: scopedMeteredCalls,
                failures: scopedFailures,
                quota_limit: quotaLimit,
                projected_monthly_metered_calls: projectedMonthlyCalls,
                circuit,
            };
        });
        return {
            provider,
            health: providerCircuits.length ? 'circuit_open' : calls > 0 && failures / calls >= 0.05 ? 'degraded' : calls > 0 ? 'healthy' : 'unknown',
            calls,
            metered_calls: meteredCalls,
            failures,
            circuits: providerCircuits,
            scopes,
            operations,
        };
    });
    return {
        started_at: startedAt,
        generated_at: now.toISOString(),
        observation_window_seconds: Math.round(observationWindowMs / 1000),
        scope: 'current_process',
        providers,
    };
}

export function resetExternalApiHealthForTests(): void {
    counters.clear();
    circuits.clear();
}
