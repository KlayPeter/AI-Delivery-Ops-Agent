import { AgentHost, type AgentHostExtension } from '@/platform/bootstrap/agentHost';
import type { HandlerContext } from '@/services/messageHandler/types';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { deliveryTeamPlugins } from './plugins/builtins';
import { DELIVERY_OPS_CAPABILITY } from './orchestrator/deliveryOpsAgent';

export function createDeliveryOpsHost(
    getContext: () => HandlerContext,
    deliveryPollIntervalMs: number = 1000,
    skillRoot?: string,
    extensions: readonly AgentHostExtension[] = [],
    plugins: readonly FeaturePlugin[] = deliveryTeamPlugins,
): AgentHost {
    return new AgentHost(getContext, deliveryPollIntervalMs, skillRoot, extensions, {
        plugins, conversationCapability: DELIVERY_OPS_CAPABILITY,
    });
}
