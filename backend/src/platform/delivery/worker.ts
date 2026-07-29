import type { BotRegistry } from '@/platform/bots/registry';
import type { DeliveryAdapter, DeliveryError, DeliveryOutbox } from './contracts';

export class DeliveryWorker {
    private timer?: ReturnType<typeof setInterval>;
    private pollInFlight?: Promise<void>;

    constructor(
        private readonly outbox: DeliveryOutbox,
        private readonly bots: BotRegistry,
        private readonly adapter: DeliveryAdapter,
        private readonly retryBaseMs: number = 1000,
        private readonly timeoutMs: number = 10_000,
    ) {}

    start(intervalMs: number = 1000, onError: (error: unknown) => void = console.error): void {
        if (this.timer) return;
        const poll = (): void => {
            if (this.pollInFlight) return;
            this.pollInFlight = this.runOnce()
                .then((): void => undefined)
                .catch((error): void => { onError(error); })
                .finally(() => { this.pollInFlight = undefined; });
        };
        poll();
        this.timer = setInterval(poll, Math.max(10, intervalMs));
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.pollInFlight;
    }

    async runOnce(now: Date = new Date()): Promise<{ delivered: number; retried: number; deadLettered: number }> {
        const counts = { delivered: 0, retried: 0, deadLettered: 0 };
        for (const record of await this.outbox.claimDue(now)) {
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const bot = this.bots.requireActive(record.target.botInstanceId);
                if (bot.workspaceId !== record.target.workspaceId) throw Object.assign(new Error('Delivery target workspace does not match BotInstance'), { code: 'WORKSPACE_SCOPE_MISMATCH', retryable: false });
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(Object.assign(new Error('Delivery timed out'), { code: 'TIMEOUT', retryable: true }));
                    }, Math.max(1, this.timeoutMs));
                });
                const receipt = await Promise.race([this.adapter.deliver(record, controller.signal), timeout]);
                await this.outbox.markDelivered(record.id, receipt, now); counts.delivered++;
            } catch (cause: any) {
                const error: DeliveryError = {
                    code: cause?.code || (controller.signal.aborted ? 'TIMEOUT' : 'DELIVERY_ERROR'),
                    message: cause?.message || String(cause),
                    retryable: cause?.retryable !== false,
                };
                const delay = this.retryBaseMs * Math.pow(2, Math.max(0, record.attempts - 1));
                const failed = await this.outbox.markFailed(record.id, error, new Date(now.getTime() + delay), now);
                if (failed.status === 'retry_wait') counts.retried++; else counts.deadLettered++;
            } finally { if (timer) clearTimeout(timer); }
        }
        return counts;
    }
}
