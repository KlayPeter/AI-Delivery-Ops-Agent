import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { AIConfig } from '@/core/config';
import type { ModelGateway, ModelProfile } from './contracts';

export class AiSdkModelGateway implements ModelGateway {
    constructor(private readonly getConfig: () => AIConfig) {}

    resolve(_profile: ModelProfile = 'balanced') {
        const config = this.getConfig();
        if (!config.api_key || !config.model) throw new Error('AI model is not configured');
        if (this.isGemini(config)) {
            const google = createGoogleGenerativeAI({
                apiKey: config.api_key,
                baseURL: config.api_base || undefined,
            });
            return google(config.model);
        }
        const openai = createOpenAI({
            apiKey: config.api_key,
            baseURL: config.api_base || undefined,
        });
        return openai.chat(config.model);
    }

    diagnostics() {
        const config = this.getConfig();
        return { provider: config.provider || (this.isGemini(config) ? 'gemini' : 'openai-compatible'), model: config.model, configured: !!config.api_key && !!config.model };
    }

    private isGemini(config: AIConfig): boolean {
        const provider = (config.provider || '').toLowerCase();
        const model = (config.model || '').toLowerCase();
        const apiBase = (config.api_base || '').toLowerCase();
        return provider.includes('gemini') || model.includes('gemini') || apiBase.includes('generativelanguage.googleapis.com');
    }
}
