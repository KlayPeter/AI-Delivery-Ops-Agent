import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { DataRetentionService } from '@/core/dataRetention';
import { zonedClock } from '@/core/scheduleTime';

export const maintenancePlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'platform.maintenance', name: '审计数据保留', version: '1.0.0', description: '按配置保留审计日志与受支持的过期去重记录，不清理 Agent 运行和产物。' },
    schedules: [{
        id: 'maintenance.cleanup', priority: 1300, kind: 'global-tick',
        async run({ ctx, now }) {
            const config = ctx.config?.maintenance;
            if (!config?.enabled || typeof ctx.store.deleteAuditLogsBefore !== 'function') return {};
            const clock = zonedClock(now, config.cleanup_timezone);
            if (!clock || clock.time !== config.cleanup_time) return {};
            const key = `maintenance:cleanup:${clock.date}`;
            const claimed = await ctx.store.claimIdempotencyKey(key, { status: 'running', started_at: now.toISOString() });
            if (!claimed) return {};
            try {
                const result = await new DataRetentionService(ctx.store, config).run(now);
                await ctx.store.setIdempotencyKey(key, { status: 'completed', completed_at: new Date().toISOString(), result });
                await ctx.store.appendAuditLog('maintenance_cleanup_completed', result);
            } catch (error: any) {
                const message = error?.message || String(error);
                await Promise.resolve(ctx.store.setIdempotencyKey(key, { status: 'failed', failed_at: new Date().toISOString(), error: message })).catch(() => {});
                await Promise.resolve(ctx.store.appendAuditLog('maintenance_cleanup_failed', { at: now.toISOString(), error: message })).catch(() => {});
            }
            return {};
        },
    }],
    apply() {},
};
export default maintenancePlugin;
