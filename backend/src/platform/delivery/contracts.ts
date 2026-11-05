import type { Artifact } from '@/platform/agents/contracts';

export type MaybePromise<T> = T | Promise<T>;

export type DeliveryStatus = 'pending' | 'sending' | 'retry_wait' | 'delivered' | 'dead_letter';

export interface DeliveryTarget {
    workspaceId: string;
    botInstanceId: string;
    channel: 'private' | 'group';
    targetId: string;
}

export interface DeliveryError { code: string; message: string; retryable: boolean; retryAfterMs?: number }

export interface DeliveryRecord {
    id: string;
    deliveryKey: string;
    artifact: Artifact;
    target: DeliveryTarget;
    status: DeliveryStatus;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
    updatedAt: string;
    nextAttemptAt?: string;
    leaseUntil?: string;
    receipt?: Readonly<Record<string, unknown>>;
    error?: DeliveryError;
}

export interface DeliveryAdapter {
    deliver(record: DeliveryRecord, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

export interface DeliveryOutbox {
    enqueue(input: { deliveryKey: string; artifact: Artifact; target: DeliveryTarget; maxAttempts?: number }, now?: Date): MaybePromise<DeliveryRecord>;
    claimDue(now?: Date, limit?: number): MaybePromise<DeliveryRecord[]>;
    markDelivered(id: string, receipt: Readonly<Record<string, unknown>>, now?: Date): MaybePromise<DeliveryRecord>;
    markFailed(id: string, error: DeliveryError, nextAttemptAt: Date, now?: Date): MaybePromise<DeliveryRecord>;
    get(id: string): MaybePromise<DeliveryRecord | null>;
}
