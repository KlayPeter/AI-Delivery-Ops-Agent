import { AppConfig, loadConfig } from "@/core/config";
import { PrismaStore } from "@/core/storage";
import { FeishuAdapter } from "@/adapters/feishu";
import { Member, utcNowIso } from "@/models/types";

export interface GroupMemberSyncResult {
    group_id: string;
    group_name: string;
    before: number;
    after: number;
    added: string[];
    removed: string[];
    changed: boolean;
    skipped?: string;
    error?: string;
}

export function mergeFetchedGroupMembers(existingMembers: Member[] = [], fetchedMembers: any[] = []) {
    const existingById = new Map(
        existingMembers
            .filter(member => member?.open_id)
            .map(member => [member.open_id, member])
    );
    const fetchedById = new Map<string, Member>();

    for (const raw of fetchedMembers) {
        const openId = String(raw?.open_id || raw?.member_id || raw?.user_id || "").trim();
        if (!openId || fetchedById.has(openId)) continue;

        const existing = existingById.get(openId);
        const name = String(raw?.name || raw?.user_name || raw?.en_name || existing?.name || openId).trim();
        const jobTitle = raw?.job_title === undefined
            ? existing?.job_title
            : String(raw.job_title || "").trim() || undefined;
        fetchedById.set(openId, {
            open_id: openId,
            name,
            role: existing?.role,
            job_title: jobTitle,
            is_active: true,
        });
    }

    const fetchedIds = new Set(fetchedById.keys());
    const existingIds = new Set(existingById.keys());
    const added = [...fetchedIds].filter(openId => !existingIds.has(openId));
    const removed = [...existingIds].filter(openId => !fetchedIds.has(openId));
    const members = [...fetchedById.values()];
    const changed =
        added.length > 0 ||
        removed.length > 0 ||
        members.some(member => {
            const existing = existingById.get(member.open_id);
            return !existing || existing.name !== member.name || existing.job_title !== member.job_title || existing.is_active === false;
        });

    return { members, added, removed, changed };
}

export class GroupMemberSyncService {
    constructor(
        private store: PrismaStore,
        private feishu: FeishuAdapter
    ) {}

    async syncAll(trigger: string = "manual"): Promise<{ changed: boolean; results: GroupMemberSyncResult[] }> {
        const dynamicConfig = await this.store.getDynamicConfig();
        const currentConfig = loadConfig(dynamicConfig);
        const result = await this.syncConfig(currentConfig, dynamicConfig);
        const hasError = result.results.some(r => r.error);

        if (result.changed || trigger !== "scheduler") {
            await this.store.appendAuditLog("group_members_sync", {
                trigger,
                changed: result.changed,
                synced_at: utcNowIso(),
                results: result.results,
            });
        }

        return result;
    }

    async syncGroup(chatId: string, trigger: string = "manual"): Promise<{ changed: boolean; results: GroupMemberSyncResult[] }> {
        const dynamicConfig = await this.store.getDynamicConfig();
        const currentConfig = loadConfig(dynamicConfig);
        const filteredGroups = currentConfig.groups.filter(group => group.chat_id === chatId);
        if (filteredGroups.length === 0) {
            return {
                changed: false,
                results: [{
                    group_id: chatId,
                    group_name: chatId,
                    before: 0,
                    after: 0,
                    added: [],
                    removed: [],
                    changed: false,
                    skipped: "group_not_configured",
                }],
            };
        }

        const scopedConfig: AppConfig = { ...currentConfig, groups: filteredGroups };
        const result = await this.syncConfig(scopedConfig, dynamicConfig);
        const hasError = result.results.some(r => r.error);

        if (result.changed || trigger !== "scheduler") {
            await this.store.appendAuditLog("group_members_sync", {
                trigger,
                changed: result.changed,
                synced_at: utcNowIso(),
                results: result.results,
            });
        }
        return result;
    }

    private async syncConfig(currentConfig: AppConfig, dynamicConfig: any): Promise<{ changed: boolean; results: GroupMemberSyncResult[] }> {
        const configuredGroups = Array.isArray(dynamicConfig.groups) ? dynamicConfig.groups : currentConfig.groups;
        const syncGroupIds = new Set(currentConfig.groups.map(group => group.chat_id));
        const nextGroups = configuredGroups.map((group: any) => ({ ...group, members: [...(group.members || [])] }));
        const results: GroupMemberSyncResult[] = [];
        let changed = false;

        for (const group of currentConfig.groups) {
            if (!group.chat_id) continue;
            const groupIndex = nextGroups.findIndex((item: any) => item.chat_id === group.chat_id);
            if (groupIndex < 0 || !syncGroupIds.has(group.chat_id)) continue;

            try {
                const fetchedMembers = await this.feishu.listGroupMembers(group.chat_id);
                if (fetchedMembers.length === 0 && group.members.length > 0) {
                    results.push({
                        group_id: group.chat_id,
                        group_name: group.name,
                        before: group.members.length,
                        after: group.members.length,
                        added: [],
                        removed: [],
                        changed: false,
                        skipped: "empty_feishu_response",
                    });
                    continue;
                }

                const merged = mergeFetchedGroupMembers(group.members, fetchedMembers);
                if (merged.changed) {
                    nextGroups[groupIndex].members = merged.members;
                    changed = true;
                }

                results.push({
                    group_id: group.chat_id,
                    group_name: group.name,
                    before: group.members.length,
                    after: merged.members.length,
                    added: merged.added,
                    removed: merged.removed,
                    changed: merged.changed,
                });
            } catch (error: any) {
                results.push({
                    group_id: group.chat_id,
                    group_name: group.name,
                    before: group.members.length,
                    after: group.members.length,
                    added: [],
                    removed: [],
                    changed: false,
                    error: error?.message || String(error),
                });
            }
        }

        if (changed) {
            await this.store.saveDynamicConfig({ ...dynamicConfig, groups: nextGroups });
        }

        return { changed, results };
    }
}
