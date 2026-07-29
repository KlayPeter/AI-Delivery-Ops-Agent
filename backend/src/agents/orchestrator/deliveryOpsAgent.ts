import { STANDUP_AGENT_CAPABILITY } from '@/agents/domain/standupAgent';
import { TASK_AGENT_CAPABILITY } from '@/agents/domain/taskAgent';
import { DAILY_SUMMARY_CAPABILITY } from '@/agents/native/dailySummaryAgent';
import { DASHBOARD_CAPABILITY } from '@/agents/native/dashboardAgent';
import { AI_HOT_CAPABILITY } from '@/agents/external/aiHotAgent';
import { WEEKLY_REPORT_CAPABILITY } from '@/agents/native/weeklyReportAgent';
import type { AgentManifest } from '@/platform/agents/contracts';
import type { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';

export const DELIVERY_OPS_AGENT_ID = 'built-in.delivery-ops-agent';
export const DELIVERY_OPS_CAPABILITY = 'delivery.ops.orchestrate';

export const deliveryOpsAgentManifest: AgentManifest = {
    schemaVersion: '1.1',
    id: DELIVERY_OPS_AGENT_ID,
    name: 'Delivery Ops Orchestrator Agent',
    version: '1.0.0',
    description: 'Coordinates delivery operations by delegating bounded work to task, standup, daily-summary, weekly-report and dashboard Agents.',
    runtime: { type: 'model-loop', engine: 'ai-sdk' },
    capabilities: [DELIVERY_OPS_CAPABILITY],
    triggers: ['message', 'manual'],
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string' },
            source: { type: 'string', enum: ['group', 'private', 'manual'] },
            message: { type: 'object' },
            replyContext: { type: 'object' },
            groupId: { type: 'string' },
            dayIso: { type: 'string' },
        },
    },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 180, maxSteps: 12, maxToolCalls: 0, maxAgentCalls: 4, maxDepth: 3, maxOutputBytes: 5 * 1024 * 1024 },
    delivery: { allowedArtifactTypes: ['markdown', 'image', 'file', 'article_list'], directDelivery: false },
    modelProfile: 'reasoning',
    delegates: [TASK_AGENT_CAPABILITY, STANDUP_AGENT_CAPABILITY, DAILY_SUMMARY_CAPABILITY, WEEKLY_REPORT_CAPABILITY, DASHBOARD_CAPABILITY],
    optionalDelegates: [AI_HOT_CAPABILITY],
    memory: { mode: 'session', maxMessages: 30, ttlHours: 24 * 7 },
};

const deliveryOpsInstructions = `你是系统唯一面向用户的交付运营主 Agent。你负责理解跨领域请求、制定最短执行路径，并把业务动作委派给专门 Agent。

可委派边界：
- task.manage：任务创建、查询、跟踪、状态更新、项目任务同步。
- standup.manage：站会提交、补交、查询、缺交统计。
- summary.daily.generate：生成并持久化日报。
- summary.weekly.generate：生成基于站会、TAPD 和任务变更证据的本周或上周周报。
- dashboard.project.generate：生成项目看板快照。

硬性规则：
1. 你不能直接修改业务数据；任何业务读写都必须调用对应子 Agent。
2. 输入带有 message/source/replyContext 时，委派任务或站会必须原样携带这些字段，以复用旧系统的确定性规则、权限、回复和幂等逻辑。
3. 可以为一个复合请求顺序调用多个子 Agent，但不得超过调用配额，不得把同一动作重复执行。
4. 子 Agent 返回 waiting_human 时，立即使用 request_human_input 向用户提出同一个问题，并记住 child runId。用户回复后，用同一个委派工具传 resumeRunId 和新 prompt 恢复该子 Run。
5. 不猜测负责人、群组、日期、任务 ID 或执行结果；缺少关键字段时暂停并询问。
6. 最终回答必须以真实工具结果为依据，简洁说明已完成、未完成和需要用户补充的内容。`;

export function registerDeliveryOpsAgent(adapter: ModelLoopAgentAdapter): void {
    adapter.register(DELIVERY_OPS_AGENT_ID, deliveryOpsAgentManifest.version, {
        instructions: deliveryOpsInstructions,
        artifactTitle: '交付运营处理结果',
    });
}
