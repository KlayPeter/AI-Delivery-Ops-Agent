import type { AppConfig, GroupConfig } from '@/core/config';
import type { PrismaStore } from '@/core/storage';
import type { TapdAdapter } from '@/adapters/tapd';
import type { DashboardArtifact } from '@/models/types';
import { DashboardService } from '@/services/dashboard';
import { ProjectTaskSyncResult, TaskService } from '@/services/taskService';
import type { DashboardImageService } from '@/services/dashboardImage';
import { existsSync } from 'node:fs';

interface ProjectDashboardContext {
    config: AppConfig;
    store: PrismaStore;
    tapd: TapdAdapter;
    dashboard: DashboardService;
    renderer?: DashboardImageService;
}

export interface ProjectDashboardResult {
    artifact: DashboardArtifact;
    sync: ProjectTaskSyncResult;
    subscribers: GroupConfig[];
}

export class ProjectDashboardService {
    constructor(private readonly ctx: ProjectDashboardContext) {}

    subscriberGroups(): GroupConfig[] {
        return (this.ctx.config.groups || []).filter(group =>
            group.schedule?.dashboard_enabled !== false &&
            group.schedule?.module_dashboard_enabled !== false
        );
    }

    async generateFresh(day: Date = new Date(), trigger: "manual" | "scheduled" = "manual", requestedByGroupId?: string): Promise<ProjectDashboardResult> {
        const group = this.ctx.config.groups.find(item => item.chat_id === requestedByGroupId);
        if (!group) throw new Error(`看板目标群不存在：${requestedByGroupId || "未指定"}`);
        const sync = await TaskService.syncProjectScope(this.ctx);
        if (!sync.ok) {
            await this.ctx.store.appendAuditLog?.("dashboard_sync_failed", {
                trigger,
                requested_by_group_id: requestedByGroupId || null,
                error: sync.error || "unknown sync error",
            });
            throw TaskService.projectSyncError("看板数据同步失败", sync);
        }

        const subscribers = [group];
        const artifact = await this.ctx.dashboard.generateForGroup(group, day);
        if (!artifact.image_path && this.ctx.renderer) {
            artifact.image_path = await this.ctx.renderer.render(artifact.html_path);
        }
        await this.ctx.store.appendAuditLog?.("dashboard_generated", {
            trigger,
            requested_by_group_id: requestedByGroupId || null,
            group_id: group.chat_id,
            artifact_id: artifact.id,
            artifact_path: artifact.html_path,
            public_url: artifact.public_url || null,
            sync,
        });
        return { artifact, sync, subscribers };
    }

    async findHistoricalSnapshot(date: string, groupId?: string): Promise<DashboardArtifact | null> {
        const artifacts = await this.ctx.store.listDashboardArtifacts(date);
        const groupKey = String(groupId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
        const artifact = artifacts.find(item => !groupKey || item.id.startsWith(`dashboard-${groupKey}-`)) || null;
        if (!artifact) return null;
        const imagePath = artifact.html_path.replace(/\.html$/i, '.png');
        if (existsSync(imagePath)) artifact.image_path = imagePath;
        return artifact;
    }
}
