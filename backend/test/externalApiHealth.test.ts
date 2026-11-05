import { beforeEach, describe, expect, test } from 'bun:test';
import { classifyFeishuFailure, FeishuAdapter } from '@/adapters/feishu';
import {
    externalApiCircuit,
    externalApiHealthSnapshot,
    normalizeExternalApiOperation,
    observeExternalApiCall,
    openExternalApiCircuit,
    resetExternalApiHealthForTests,
} from '@/platform/observability/externalApiHealth';

describe('external API health', () => {
    beforeEach(() => resetExternalApiHealthForTests());

    test('aggregates calls by normalized endpoint without exposing resource ids', async () => {
        const operation = normalizeExternalApiOperation('GET', 'https://open.feishu.cn/open-apis/im/v1/chats/oc_secret/members?page_size=100');
        await observeExternalApiCall({ provider: 'feishu', scope: 'cli_test', operation, request: async () => ({ code: 0 }), isSuccess: value => value.code === 0 });
        await observeExternalApiCall({ provider: 'feishu', scope: 'cli_test', operation, request: async () => ({ code: 1 }), isSuccess: value => value.code === 0 });

        expect(operation).toBe('GET /open-apis/im/v1/chats/:chat_id/members');
        expect(externalApiHealthSnapshot().providers[0]).toMatchObject({
            provider: 'feishu',
            health: 'degraded',
            calls: 2,
            metered_calls: 2,
            failures: 1,
            operations: [{ scope: 'cli_test', operation, calls: 2, successes: 1, failures: 1 }],
        });
    });

    test('reports provider circuit state and clears it after expiry', () => {
        openExternalApiCircuit('feishu', 'quota', new Date('2026-08-04T00:00:00.000Z'), 'cli_test');
        expect(externalApiCircuit('feishu', 'cli_test', new Date('2026-08-03T00:00:00.000Z'))).toMatchObject({ reason: 'quota', scope: 'cli_test' });
        expect(externalApiCircuit('feishu', 'cli_other', new Date('2026-08-03T00:00:00.000Z'))).toBeNull();
        expect(externalApiCircuit('feishu', 'cli_test', new Date('2026-08-04T00:00:00.000Z'))).toBeNull();
    });

    test('classifies Feishu rate limits and monthly quota exhaustion', () => {
        expect(classifyFeishuFailure({ response: { status: 429, headers: { 'retry-after': '3' }, data: { code: 99991400, msg: 'busy' } } })).toMatchObject({
            code: 'FEISHU_RATE_LIMITED', retryable: true, retryAfterMs: 3_000, quotaExhausted: false,
        });
        expect(classifyFeishuFailure({ raw: { code: 99991403, msg: 'quota exhausted' } })).toMatchObject({
            code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED', retryable: false, quotaExhausted: true,
        });
    });

    test('opens monthly quota circuit for only the affected Feishu application', () => {
        const affected = new FeishuAdapter({ app_id: 'cli_affected', app_secret: '', bot_open_id: '', bot_name: '', send_retry_count: 1 });
        const other = new FeishuAdapter({ app_id: 'cli_other', app_secret: '', bot_open_id: '', bot_name: '', send_retry_count: 1 });

        const result = (affected as any)._resultFromApi({ code: 99991403, msg: 'quota exhausted' }, 'chat_id', 'oc_test');

        expect(result).toMatchObject({ error_code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED', retryable: false });
        expect((affected as any)._quotaCircuitFailure()).toMatchObject({ error_code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED' });
        expect((other as any)._quotaCircuitFailure()).toBeNull();
    });
});
