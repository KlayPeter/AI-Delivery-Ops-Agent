import type { LanguageModel } from 'ai';
import type { AIConfig } from '@/core/config';

export interface ModelProviderDefinition {
    id: string;
    name: string;
    isConfigured(config: AIConfig): boolean;
    create(config: AIConfig): LanguageModel;
}
export function modelProviderId(config: Pick<AIConfig, 'provider' | 'model' | 'api_base'>): string {
    const provider = config.provider?.trim().toLowerCase() || 'openai';
    if (provider === 'ollama') return provider;
    if (['google', 'gemini'].includes(provider)) return 'google';
    if (!['openai', 'openai-compatible', 'deepseek'].includes(provider)) return provider;
    if (config.model?.toLowerCase().includes('gemini') || config.api_base?.toLowerCase().includes('generativelanguage.googleapis.com')) return 'google';
    return 'openai';
}
export class ModelProviderRegistry {
    private readonly providers = new Map<string, ModelProviderDefinition>();
    constructor(providers: readonly ModelProviderDefinition[] = []) { for (const provider of providers) this.register(provider); }
    register(provider: ModelProviderDefinition): () => void {
        if (!/^[a-z][a-z0-9.-]{0,79}$/.test(provider.id) || !provider.name.trim() || provider.name.length > 160 || typeof provider.isConfigured !== 'function' || typeof provider.create !== 'function') throw new Error('Invalid model provider definition');
        if (this.providers.has(provider.id) || this.providers.size >= 30) throw new Error(`Duplicate or excessive model provider: ${provider.id}`);
        const registered = { ...provider }; this.providers.set(provider.id, registered);
        return () => { if (this.providers.get(provider.id) === registered) this.providers.delete(provider.id); };
    }
    list() { return [...this.providers.values()].map(({ id, name }) => ({ id, name })); }
    configured(config: AIConfig): boolean {
        try { return this.providers.get(modelProviderId(config))?.isConfigured(config) === true; } catch { return false; }
    }
    resolve(config: AIConfig): LanguageModel {
        const id = modelProviderId(config), provider = this.providers.get(id);
        if (!provider) throw new Error(`AI model provider is not installed: ${id}`);
        if (!provider.isConfigured(config)) throw new Error(`AI model is not configured for provider: ${id}`);
        return provider.create(config);
    }
}
