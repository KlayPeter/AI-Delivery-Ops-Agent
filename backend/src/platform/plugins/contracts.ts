import type { AgentHost } from '@/platform/bootstrap/agentHost';
import type { TransportRegistry } from '@/platform/transports/registry';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { ExternalAgentInstallOptions, ExternalAgentPackage } from '@/platform/agents/externalInstaller';
import type { AgentRegistry } from '@/platform/agents/registry';
import type { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import type { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';
import type { PersistentBotControlCatalog } from '@/platform/bots/catalog';
import type { BotRegistry } from '@/platform/bots/registry';
import type { ToolRegistry } from '@/platform/tools/registry';
import type { SkillRuntime } from '@/platform/skills/runtime';
import type { SkillRegistry } from '@/platform/skills/registry';
import type { HandlerContext } from '@/services/messageHandler/types';
import type { MessageRoute, MessageRouteRegistry } from '@/services/messageHandler/routes';
import type { GroupSchedule, ScheduleRegistry } from '@/platform/scheduling/registry';
import type { OrchestratorAdapter } from '@/platform/models/contracts';
import type { ModelProviderRegistry } from '@/platform/models/registry';
import type { ToolGateway } from '@/platform/tools/gateway';
import type { RunActionRegistry } from './runActions';
import type { PluginWebRegistry } from './web';
import type { RunCheckDefinition, RunCheckRegistry } from './checks';

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
    dispatchBotMessage?: AgentHost['dispatchBotMessage'];
    canDispatch?: (capability: string) => boolean;
    reloadConfiguration?: () => Promise<void>;
    installExternal?: (manifest: AgentManifest, options: ExternalAgentInstallOptions) => Promise<ExternalAgentPackage>;
    transports?: Pick<TransportRegistry, 'register'>;
    modelProviders?: Pick<ModelProviderRegistry, 'register' | 'configured' | 'resolve'>;
    runLocal?: (capability: string, input: unknown, triggerId: string, expected?: { installationId: string; manifestHash: string }) => Promise<{ runId?: string; status: string; error?: { code?: string; message: string } }>;
    runScheduledLocal?: PluginHostServices['runLocal'];
    agents: AgentRegistry;
    nativeAgents: Pick<NativeAgentAdapter, 'register'>;
    modelAgents: Pick<ModelLoopAgentAdapter, 'register'>;
    tools: Pick<ToolRegistry, 'register' | 'list'>;
    skills: Pick<SkillRegistry, 'register'> & { execute?: SkillRuntime['execute'] };
    messageRoutes: Pick<MessageRouteRegistry, 'register' | 'registerBotEntry'>;
    schedules: Pick<ScheduleRegistry, 'register'>;
    runActions: Pick<RunActionRegistry, 'register'>;
    web: Pick<PluginWebRegistry, 'register'>;
    checks: RunCheckRegistry;
    orchestrator: OrchestratorAdapter;
    toolGateway: Pick<ToolGateway, 'execute'>;
    bots: BotRegistry;
    botCatalog: PersistentBotControlCatalog;
    skillRoot: string;
}

export interface FeaturePlugin {
    manifest: PluginManifest;
    agents?: readonly PluginAgent[];
    skillPackages?: readonly string[];
    messageRoutes?: readonly MessageRoute[];
    schedules?: readonly GroupSchedule[];
    checks?: readonly RunCheckDefinition[];
    Config?: Plugin.Object<Record<string, unknown>>['Config'];
    apply: (ctx: Context, config: Record<string, unknown>) => void | Promise<void>;
}

declare module '@deepseek-ai/cordis' {
    interface Context { delivery: PluginHostServices }
    interface Events { 'delivery/restored'(): void | Promise<void> }
}
