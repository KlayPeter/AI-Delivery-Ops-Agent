import { describe, expect, test } from 'bun:test';
import { InMemoryDeliveryOutbox } from '@/platform/delivery/outbox';
import { DeliveryWorker } from '@/platform/delivery/worker';
import { BotRegistry } from '@/platform/bots/registry';
import { FeishuDeliveryAdapter } from '@/platform/delivery/feishuAdapter';

const artifact: any = { id: 'artifact-1', runId: 'run-1', type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'hello', metadata: {}, createdAt: '2026-07-14T00:00:00Z' };
const target: any = { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_target' };
const bots = () => new BotRegistry([{ id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'default', appId: 'app', secretRef: 'secret://bot', status: 'active', config: {} }]);

describe('Delivery Outbox', () => {
    test('deduplicates the same delivery key', () => {
        const outbox = new InMemoryDeliveryOutbox();
        const first = outbox.enqueue({ deliveryKey: 'run-1:artifact-1:oc_target', artifact, target });
        const second = outbox.enqueue({ deliveryKey: 'run-1:artifact-1:oc_target', artifact, target });
        expect(second.id).toBe(first.id); expect(outbox.list()).toHaveLength(1);
    });

    test('coalesces concurrent drains so an expired lease cannot send the same delivery twice', async () => {
        const startedAt = new Date('2026-07-14T00:00:00Z');
        const outbox = new InMemoryDeliveryOutbox(10);
        outbox.enqueue({ deliveryKey: 'delivery-concurrent-drain', artifact, target }, startedAt);
        let deliveries = 0;
        let enterDelivery!: () => void;
        let releaseDelivery!: () => void;
        const entered = new Promise<void>(resolve => { enterDelivery = resolve; });
        const gate = new Promise<void>(resolve => { releaseDelivery = resolve; });
        const worker = new DeliveryWorker(outbox, bots(), {
            deliver: async () => {
                deliveries++;
                enterDelivery();
                await gate;
                return { messageId: 'om_once' };
            },
        });

        const first = worker.runOnce(startedAt);
        await entered;
        const second = worker.runOnce(new Date(startedAt.getTime() + 11));
        releaseDelivery();

        expect(await Promise.all([first, second])).toEqual([
            { delivered: 1, retried: 0, deadLettered: 0 },
            { delivered: 1, retried: 0, deadLettered: 0 },
        ]);
        expect(deliveries).toBe(1);
    });

    test('retries transient failure without rerunning the agent', async () => {
        const outbox = new InMemoryDeliveryOutbox(); const record = outbox.enqueue({ deliveryKey: 'delivery-retry', artifact, target });
        let attempts = 0;
        const worker = new DeliveryWorker(outbox, bots(), { deliver: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT', retryable: true }); return { messageId: 'om_1' }; } }, 10);
        const start = new Date('2026-07-14T00:00:00Z');
        expect(await worker.runOnce(start)).toEqual({ delivered: 0, retried: 1, deadLettered: 0 });
        expect(outbox.get(record.id)?.status).toBe('retry_wait');
        expect(await worker.runOnce(new Date(start.getTime() + 10))).toEqual({ delivered: 1, retried: 0, deadLettered: 0 });
        expect(outbox.get(record.id)).toMatchObject({ status: 'delivered', attempts: 2, receipt: { messageId: 'om_1' } });
    });

    test('honors the provider retry delay before claiming the delivery again', async () => {
        const outbox = new InMemoryDeliveryOutbox();
        const record = outbox.enqueue({ deliveryKey: 'delivery-retry-after', artifact, target });
        const worker = new DeliveryWorker(outbox, bots(), {
            deliver: async () => { throw Object.assign(new Error('rate limited'), { retryable: true, retryAfterMs: 5_000 }); },
        }, 10);
        const start = new Date('2026-07-14T00:00:00Z');

        expect(await worker.runOnce(start)).toEqual({ delivered: 0, retried: 1, deadLettered: 0 });
        expect(outbox.get(record.id)).toMatchObject({
            status: 'retry_wait',
            nextAttemptAt: '2026-07-14T00:00:05.000Z',
            error: { retryable: true, retryAfterMs: 5_000 },
        });
        expect(await worker.runOnce(new Date('2026-07-14T00:00:04.999Z'))).toEqual({ delivered: 0, retried: 0, deadLettered: 0 });
    });

    test('dead-letters permanent failures', async () => {
        const outbox = new InMemoryDeliveryOutbox(); const record = outbox.enqueue({ deliveryKey: 'delivery-dead', artifact, target });
        const worker = new DeliveryWorker(outbox, bots(), { deliver: async () => { throw Object.assign(new Error('invalid target'), { retryable: false }); } });
        expect(await worker.runOnce(new Date('2026-07-14T00:00:00Z'))).toEqual({ delivered: 0, retried: 0, deadLettered: 1 });
        expect(outbox.get(record.id)?.status).toBe('dead_letter');
    });

    test('times out even when an adapter ignores the abort signal', async () => {
        const outbox = new InMemoryDeliveryOutbox(); const record = outbox.enqueue({ deliveryKey: 'delivery-timeout', artifact, target });
        const never = new Promise<Readonly<Record<string, unknown>>>(() => {});
        const worker = new DeliveryWorker(outbox, bots(), { deliver: async () => never }, 10, 5);
        expect(await worker.runOnce(new Date('2026-07-14T00:00:00Z'))).toEqual({ delivered: 0, retried: 1, deadLettered: 0 });
        expect(outbox.get(record.id)).toMatchObject({ status: 'retry_wait', error: { code: 'TIMEOUT', retryable: true } });
    });

    test('aborts the underlying delivery when its deadline expires', async () => {
        const outbox = new InMemoryDeliveryOutbox();
        outbox.enqueue({ deliveryKey: 'delivery-aborted', artifact, target });
        let aborted = false;
        const worker = new DeliveryWorker(outbox, bots(), {
            deliver: async (_record, signal) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
                }, { once: true });
            }),
        }, 10, 5);

        expect(await worker.runOnce(new Date('2026-07-14T00:00:00Z'))).toEqual({ delivered: 0, retried: 1, deadLettered: 0 });
        expect(aborted).toBeTrue();
    });

    test('rejects a delivery target outside the BotInstance workspace', async () => {
        const outbox = new InMemoryDeliveryOutbox(); const record = outbox.enqueue({
            deliveryKey: 'delivery-cross-workspace', artifact, target: { ...target, workspaceId: 'workspace-attacker' },
        });
        let deliveries = 0;
        const worker = new DeliveryWorker(outbox, bots(), { deliver: async () => { deliveries++; return {}; } });
        expect(await worker.runOnce(new Date('2026-07-14T00:00:00Z'))).toEqual({ delivered: 0, retried: 0, deadLettered: 1 });
        expect(deliveries).toBe(0);
        expect(outbox.get(record.id)).toMatchObject({ status: 'dead_letter', error: { code: 'WORKSPACE_SCOPE_MISMATCH', retryable: false } });
    });

    test('passes cancellation and permanent Feishu errors through the delivery adapter', async () => {
        const controller = new AbortController();
        let receivedSignal: AbortSignal | undefined;
        const adapter = new FeishuDeliveryAdapter({
            sendGroupMarkdown: async (_content: string, _targetId: string, _title?: string, signal?: AbortSignal) => {
                receivedSignal = signal;
                return {
                    ok: false,
                    raw: { code: 99991403 },
                    error: 'quota exhausted',
                    error_code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED',
                    retryable: false,
                };
            },
        } as any);

        let thrown: any;
        try {
            await adapter.deliver({ ...({ artifact, target } as any) }, controller.signal);
        } catch (error) {
            thrown = error;
        }
        expect(receivedSignal).toBe(controller.signal);
        expect(thrown).toMatchObject({ code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED', retryable: false });
    });
});
