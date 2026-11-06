import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { createConfigurationApi } from '@/core/configuration-scheduling/configApi';

export const configurationPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.configuration', name: 'Team configuration', version: '1.0.0', description: 'Owns the team configuration page and validated dynamic configuration API.' },
    apply(ctx) {
        ctx.delivery.web.register({ id: 'builtin.configuration',
            pages: [{ path: '/config', label: '定时与团队配置', section: 'team', view: { kind: 'builtin', id: 'team-configuration' } }],
            api: { prefix: '/api/config', routes: [{ method: 'GET', path: '/api/config' }, { method: 'POST', path: '/api/config' }], handle: createConfigurationApi(ctx.delivery.getContext, ctx.delivery.reloadConfiguration) },
        });
    },
};
export default configurationPlugin;
