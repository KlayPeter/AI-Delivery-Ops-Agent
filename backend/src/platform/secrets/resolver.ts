export interface SecretResolver {
    resolve(reference: string): Promise<string>;
}

export class EnvironmentSecretResolver implements SecretResolver {
    async resolve(reference: string): Promise<string> {
        if (!reference.startsWith('env://')) throw Object.assign(new Error('Only env:// secret references are supported'), { code: 'SECRET_REF_NOT_ALLOWED', retryable: false });
        const name = reference.slice('env://'.length);
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw Object.assign(new Error('Invalid environment secret reference'), { code: 'INVALID_SECRET_REF', retryable: false });
        const value = process.env[name];
        if (!value) throw Object.assign(new Error(`Secret is not configured: ${name}`), { code: 'SECRET_NOT_FOUND', retryable: false });
        return value;
    }
}

export class MapSecretResolver implements SecretResolver {
    constructor(private readonly secrets: Readonly<Record<string, string>>) {}
    async resolve(reference: string): Promise<string> {
        const value = this.secrets[reference];
        if (!value) throw Object.assign(new Error(`Secret is not configured: ${reference}`), { code: 'SECRET_NOT_FOUND', retryable: false });
        return value;
    }
}
