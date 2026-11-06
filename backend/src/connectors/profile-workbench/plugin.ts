import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { readSmallJsonBody } from '@/platform/workspace/request';
import { composeProfiles, CompositionError, exportSetupProfile } from './compose';

export const profileWorkbenchPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'plugins.compose', name: '插件接入与组合', version: '1.1.0', description: '选择 Skill/OpenAPI 接入助手，或组合已审查的插件配置，保留个人工作台。' },
    apply(ctx) {
        ctx.delivery.web.register({ id: 'plugins.compose', pages: [{ path: '/plugin-profiles', label: '接入与组合', section: 'workspace', navigation: false, view: { kind: 'builtin', id: 'profile-composer' } }],
            api: { prefix: '/api/plugin-profiles', routes: [{ method: 'POST', path: '/api/plugin-profiles/compose' }, { method: 'POST', path: '/api/plugin-profiles/setup' }], async handle(request) {
                const pathname = new URL(request.url).pathname, setup = pathname === '/api/plugin-profiles/setup';
                if (request.method !== 'POST' || ![ '/api/plugin-profiles/compose', '/api/plugin-profiles/setup' ].includes(pathname)) return Response.json({ error: '接口不存在' }, { status: 404 });
                try { return Response.json(setup ? exportSetupProfile(await readSmallJsonBody(request)) : composeProfiles(await readSmallJsonBody(request, 3 * 1024 * 1024))); }
                catch (error) { return Response.json({ error: error instanceof CompositionError ? error.message : setup ? '请选择 GitHub Skill 或 OpenAPI 接入助手，至少一项；不接受其他插件或配置。' : '请使用本应用已审查导出的有效 YAML；最多三份、总量 1 MiB，Skill/授权/来源必须完整。' }, { status: 400 }); }
            } },
        });
    },
};
export default profileWorkbenchPlugin;
