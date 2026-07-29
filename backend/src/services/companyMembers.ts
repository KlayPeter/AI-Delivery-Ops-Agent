import { PrismaStore } from "@/core/storage";
import { FeishuAdapter } from "@/adapters/feishu";

export class CompanyMemberService {
    constructor(
        private store: PrismaStore,
        private feishu: FeishuAdapter
    ) {}

    async syncAllMembers(): Promise<{ synced: number, total: number, deactivated: number, group_members_deactivated: number }> {
        const fetched = await this.feishu.fetchAllCompanyMembers();
        if (fetched.length === 0) throw new Error("飞书通讯录返回为空，已保留现有成员状态");

        const currentMembers = await this.store.listCompanyMembers();
        const fetchedIds = new Set(fetched.map(member => member.open_id));
        const departedIds = new Set(
            currentMembers
                .filter(member => member.is_active !== false && !fetchedIds.has(member.open_id))
                .map(member => member.open_id)
        );
        const reconciled = await this.store.reconcileCompanyMembers(fetched);
        const groupMembersDeactivated = await this.deactivateDepartedGroupMembers(departedIds);

        return {
            synced: fetched.length,
            total: fetched.length,
            deactivated: reconciled.deactivated,
            group_members_deactivated: groupMembersDeactivated,
        };
    }

    private async deactivateDepartedGroupMembers(departedIds: Set<string>): Promise<number> {
        if (departedIds.size === 0) return 0;
        const dynamicConfig = await this.store.getDynamicConfig();
        if (!Array.isArray(dynamicConfig?.groups)) return 0;

        let changed = 0;
        const groups = dynamicConfig.groups.map((group: any) => ({
            ...group,
            members: (group.members || []).map((member: any) => {
                if (!departedIds.has(member.open_id) || member.is_active === false) return member;
                changed++;
                return { ...member, is_active: false };
            }),
        }));
        if (changed > 0) await this.store.saveDynamicConfig({ ...dynamicConfig, groups });
        return changed;
    }
}
