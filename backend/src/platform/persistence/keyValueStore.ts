export interface PersistentKeyValueStore {
    claimIdempotencyKey(key: string, value: unknown): Promise<boolean>;
    setIdempotencyKey(key: string, value: unknown): Promise<void>;
    getIdempotencyValue<T = unknown>(key: string): Promise<T | null>;
    listIdempotencyEntries<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>>;
    compareAndSetIdempotencyKey(key: string, expected: unknown, next: unknown): Promise<boolean>;
}

export class InMemoryPersistentKeyValueStore implements PersistentKeyValueStore {
    private readonly values = new Map<string, string>();

    async claimIdempotencyKey(key: string, value: unknown): Promise<boolean> {
        if (this.values.has(key)) return false;
        this.values.set(key, JSON.stringify(value));
        return true;
    }

    async setIdempotencyKey(key: string, value: unknown): Promise<void> {
        this.values.set(key, JSON.stringify(value));
    }

    async getIdempotencyValue<T = unknown>(key: string): Promise<T | null> {
        const value = this.values.get(key);
        return value === undefined ? null : JSON.parse(value) as T;
    }

    async listIdempotencyEntries<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>> {
        return Array.from(this.values.entries())
            .filter(([key]) => key.startsWith(prefix))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => ({ key, value: JSON.parse(value) as T }));
    }

    async compareAndSetIdempotencyKey(key: string, expected: unknown, next: unknown): Promise<boolean> {
        if (this.values.get(key) !== JSON.stringify(expected)) return false;
        this.values.set(key, JSON.stringify(next));
        return true;
    }
}
