import type { BotRegistry } from '@/platform/bots/registry';
import type { DeliveryAdapter, DeliveryError, DeliveryOutbox } from './contracts';

export class DeliveryWorker {
    private timer?: ReturnType<typeof setInterval>;
    private runInFlight?: Promise<{ delivered: number; retried: number; deadLettered: number }>;

    constructor(
        private readonly outbox: DeliveryOutbox,
        private readonly bots: BotRegistry,
        private readonly adapter: DeliveryAdapter,
        private readonly retryBaseMs: number = 1000,
        private readonly timeoutMs: number = 10_000,
        private readonly isAvailable: () => boolean = () => true,
    ) {}

    start(intervalMs: number = 1000, onError: (error: unknown) => void = console.error): void {
        if (this.timer) return;
        const poll = (): void => {
            if (this.runInFlight) return;
            void this.runOnce().catch((error): void => { onError(error); });
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
        try {
            await this.runInFlight;
        } catch {}
    }

    async runOnce(now: Date = new Date()): Promise<{ delivered: number; retried: number; deadLettered: number }> {
        if (this.runInFlight) return this.runInFlight;
        const run = this.drain(now);
        this.runInFlight = run;
        try {
            return await run;
        } finally {
            if (this.runInFlight === run) this.runInFlight = undefined;
        }
    }

    private async drain(now: Date): Promise<{ delivered: number; retried: number; deadLettered: number }> {
        const counts = { delivered: 0, retried: 0, deadLettered: 0 };
        if (!this.isAvailable()) return counts;
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
                    retryAfterMs: Number.isFinite(cause?.retryAfterMs) ? Math.max(0, cause.retryAfterMs) : undefined,
                };
                const delay = error.retryAfterMs ?? this.retryBaseMs * Math.pow(2, Math.max(0, record.attempts - 1));
                const failed = await this.outbox.markFailed(record.id, error, new Date(now.getTime() + delay), now);
                if (failed.status === 'retry_wait') counts.retried++; else counts.deadLettered++;
            } finally { if (timer) clearTimeout(timer); }
        }
        return counts;
    }
}
