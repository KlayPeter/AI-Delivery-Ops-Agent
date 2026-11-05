import type { MaintenanceConfig } from './config';

export interface RawIdempotencyRecord {
    key: string;
    value: string;
}

export interface DataRetentionStore {
    deleteAuditLogsBefore(cutoff: string, limit: number): Promise<number>;
    countAuditLogsBefore(cutoff: string): Promise<number>;
    listRawIdempotencyRecords(prefix: string): Promise<RawIdempotencyRecord[]>;
    deleteIdempotencyKeys(keys: string[]): Promise<number>;
}

export interface DataRetentionResult {
    cutoff: string;
    auditLogsDeleted: number;
    idempotencyDeleted: number;
    remainingExpiredAuditLogs: number;
    remainingExpiredIdempotency: number;
    batches: number;
    durationMs: number;
}

type StoredExecution = {
    received_at?: unknown;
    completed_at?: unknown;
    failed_at?: unknown;
    started_at?: unknown;
    updatedAt?: unknown;
    createdAt?: unknown;
};

function timestampOf(record: RawIdempotencyRecord): number | null {
    try {
        const value = JSON.parse(record.value) as StoredExecution;
        for (const candidate of [
            value.received_at,
            value.completed_at,
            value.failed_at,
            value.started_at,
            value.updatedAt,
            value.createdAt,
        ]) {
            if (typeof candidate !== 'string') continue;
            const timestamp = Date.parse(candidate);
            if (Number.isFinite(timestamp)) return timestamp;
        }
    } catch {
        return null;
    }
    return null;
}

export class DataRetentionService {
    constructor(
        private readonly store: DataRetentionStore,
        private readonly config: MaintenanceConfig,
    ) {}

    async run(now: Date = new Date()): Promise<DataRetentionResult> {
        const startedAt = Date.now();
        const cutoffDate = new Date(now.getTime() - this.config.audit_log_retention_days * 24 * 60 * 60 * 1000);
        const cutoff = cutoffDate.toISOString();
        const batchSize = this.config.cleanup_batch_size;
        const maxBatches = this.config.cleanup_max_batches;
        let batches = 0;
        let auditLogsDeleted = 0;
        let idempotencyDeleted = 0;

        while (batches < maxBatches) {
            const deleted = await this.store.deleteAuditLogsBefore(cutoff, batchSize);
            if (deleted === 0) break;
            auditLogsDeleted += deleted;
            batches++;
            if (deleted < batchSize) break;
        }

        const cutoffMs = cutoffDate.getTime();
        const expiredIdempotency = (
            await Promise.all([
                this.store.listRawIdempotencyRecords('scheduled:'),
                this.store.listRawIdempotencyRecords('maintenance:'),
                this.store.listRawIdempotencyRecords('feishu:event:'),
                this.store.listRawIdempotencyRecords('history-sync:'),
            ])
        )
            .flat()
            .map(record => ({ record, timestamp: timestampOf(record) }))
            .filter(item => item.timestamp !== null && item.timestamp < cutoffMs)
            .sort((left, right) => left.timestamp! - right.timestamp! || left.record.key.localeCompare(right.record.key));

        let offset = 0;
        while (batches < maxBatches && offset < expiredIdempotency.length) {
            const keys = expiredIdempotency.slice(offset, offset + batchSize).map(item => item.record.key);
            const deleted = await this.store.deleteIdempotencyKeys(keys);
            idempotencyDeleted += deleted;
            offset += keys.length;
            batches++;
        }

        return {
            cutoff,
            auditLogsDeleted,
            idempotencyDeleted,
            remainingExpiredAuditLogs: await this.store.countAuditLogsBefore(cutoff),
            remainingExpiredIdempotency: Math.max(0, expiredIdempotency.length - offset),
            batches,
            durationMs: Date.now() - startedAt,
        };
    }
}
