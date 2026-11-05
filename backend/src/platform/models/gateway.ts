import type { AIConfig } from '@/core/config';
import type { ModelGateway, ModelProfile } from './contracts';
import { ModelProviderRegistry, modelProviderId } from './registry';
import { standardModelProviders } from './providers';

export class AiSdkModelGateway implements ModelGateway {
    constructor(private readonly getConfig: () => AIConfig, private readonly providers = new ModelProviderRegistry(standardModelProviders)) {}
    resolve(_profile: ModelProfile = 'balanced') { return this.providers.resolve(this.getConfig()); }
    diagnostics() {
        const config = this.getConfig();
        return { provider: modelProviderId(config), model: config.model, configured: this.providers.configured(config) };
    }
}
