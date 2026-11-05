import { AgentHost, type AgentHostExtension, type AgentHostOptions } from '@/platform/bootstrap/agentHost';
import type { HandlerContext } from '@/services/messageHandler/types';
import { deliveryTeamPlugins } from './plugins/builtins';
import { DELIVERY_OPS_CAPABILITY } from './orchestrator/deliveryOpsAgent';

export function createDeliveryOpsHost(
    getContext: () => HandlerContext,
    deliveryPollIntervalMs: number = 1000,
    skillRoot?: string,
    extensions: readonly AgentHostExtension[] = [],
    options: AgentHostOptions = {},
): AgentHost {
    return new AgentHost(getContext, deliveryPollIntervalMs, skillRoot, extensions, {
        ...options,
        plugins: options.plugins ?? deliveryTeamPlugins,
        conversationCapability: options.conversationCapability ?? DELIVERY_OPS_CAPABILITY,
    });
}
