import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { readSmallJsonBody } from '@/platform/workspace/request';
import { composeProfiles, CompositionError, exportSetupProfile } from './compose';
import { z } from 'zod';
import { ProfileConflict, SavedPluginProfiles } from './saved';

export const profileWorkbenchPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'plugins.compose', name: '插件接入与组合', version: '1.3.0', description: '启用接入助手，并保存应用已审查的个人插件组合。' },
    Config: z.object({ appliedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), externalFile: z.boolean().optional() }).strict(),
    apply(ctx, config) {
        const saved = new SavedPluginProfiles(ctx.delivery.getContext().config.data_path, typeof config.appliedRevision === 'string' ? config.appliedRevision : null, config.externalFile === true || Boolean(process.env.AGENT_PLUGINS_FILE));
        ctx.delivery.web.register({ id: 'plugins.compose', pages: [{ path: '/plugin-profiles', label: '接入与组合', section: 'workspace', navigation: false, view: { kind: 'builtin', id: 'profile-composer' } }],
            api: { prefix: '/api/plugin-profiles', routes: [{ method: 'POST', path: '/api/plugin-profiles/compose' }, { method: 'POST', path: '/api/plugin-profiles/setup' }, { method: 'GET', path: '/api/plugin-profiles/saved' }, { method: 'POST', path: '/api/plugin-profiles/save' }, { method: 'POST', path: '/api/plugin-profiles/activation' }], async handle(request) {
                const pathname = new URL(request.url).pathname, setup = pathname === '/api/plugin-profiles/setup';
                try {
                    if (request.method === 'GET' && pathname === '/api/plugin-profiles/saved') return Response.json(await saved.snapshot());
                    if (request.method !== 'POST') return Response.json({ error: '接口不存在' }, { status: 404 });
                    if (pathname === '/api/plugin-profiles/save') return Response.json(await saved.save(await readSmallJsonBody(request, 3 * 1024 * 1024)));
                    if (pathname === '/api/plugin-profiles/activation') return Response.json(await saved.activate(await readSmallJsonBody(request)));
                    if (!['/api/plugin-profiles/setup', '/api/plugin-profiles/compose'].includes(pathname)) return Response.json({ error: '接口不存在' }, { status: 404 });
                    return Response.json(setup ? exportSetupProfile(await readSmallJsonBody(request)) : composeProfiles(await readSmallJsonBody(request, 3 * 1024 * 1024)));
                } catch (error) { return Response.json({ error: error instanceof CompositionError || error instanceof ProfileConflict ? error.message : setup ? '请选择 GitHub Skill 或 OpenAPI 接入助手，至少一项；不接受其他插件或配置。' : '请使用本应用已审查导出的有效 YAML；最多三份、总量 1 MiB，Skill/授权/来源必须完整。' }, { status: error instanceof ProfileConflict ? 409 : 400 }); }
            } },
        });
    },
};
export default profileWorkbenchPlugin;
