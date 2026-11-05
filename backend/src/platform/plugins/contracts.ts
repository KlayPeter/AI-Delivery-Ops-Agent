import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { AgentRegistry } from '@/platform/agents/registry';
import type { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import type { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';
import type { PersistentBotControlCatalog } from '@/platform/bots/catalog';
import type { BotRegistry } from '@/platform/bots/registry';
import type { ToolRegistry } from '@/platform/tools/registry';
import type { SkillRegistry } from '@/platform/skills/registry';
import type { HandlerContext } from '@/services/messageHandler/types';
import type { MessageRoute, MessageRouteRegistry } from '@/services/messageHandler/routes';

export interface PluginManifest {
    apiVersion: '1.0';
    id: string;
    name: string;
    version: string;
    description: string;
    requires?: readonly string[];
}

export interface PluginAgent {
    manifest: AgentManifest;
    installationId: string;
}

export interface PluginHostServices {
    getContext: () => HandlerContext;
    agents: AgentRegistry;
    nativeAgents: Pick<NativeAgentAdapter, 'register'>;
    modelAgents: Pick<ModelLoopAgentAdapter, 'register'>;
    tools: Pick<ToolRegistry, 'register'>;
    skills: Pick<SkillRegistry, 'register'>;
    messageRoutes: Pick<MessageRouteRegistry, 'register'>;
    bots: BotRegistry;
    botCatalog: PersistentBotControlCatalog;
    skillRoot: string;
}

export interface FeaturePlugin {
    manifest: PluginManifest;
    agents?: readonly PluginAgent[];
    skillPackages?: readonly string[];
    messageRoutes?: readonly MessageRoute[];
    Config?: Plugin.Object<Record<string, unknown>>['Config'];
    apply: (ctx: Context, config: Record<string, unknown>) => void | Promise<void>;
}

declare module '@deepseek-ai/cordis' {
    interface Context { delivery: PluginHostServices }
    interface Events { 'delivery/restored'(): void | Promise<void> }
}
