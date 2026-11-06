import { Elysia } from 'elysia';
import type { HandlerContext } from '@/services/messageHandler/types';
import { GroupMemberSyncService } from '@/services/groupMembers';
import { CompanyMemberService } from '@/services/companyMembers';
import { isLocalWorkspaceRequest } from '@/platform/workspace/connections';
import { maskedConfig } from './publicConfig';

export function createDirectoryApi(getContext: () => HandlerContext, reloadConfiguration?: () => Promise<void>) {
    return new Elysia({ prefix: '/api/feishu', name: 'team-directory' })
        .onBeforeHandle(({ request, set }) => {
            if (!isLocalWorkspaceRequest(request)) { set.status = 403; return { error: '通讯录 API 仅接受本机页面请求' }; }
            if (request.method === 'POST' && !reloadConfiguration) { set.status = 503; return { error: '宿主未提供配置重载，未执行通讯录同步' }; }
        })
        .get('/groups', async ({ set }) => {
            try {
                const groups = await getContext().feishu.listGroups();
                return { groups };
            } catch (e: any) {
                set.status = 500;
                return { error: e.message || String(e) };
            }
        })
        .get('/groups/:chatId/members', async ({ params: { chatId }, set }) => {
            try {
                const members = await getContext().feishu.listGroupMembers(chatId);
                return { members };
            } catch (e: any) {
                set.status = 500;
                return { error: e.message || String(e) };
            }
        })
        .post('/groups/:chatId/members/sync', async ({ params: { chatId }, set }) => {
            try {
                const syncer = new GroupMemberSyncService(getContext().store, getContext().feishu);
                const result = await syncer.syncGroup(chatId, "manual");
                if (result.changed) await reloadConfiguration!();
                return { ok: true, result, config: maskedConfig(getContext().config) };
            } catch (e: any) {
                set.status = 500;
                return { error: '同步群成员失败', details: e.message || String(e) };
            }
        })
        .post('/company-members/sync', async ({ set }) => {
            try {
                const syncer = new CompanyMemberService(getContext().store, getContext().feishu);
                const result = await syncer.syncAllMembers();
                if (result.group_members_deactivated > 0) await reloadConfiguration!();
                return { ok: true, result };
            } catch (e: any) {
                set.status = 500;
                return { error: '同步公司成员失败', details: e.message || String(e) };
            }
        })
        .get('/company-members', async ({ set }) => {
            try {
                const members = await getContext().store.listCompanyMembers();
                return { members };
            } catch (e: any) {
                set.status = 500;
                return { error: '获取公司成员失败', details: e.message || String(e) };
            }
        });
}
