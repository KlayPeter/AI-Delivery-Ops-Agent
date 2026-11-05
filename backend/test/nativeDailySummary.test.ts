import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { FeishuDeliveryAdapter } from '@/platform/delivery/feishuAdapter';
import { ScheduledJobs } from '@/services/jobs';
import { TaskService } from '@/services/taskService';
import { dailySummaryManifest } from '@/agents/native/dailySummaryAgent';
import { dashboardManifest } from '@/agents/native/dashboardAgent';

const config: any = {
    groups: [{ chat_id: 'oc_daily', name: '研发群', daily_summary_period: '00:00-23:59', members: [] }],
    runtime: {}, schedule: {}, project: { name: 'project' },
};

afterEach(() => { (TaskService.syncProjectScope as any).mockRestore?.(); });

function jobs() {
    const sent: any[] = []; const saved: any[] = [];
    const store: any = {
        listSourceMessages: async (): Promise<any[]> => [], listTasks: async (): Promise<any[]> => [], listTaskUpdates: async (): Promise<any[]> => [],
        saveDailySummary: async (summary: any) => saved.push(summary), appendAuditLog: async () => {},
    };
    const feishu: any = { sendGroupMarkdown: async (...args: any[]) => { sent.push(args); return { ok: true, message_id: 'om_daily' }; } };
    const instance = new ScheduledJobs(config, store, feishu, {} as any, {} as any);
    (instance as any).backfillGroupMessagesForSummary = async () => {};
    return { instance, sent, saved };
}

describe('Native Daily Summary Agent boundary', () => {
    test('generation persists a summary and returns an Artifact without direct delivery', async () => {
        spyOn(TaskService, 'syncProjectScope').mockResolvedValue({ ok: true } as any);
        const { instance, sent, saved } = jobs();
        const generated = await instance.generateDailySummary('oc_daily', new Date('2026-07-14T10:00:00+08:00'));
        expect(saved).toHaveLength(1); expect(sent).toHaveLength(0);
        expect(generated.summaryIds).toEqual(['summary-oc_daily-2026-07-14']);
        expect(generated.artifacts[0]).toMatchObject({ type: 'markdown', metadata: { targetId: 'oc_daily', summaryId: 'summary-oc_daily-2026-07-14' } });
        expect(dailySummaryManifest.delivery.directDelivery).toBe(false);
    });

    test('legacy entry delegates to generation and preserves direct-send behavior', async () => {
        spyOn(TaskService, 'syncProjectScope').mockResolvedValue({ ok: true } as any);
        const { instance, sent } = jobs();
        expect(await instance.dailySummary('oc_daily', new Date('2026-07-14T10:00:00+08:00'))).toEqual({ summary_ids: 'summary-oc_daily-2026-07-14' });
        expect(sent).toHaveLength(1);
    });
});

describe('Feishu Delivery Adapter', () => {
    test('delivers a host-controlled markdown Artifact and returns a receipt', async () => {
        const calls: any[] = [];
        const adapter = new FeishuDeliveryAdapter({ sendGroupMarkdown: async (...args: any[]) => { calls.push(args); return { ok: true, raw: {}, message_id: 'om_1', chat_id: 'oc_daily' }; } } as any);
        const controller = new AbortController();
        const receipt = await adapter.deliver({
            id: 'delivery-1', deliveryKey: 'key', status: 'sending', attempts: 1, maxAttempts: 3, createdAt: '', updatedAt: '',
            artifact: { id: 'artifact-1', runId: 'run-1', type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: 'summary', metadata: { title: '日报' }, createdAt: '' },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_daily' },
        }, controller.signal);
        expect(calls[0]).toEqual(['summary', 'oc_daily', '日报', controller.signal]); expect(receipt).toEqual({ messageId: 'om_1', chatId: 'oc_daily' });
    });

    test('rejects unsupported artifacts permanently', async () => {
        const adapter = new FeishuDeliveryAdapter({} as any);
        await expect(adapter.deliver({
            id: 'delivery-1', deliveryKey: 'key', status: 'sending', attempts: 1, maxAttempts: 3, createdAt: '', updatedAt: '',
            artifact: { id: 'artifact-1', runId: 'run-1', type: 'json', mediaType: 'application/json', schemaVersion: '1.0', content: '{}', metadata: {}, createdAt: '' },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_daily' },
        }, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', retryable: false });
    });

    test('uploads and sends an image Artifact through the host bot', async () => {
        const calls: string[] = [];
        const adapter = new FeishuDeliveryAdapter({
            uploadImage: async (path: string) => { calls.push(`upload:${path}`); return { ok: true, image_key: 'img_1' }; },
            sendGroupImageKey: async (key: string, chatId: string) => { calls.push(`send:${key}:${chatId}`); return { ok: true, message_id: 'om_image', chat_id: chatId }; },
        } as any);
        const receipt = await adapter.deliver({
            id: 'delivery-image', deliveryKey: 'image-key', status: 'sending', attempts: 1, maxAttempts: 3, createdAt: '', updatedAt: '',
            artifact: { id: 'artifact-image', runId: 'run-1', type: 'image', mediaType: 'image/png', schemaVersion: '1.0', storageRef: '/tmp/dashboard.png', metadata: {}, createdAt: '' },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_daily' },
        }, new AbortController().signal);
        expect(calls).toEqual(['upload:/tmp/dashboard.png', 'send:img_1:oc_daily']);
        expect(receipt).toEqual({ messageId: 'om_image', chatId: 'oc_daily', imageKey: 'img_1' });
        expect(dashboardManifest.delivery.directDelivery).toBe(false);
    });

    test('renders an AI article list while rejecting unsafe links', async () => {
        const sent: string[] = [];
        const adapter = new FeishuDeliveryAdapter({ sendGroupMarkdown: async (text: string) => { sent.push(text); return { ok: true }; } } as any);
        const record: any = {
            id: 'delivery-articles', deliveryKey: 'articles', status: 'sending', attempts: 1, maxAttempts: 3, createdAt: '', updatedAt: '',
            artifact: { id: 'artifact-articles', runId: 'run-1', type: 'article_list', mediaType: 'application/json', schemaVersion: '1.0', content: [{ title: 'Agent 架构', url: 'https://example.com/agent', summary: '插件化设计。' }], metadata: {}, createdAt: '' },
            target: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', channel: 'group', targetId: 'oc_daily' },
        };
        await adapter.deliver(record, new AbortController().signal);
        expect(sent[0]).toContain('[Agent 架构](https://example.com/agent)');
        record.artifact.content = [{ title: 'bad', url: 'javascript:alert(1)' }];
        await expect(adapter.deliver(record, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARTICLE_LIST', retryable: false });
    });
});
