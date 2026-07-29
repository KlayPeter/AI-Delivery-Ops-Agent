import { describe, expect, test } from 'bun:test';
import { livenessReport, readinessReport } from '../src/core/health';

describe('health reports', () => {
    test('liveness only reports whether the process can answer', () => {
        const report = livenessReport(Date.now() - 5_500);

        expect(report.ok).toBe(true);
        expect(report.status).toBe('alive');
        expect(report.uptime_seconds).toBeGreaterThanOrEqual(5);
    });

    test('readiness requires both database access and a started Agent Host', async () => {
        const report = await readinessReport({
            checkDatabase: async () => {},
            getAgentHostHealth: () => ({ initialized: true, started: true }),
            getBotConnections: () => [
                { botInstanceId: 'bot-default', state: 'connected', reconnectAttempts: 0 },
                { botInstanceId: 'bot-ai-news', state: 'connected', reconnectAttempts: 0 },
            ],
            requiredBotInstanceIds: ['bot-default', 'bot-ai-news'],
            now: () => new Date('2026-07-29T00:00:00.000Z'),
        });

        expect(report.ok).toBe(true);
        expect(report.status).toBe('ready');
        expect(report.checked_at).toBe('2026-07-29T00:00:00.000Z');
        expect(report.checks.database.ok).toBe(true);
        expect(report.checks.agent_host.ok).toBe(true);
        expect(report.checks.bot_connections).toMatchObject({
            ok: true,
            required: 2,
            connected: 2,
        });
    });

    test('readiness fails closed without exposing database errors', async () => {
        const report = await readinessReport({
            checkDatabase: async () => {
                throw new Error('file path and credentials must stay private');
            },
            getAgentHostHealth: () => ({ initialized: true, started: true }),
        });

        expect(report.ok).toBe(false);
        expect(report.status).toBe('not_ready');
        expect(report.checks.database.ok).toBe(false);
        expect(JSON.stringify(report)).not.toContain('credentials');
    });

    test('readiness fails until the Agent Host is initialized and started', async () => {
        const report = await readinessReport({
            checkDatabase: async () => {},
            getAgentHostHealth: () => ({ initialized: true, started: false }),
        });

        expect(report.ok).toBe(false);
        expect(report.checks.database.ok).toBe(true);
        expect(report.checks.agent_host).toEqual({
            ok: false,
            initialized: true,
            started: false,
        });
    });

    test('readiness fails when an enabled BotInstance has no live connection', async () => {
        const report = await readinessReport({
            checkDatabase: async () => {},
            getAgentHostHealth: () => ({ initialized: true, started: true }),
            getBotConnections: () => [
                { botInstanceId: 'bot-default', state: 'connected', reconnectAttempts: 0 },
            ],
            requiredBotInstanceIds: ['bot-default', 'bot-ai-news'],
        });

        expect(report.ok).toBe(false);
        expect(report.checks.bot_connections).toEqual({
            ok: false,
            required: 2,
            connected: 1,
            connections: [
                { bot_instance_id: 'bot-default', state: 'connected', ok: true },
                { bot_instance_id: 'bot-ai-news', state: 'missing', ok: false },
            ],
        });
    });
});
