import { describe, expect, test } from 'bun:test';
import { CompanyMemberService } from '@/services/companyMembers';

describe('CompanyMemberService', () => {
    test('deactivates people missing from a successful company directory snapshot and their group memberships', async () => {
        const savedConfigs: any[] = [];
        const store: any = {
            listCompanyMembers: async () => [
                { open_id: 'ou_active', name: '在职同学', is_active: true },
                { open_id: 'ou_departed', name: '离职同学', is_active: true },
            ],
            reconcileCompanyMembers: async (members: any[]) => {
                expect(members.map(member => member.open_id)).toEqual(['ou_active']);
                return { deactivated: 1 };
            },
            getDynamicConfig: async () => ({
                groups: [{
                    chat_id: 'oc_delivery',
                    name: '交付群',
                    members: [
                        { open_id: 'ou_active', name: '在职同学', is_active: true },
                        { open_id: 'ou_departed', name: '离职同学', is_active: true },
                    ],
                }],
            }),
            saveDynamicConfig: async (config: any) => savedConfigs.push(config),
        };
        const feishu: any = {
            fetchAllCompanyMembers: async () => [{ open_id: 'ou_active', name: '在职同学', department: '研发部' }],
        };

        const result = await new CompanyMemberService(store, feishu).syncAllMembers();

        expect(result).toMatchObject({ synced: 1, deactivated: 1, group_members_deactivated: 1 });
        expect(savedConfigs[0].groups[0].members).toContainEqual(expect.objectContaining({ open_id: 'ou_departed', is_active: false }));
    });

    test('keeps existing records untouched when the directory snapshot is empty', async () => {
        const store: any = {
            listCompanyMembers: async (): Promise<any[]> => [],
            reconcileCompanyMembers: async (): Promise<never> => { throw new Error('should not reconcile'); },
        };
        const feishu: any = { fetchAllCompanyMembers: async (): Promise<any[]> => [] };

        await expect(new CompanyMemberService(store, feishu).syncAllMembers()).rejects.toThrow('返回为空');
    });
});
