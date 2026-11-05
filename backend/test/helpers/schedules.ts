import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { ScheduleRegistry } from '@/platform/scheduling/registry';

export function teamSchedules(): ScheduleRegistry {
    const registry = new ScheduleRegistry();
    for (const plugin of deliveryTeamPlugins) {
        for (const schedule of plugin.schedules || []) registry.register(schedule);
    }
    return registry;
}
