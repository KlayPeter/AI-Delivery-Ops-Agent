import { describe, expect, test } from 'bun:test';
import { InMemoryDeliveryOutbox } from '@/platform/delivery/outbox';
import { DeliveryWorker } from '@/platform/delivery/worker';
import { BotRegistry } from '@/platform/bots/registry';

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
});
