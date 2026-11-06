import { z } from 'zod';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { readJsonInput } from '@/platform/workspace/requestBody';
import { createAiHotAgentPackage } from './aiHotAgent';

const inputSchema = z.object({
    endpoint: z.string().url().max(2048), apiTokenRef: z.string().regex(/^env:\/\/[A-Z][A-Z0-9_]*$/).max(256).optional(),
    workspaceId: z.string().trim().min(1).max(200).optional(), botInstanceId: z.string().trim().min(1).max(200).optional(),
    priority: z.number().finite().optional(),
}).strict();

export function createAiHotInstallHandler(install: PluginHostServices['installExternal']) {
    return async (request: Request): Promise<Response> => {
        if (!install) return Response.json({ error: '宿主未提供外部 Agent 安装服务' }, { status: 503 });
        let agentPackage;
        try {
            const input = inputSchema.parse(await readJsonInput(request, 16 * 1024));
            agentPackage = createAiHotAgentPackage({ ...input, workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID, botInstanceId: input.botInstanceId || DEFAULT_BOT_INSTANCE_ID });
        } catch (error: any) {
            return Response.json({ error: '安装参数无效；请提供不含凭据的 HTTPS 地址和可选 env:// 密钥引用' }, { status: error.status || 400 });
        }
        try {
            const saved = await install(agentPackage.manifest, {
                workspaceId: agentPackage.installation.workspaceId, botInstanceId: agentPackage.binding.botInstanceId,
                installationId: agentPackage.installation.id, bindingId: agentPackage.binding.id,
                config: agentPackage.installation.config, secretRefs: agentPackage.installation.secretRefs, priority: agentPackage.binding.priority,
            });
            return Response.json({ ok: true, agent: { agentId: saved.manifest.id, installationId: saved.installation.id, capabilities: saved.manifest.capabilities } });
        } catch {
            return Response.json({ error: '外部 Agent 安装失败，请检查目标机器人、工作区和既有安装契约' }, { status: 500 });
        }
    };
}
