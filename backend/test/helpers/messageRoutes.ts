import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { MessageRouteRegistry } from '@/services/messageHandler/routes';

export function teamMessageRoutes(): MessageRouteRegistry {
    const registry = new MessageRouteRegistry();
    for (const plugin of deliveryTeamPlugins) {
        for (const route of plugin.messageRoutes || []) registry.register(route);
    }
    return registry;
}
