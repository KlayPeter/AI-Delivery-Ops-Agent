import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { ModelProviderDefinition } from '../registry';
import { openAIProvider, googleProvider } from './cloud';
import { ollamaProvider } from './ollama';
export const standardModelProviders = [openAIProvider, googleProvider, ollamaProvider] as const;
export function modelProviderPlugin(provider: ModelProviderDefinition): FeaturePlugin {
    return { manifest: { apiVersion: '1.0', id: `model.${provider.id}`, name: provider.name, version: '1.0.0', description: `通过宿主模型网关提供 ${provider.name}，注册随插件生命周期释放。` }, apply(ctx) {
        if (!ctx.delivery.modelProviders) throw new Error('Host does not support model provider plugins');
        ctx.delivery.modelProviders.register(provider);
    } };
}
export const openAIModelPlugin = modelProviderPlugin(openAIProvider);
export const googleModelPlugin = modelProviderPlugin(googleProvider);
export const ollamaModelPlugin = modelProviderPlugin(ollamaProvider);
export const standardModelPlugins = [openAIModelPlugin, googleModelPlugin, ollamaModelPlugin] as const;
