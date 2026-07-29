import { describe, expect, test } from 'bun:test';
import { serializeAuditPayload } from '@/core/auditPayload';
import {
    DataRetentionService,
    type DataRetentionStore,
    type RawIdempotencyRecord,
} from '@/core/dataRetention';
import type { MaintenanceConfig } from '@/core/config';

const config: MaintenanceConfig = {
    enabled: true,
    audit_log_retention_days: 90,
    cleanup_time: '03:30',
    cleanup_timezone: 'Asia/Shanghai',
    cleanup_batch_size: 500,
    cleanup_max_batches: 20,
};

class FakeRetentionStore implements DataRetentionStore {
    auditTimestamps: string[] = [];
    records = new Map<string, string>();
    failAuditDelete = false;

    async deleteAuditLogsBefore(cutoff: string, limit: number): Promise<number> {
        if (this.failAuditDelete) throw new Error('cleanup unavailable');
        const deleted = this.auditTimestamps.filter(timestamp => timestamp < cutoff).slice(0, limit);
        for (const timestamp of deleted) this.auditTimestamps.splice(this.auditTimestamps.indexOf(timestamp), 1);
        return deleted.length;
    }

    async countAuditLogsBefore(cutoff: string): Promise<number> {
        return this.auditTimestamps.filter(timestamp => timestamp < cutoff).length;
    }

    async listRawIdempotencyRecords(prefix: string): Promise<RawIdempotencyRecord[]> {
        return [...this.records.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value }));
    }

    async deleteIdempotencyKeys(keys: string[]): Promise<number> {
        let deleted = 0;
        for (const key of keys) if (this.records.delete(key)) deleted++;
        return deleted;
    }
}

describe('DataRetentionService', () => {
    test('deletes only data strictly older than the 90-day cutoff', async () => {
        const store = new FakeRetentionStore();
        store.auditTimestamps = [
            '2026-04-29T03:29:59.999Z',
            '2026-04-29T03:30:00.000Z',
            '2026-07-28T03:30:00.000Z',
        ];
        store.records.set('scheduled:old', JSON.stringify({ status: 'completed', completed_at: '2026-04-01T00:00:00.000Z' }));
        store.records.set('scheduled:recent', JSON.stringify({ status: 'completed', completed_at: '2026-07-28T00:00:00.000Z' }));
        store.records.set('agent:run:preserved', JSON.stringify({ status: 'succeeded', completedAt: '2026-01-01T00:00:00.000Z' }));

        const result = await new DataRetentionService(store, config).run(new Date('2026-07-28T03:30:00.000Z'));

        expect(result.auditLogsDeleted).toBe(1);
        expect(result.idempotencyDeleted).toBe(1);
        expect(store.auditTimestamps).toEqual([
            '2026-04-29T03:30:00.000Z',
            '2026-07-28T03:30:00.000Z',
        ]);
        expect(store.records.has('scheduled:recent')).toBeTrue();
        expect(store.records.has('agent:run:preserved')).toBeTrue();
    });

    test('bounds cleanup work by batch count and reports remaining expired data', async () => {
        const store = new FakeRetentionStore();
        store.auditTimestamps = Array.from({ length: 1_250 }, (_, index) =>
            new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString());
        const bounded = { ...config, cleanup_batch_size: 500, cleanup_max_batches: 2 };

        const result = await new DataRetentionService(store, bounded).run(new Date('2026-07-28T03:30:00.000Z'));

        expect(result.auditLogsDeleted).toBe(1_000);
        expect(result.batches).toBe(2);
        expect(result.remainingExpiredAuditLogs).toBe(250);
    });
});

describe('audit payload serialization', () => {
    test('redacts secrets while preserving operational fields', () => {
        const serialized = serializeAuditPayload({
            group_id: 'oc_group',
            authorization: 'Bearer secret',
            nested: { api_key: 'key', status: 'failed' },
        });
        expect(JSON.parse(serialized)).toEqual({
            group_id: 'oc_group',
            authorization: '[redacted]',
            nested: { api_key: '[redacted]', status: 'failed' },
        });
    });

    test('handles circular and oversized payloads without failing the business call', () => {
        const payload: any = { text: 'x'.repeat(2_000) };
        payload.self = payload;
        const parsed = JSON.parse(serializeAuditPayload(payload, 1_000));
        expect(parsed.truncated).toBeTrue();
        expect(parsed.original_bytes).toBeGreaterThan(1_000);
    });
});
