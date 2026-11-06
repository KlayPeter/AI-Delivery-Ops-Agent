import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { loadConfig } from '@/core/config';
import { createDirectoryApi } from '@/core/configuration-scheduling/api';
import { GroupMemberSyncService } from '@/services/groupMembers';
import { utcNowIso } from '@/models/types';

export const directoryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.directory', name: 'Team directory', version: '1.0.0', description: 'Owns Feishu directory APIs and low-frequency group membership sync.' },
    schedules: [{
        id: 'directory.members-sync', kind: 'global-poll', priority: 1200,
        async run({ ctx }) {
            try {
                const result = await new GroupMemberSyncService(ctx.store, ctx.feishu).syncAll('scheduler');
                if (result.changed) ctx.config = loadConfig(await ctx.store.getDynamicConfig());
            } catch (error: any) {
                await ctx.store.appendAuditLog('group_members_sync_failed', { trigger: 'scheduler', at: utcNowIso(), error: error?.message || String(error) });
            }
            return {};
        },
    }],
    apply(ctx) {
        const api = createDirectoryApi(ctx.delivery.getContext, ctx.delivery.reloadConfiguration);
        ctx.delivery.web.register({ id: 'builtin.directory', api: {
            prefix: '/api/feishu', routes: [
                { method: 'GET', path: '/api/feishu/groups' },
                { method: 'GET', path: '/api/feishu/groups/:chatId/members' },
                { method: 'POST', path: '/api/feishu/groups/:chatId/members/sync' },
                { method: 'POST', path: '/api/feishu/company-members/sync' },
                { method: 'GET', path: '/api/feishu/company-members' },
            ], handle: request => api.handle(request),
        } });
    },
};
