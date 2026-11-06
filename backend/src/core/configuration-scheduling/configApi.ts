import { z } from 'zod';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { readJsonInput } from '@/platform/workspace/requestBody';
import { maskedConfig } from './publicConfig';

const record = z.record(z.string(), z.unknown());
const payloadSchema = z.object({
    runtime: record, schedule: record,
    groups: z.array(z.object({
        chat_id: z.string().trim().min(1),
        members: z.array(z.object({ open_id: z.string().trim().min(1) }).passthrough()).optional(),
    }).passthrough()),
}).strict();

export function createConfigurationApi(getContext: PluginHostServices['getContext'], reload?: PluginHostServices['reloadConfiguration']) {
    return async (request: Request): Promise<Response> => {
        if (request.method === 'GET' || request.method === 'HEAD') return Response.json(maskedConfig(getContext().config));
        if (request.method !== 'POST') return Response.json({ error: '接口不存在' }, { status: 404 });
        if (!reload) return Response.json({ error: '当前宿主不支持配置重载，未保存配置' }, { status: 503 });
        let payload;
        try { payload = payloadSchema.parse(await readJsonInput(request, 1024 * 1024)); }
        catch (error) { return Response.json({ error: '配置请求格式不正确或超过读取限制，未保存配置' }, { status: (error as { status?: number }).status || 400 }); }
        try { await getContext().store.saveDynamicConfig(payload); }
        catch { return Response.json({ error: '配置未能保存，请检查群配置后重试', saved: false }, { status: 500 }); }
        try { await reload(); }
        catch { return Response.json({ error: '配置已保存，但重新加载失败；请核对配置并重试或重启后端', saved: true }, { status: 500 }); }
        return Response.json({ ok: true, message: '配置保存成功', config: maskedConfig(getContext().config) });
    };
}
