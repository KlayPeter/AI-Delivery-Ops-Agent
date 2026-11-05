import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { readSmallJsonBody } from '@/platform/workspace/request';
import { composeProfiles, CompositionError } from './compose';

export const profileWorkbenchPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'plugins.compose', name: '插件组合', version: '1.0.0', description: '校验已审查的 Skill、MCP、OpenAPI 导出文件，生成保留个人工作台的组合配置。' },
    apply(ctx) {
        ctx.delivery.web.register({ id: 'plugins.compose', pages: [{ path: '/plugin-profiles', label: '组合插件', section: 'workspace', navigation: false, view: { kind: 'builtin', id: 'profile-composer' } }],
            api: { prefix: '/api/plugin-profiles', routes: [{ method: 'POST', path: '/api/plugin-profiles/compose' }], async handle(request) {
                if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/plugin-profiles/compose') return Response.json({ error: '接口不存在' }, { status: 404 });
                try { return Response.json(composeProfiles(await readSmallJsonBody(request, 3 * 1024 * 1024))); }
                catch (error) { return Response.json({ error: error instanceof CompositionError ? error.message : '请使用本应用已审查导出的有效 YAML；最多三份、总量 1 MiB，Skill/授权/来源必须完整。' }, { status: 400 }); }
            } },
        });
    },
};
export default profileWorkbenchPlugin;
