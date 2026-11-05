import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { AIConfig } from '@/core/config';
import type { ModelProviderDefinition } from '../registry';

const configured = (config: AIConfig) => Boolean(config.api_key?.trim() && config.model?.trim());
function proxiedFetch(config: AIConfig): typeof fetch | undefined {
    if (!config.use_proxy || !config.proxy_url) return undefined;
    return ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, proxy: config.proxy_url })) as typeof fetch;
}
export const openAIProvider: ModelProviderDefinition = {
    id: 'openai', name: 'OpenAI 兼容接口', isConfigured: configured,
    create: config => createOpenAI({ apiKey: config.api_key, baseURL: config.api_base || undefined, fetch: proxiedFetch(config) }).chat(config.model),
};
export const googleProvider: ModelProviderDefinition = {
    id: 'google', name: 'Google Gemini', isConfigured: configured,
    create: config => createGoogleGenerativeAI({ apiKey: config.api_key, baseURL: config.api_base && !config.api_base.includes('api.openai.com') ? config.api_base : undefined, fetch: proxiedFetch(config) })(config.model),
};
