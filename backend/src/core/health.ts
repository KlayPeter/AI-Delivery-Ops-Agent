export interface AgentHostReadiness {
    initialized: boolean;
    started: boolean;
}

export interface BotConnectionReadiness {
    botInstanceId: string;
    state: string;
    reconnectAttempts: number;
}

export interface ReadinessDependencies {
    checkDatabase: () => Promise<void>;
    getAgentHostHealth: () => AgentHostReadiness | undefined;
    getBotConnections?: () => readonly BotConnectionReadiness[];
    requiredBotInstanceIds?: readonly string[];
    now?: () => Date;
}

export function livenessReport(startedAt: number = performance.timeOrigin): {
    ok: true;
    status: 'alive';
    uptime_seconds: number;
} {
    return {
        ok: true,
        status: 'alive',
        uptime_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    };
}

export async function readinessReport(dependencies: ReadinessDependencies): Promise<{
    ok: boolean;
    status: 'ready' | 'not_ready';
    checked_at: string;
    checks: {
        database: { ok: boolean; latency_ms: number };
        agent_host: { ok: boolean; initialized: boolean; started: boolean };
        bot_connections: {
            ok: boolean;
            required: number;
            connected: number;
            connections: Array<{ bot_instance_id: string; state: string; ok: boolean }>;
        };
    };
}> {
    const databaseStartedAt = performance.now();
    let databaseOk = false;
    try {
        await dependencies.checkDatabase();
        databaseOk = true;
    } catch {
        databaseOk = false;
    }

    const host = dependencies.getAgentHostHealth();
    const agentHost = {
        ok: host?.initialized === true && host.started === true,
        initialized: host?.initialized === true,
        started: host?.started === true,
    };
    const connections = dependencies.getBotConnections?.() || [];
    const unhealthyStates = new Set(['closed', 'disconnected', 'failed', 'error']);
    const requiredIds = Array.from(new Set(dependencies.requiredBotInstanceIds || []));
    const requiredConnections = requiredIds.map(botInstanceId => {
        const connection = connections.find(item => item.botInstanceId === botInstanceId);
        const state = connection?.state || 'missing';
        return {
            bot_instance_id: botInstanceId,
            state,
            ok: Boolean(connection) && !unhealthyStates.has(state.toLowerCase()),
        };
    });
    const botConnections = {
        ok: requiredConnections.every(connection => connection.ok),
        required: requiredConnections.length,
        connected: requiredConnections.filter(connection => connection.ok).length,
        connections: requiredConnections,
    };
    const ok = databaseOk && agentHost.ok && botConnections.ok;

    return {
        ok,
        status: ok ? 'ready' : 'not_ready',
        checked_at: (dependencies.now?.() || new Date()).toISOString(),
        checks: {
            database: {
                ok: databaseOk,
                latency_ms: Math.max(0, Math.round(performance.now() - databaseStartedAt)),
            },
            agent_host: agentHost,
            bot_connections: botConnections,
        },
    };
}
