import type { DeliveryAdapter, DeliveryRecord } from '@/platform/delivery/contracts';

export interface TransportHealth {
    requiredBotInstanceIds: string[];
    connections: Array<{ botInstanceId: string; state: string; reconnectAttempts: number }>;
}

export interface TransportContribution {
    id: string;
    delivery: DeliveryAdapter;
    start(): Promise<void>;
    stopIngress(): Promise<void>;
    stop(): Promise<void>;
    health?(): TransportHealth;
}

export class TransportRegistry implements DeliveryAdapter {
    // shortcut: one transport matches the current Feishu Bot contract; add routing when supporting another BotPlatform.
    private entry?: TransportContribution;

    register(transport: TransportContribution): () => void {
        if (!/^[a-z][a-z0-9.-]*$/.test(transport.id) || typeof transport.delivery?.deliver !== 'function'
            || (['start', 'stopIngress', 'stop'] as const).some(key => typeof transport[key] !== 'function')
            || (transport.health !== undefined && typeof transport.health !== 'function')) throw new Error('Invalid transport contribution');
        if (this.entry) throw new Error('Only one active transport is supported');
        const entry = Object.freeze({ id: transport.id, delivery: transport.delivery,
            start: transport.start.bind(transport), stopIngress: transport.stopIngress.bind(transport),
            stop: transport.stop.bind(transport), health: transport.health?.bind(transport),
        });
        this.entry = entry;
        return () => { if (this.entry === entry) this.entry = undefined; };
    }

    get available(): boolean { return !!this.entry; }
    async start(): Promise<void> { await this.entry?.start(); }
    async stopIngress(): Promise<void> { await this.entry?.stopIngress(); }
    async stop(): Promise<void> { await this.entry?.stop(); }
    health(): TransportHealth { return structuredClone(this.entry?.health?.() || { requiredBotInstanceIds: [], connections: [] }); }

    deliver(record: DeliveryRecord, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
        if (!this.entry) return Promise.reject(Object.assign(new Error('Delivery transport is not installed'), { code: 'TRANSPORT_UNAVAILABLE', retryable: true }));
        return this.entry.delivery.deliver(record, signal);
    }
}
