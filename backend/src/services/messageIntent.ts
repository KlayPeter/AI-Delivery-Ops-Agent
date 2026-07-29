import { LLMAdapter } from '@/adapters/llm';
import { Member, SourceMessage } from '@/models/types';
import dayjs from 'dayjs';

export const SUPPORTED_INTENTS = new Set(["update_task", "create_task", "add_progress", "change_status", "unknown"]);
export const SUPPORTED_STATUS_ACTIONS = new Set(["接受", "拒绝", "需要澄清", "验收通过", "已实现", "已经实现", "验收完成", "已经完成", "已结束", "已经结束", "结束", "打回", "已完成", "完成了", "开发完成", "开发完毕", "开发完了", "转测试", "提测", "阻塞", "阻塞了", "已修复", "解除阻塞", "阻塞已修复", "阻塞解决"]);
export const SUPPORTED_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

export interface IntentTaskRef {
    task_id: string;
    tapd_story_id: string;
    title: string;
}

export interface IntentFields {
    title: string;
    description: string;
    due_date: string;
    priority: string;
    owner_open_id: string;
    progress: string;
    status_action: string;
}

export interface IntentTaskDraft {
    title: string;
    description: string;
    due_date: string;
    priority: string;
    owner_open_id: string;
    acceptance_criteria: string[];
}

export interface MessageIntent {
    intent: string;
    confidence: number;
    task_ref: IntentTaskRef;
    fields: IntentFields;
    tasks: IntentTaskDraft[];
    needs_clarification: boolean;
    clarification: string;
    error: string;
    available: boolean;
}

export class MessageIntentParser {
    public llm?: LLMAdapter;

    constructor(llm?: LLMAdapter) {
        this.llm = llm;
    }

    async parse(
        message: SourceMessage,
        replyContext: Record<string, any> | null,
        taskContext: Record<string, any> | null,
        members: Member[],
        today: Date = new Date(),
        forcedIntent?: "create_task"
    ): Promise<MessageIntent> {
        const payload = {
            today: dayjs(today).format('YYYY-MM-DD'),
            forced_intent: forcedIntent || "",
            message: {
                id: message.id,
                chat_type: message.chat_type,
                sender_open_id: message.sender_open_id,
                sender_name: message.sender_name,
                text: message.text,
                mentions: (message.mentions || []).map(item => ({ open_id: item.open_id, name: item.name })),
            },
            reply_context: this.compactReplyContext(replyContext),
            task_context: this.compactTask(taskContext),
            members: members.filter(m => m.is_active).map(m => ({ open_id: m.open_id, name: m.name, role: m.role })),
        };

        const result = await this.llm.chat(this.systemPrompt(forcedIntent), JSON.stringify(payload));
        if (!result.ok) {
            return this.errorIntent(result.error || "llm_error");
        }
        if (!result.content.trim()) {
            return this.errorIntent("llm_unavailable");
        }

        let raw: any;
        try {
            raw = JSON.parse(this.extractJson(result.content));
        } catch (exc: any) {
            return this.errorIntent(`invalid_json: ${exc.message}`);
        }
        return this.normalize(raw);
    }

    private errorIntent(error: string): MessageIntent {
        return {
            intent: "unknown",
            confidence: 0.0,
            task_ref: { task_id: "", tapd_story_id: "", title: "" },
            fields: { title: "", description: "", due_date: "", priority: "", owner_open_id: "", progress: "", status_action: "" },
            tasks: [],
            needs_clarification: false,
            clarification: "",
            error,
            available: false
        };
    }

    private systemPrompt(forcedIntent?: "create_task"): string {
        const forcedInstruction = forcedIntent === "create_task"
            ? "调用方已通过确定性规则确认这是创建任务。intent 必须输出 create_task，不要判断为 update_task、add_progress 或 change_status；你的职责是概括任务标题并提取描述、负责人、截止时间、优先级和验收标准。\n"
            : "";
        return (
            "你是研发交付飞书机器人的意图解析器。只输出 JSON，不要 Markdown。\n" +
            "根据输入消息、引用上下文、任务上下文和成员列表，判断用户意图并抽取字段。\n" +
            forcedInstruction +
            "只能使用这些 intent: update_task, create_task, add_progress, change_status, unknown。\n" +
            "输出格式必须是：" +
            "{\"intent\":\"update_task|create_task|add_progress|change_status|unknown\"," +
            "\"confidence\":0.0," +
            "\"task_ref\":{\"task_id\":\"\",\"tapd_story_id\":\"\",\"title\":\"\"}," +
            "\"fields\":{\"title\":\"\",\"description\":\"\",\"due_date\":\"YYYY-MM-DD\",\"priority\":\"P0|P1|P2|P3\"," +
            "\"owner_open_id\":\"\",\"progress\":\"\",\"status_action\":\"接受|拒绝|需要澄清|验收通过|已实现|打回|已完成|开发完成|转测试|阻塞|已修复|解除阻塞\"}," +
            "\"tasks\":[{\"title\":\"\",\"description\":\"\",\"due_date\":\"YYYY-MM-DD\",\"priority\":\"P0|P1|P2|P3\",\"owner_open_id\":\"\",\"acceptance_criteria\":[\"\"]}]," +
            "\"needs_clarification\":false,\"clarification\":\"\"}。\n" +
            "创建任务时优先用语义理解，不要只依赖固定关键词。请把 TAPD 标题总结成简短、可执行的任务名，把用户原始诉求、背景、要求和补充说明放入 description，不要把整段原文塞进标题。\n" +
            "如果一条消息明显包含多个独立任务，intent=create_task，并在 tasks 数组中逐个列出；每个任务都要有独立短标题、详细 description、负责人 owner_open_id、截止时间和优先级。只有一个任务时也可以只填 fields。特别注意：当拆分多个任务时，必须在 fields.title 中填入一个高度概括所有子任务的总标题（将用作父节点名称）。\n" +
            "关于负责人（owner_open_id）：如果用户提到“我”、“自己”，请严格将 fields.owner_open_id（或 tasks 里的 owner_open_id）填为传入 JSON 里 message.sender_open_id 的实际值。如果用户艾特了其他人，请从传入 JSON 里的 message.mentions 匹配提取他们真正的 open_id。如果一个任务分配给了多个人，请用半角逗号分隔多个 open_id（例如：ou_123,ou_456）。\n" +
            "关于 due_date：如果消息提到“这周内”或“本周内”，请将其计算为本周五的日期。除非用户明确指定了非工作日日期，否则由于任务必须创建在工作日，请自动顺延到最近的工作日。\n" +
            "修改 TAPD 标题时填 fields.title；修改详细信息、详情、描述、备注、说明时填 fields.description。\n" +
            "任务状态流转：接受=>开发进行中；开发完成、开发完毕、转测试、提测=>转测试；已修复=>已修复（由系统根据是否阻塞自动判断）；验收通过、已实现、验收完成、已结束=>已实现；阻塞已经修复、解除阻塞、阻塞解决=>解除阻塞。若开发完成转测试时消息 @ 了成员，把该成员 open_id 填入 fields.owner_open_id。\n" +
            "高置信度只在任务和字段都明确时给出；如果需要确认或任务不明确，needs_clarification=true 并给出中文澄清。注意澄清时不要说'这不属于任务管理指令'等限制性话语，只需委婉表示：'抱歉，我未能识别出针对具体任务的操作指令。请问您是想操作某个任务，还是执行其他系统功能？'"
        );
    }

    private extractJson(content: string): string {
        const text = content.trim();
        const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
        if (fenced) return fenced[1];

        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 && end >= start) return text.substring(start, end + 1);
        return text;
    }

    private normalize(raw: any): MessageIntent {
        let intent = typeof raw.intent === 'string' ? raw.intent : "unknown";
        if (!SUPPORTED_INTENTS.has(intent)) intent = "unknown";

        let confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.0;
        confidence = Math.max(0.0, Math.min(confidence, 1.0));

        const taskRefRaw = typeof raw.task_ref === 'object' && raw.task_ref ? raw.task_ref : {};
        const fieldsRaw = typeof raw.fields === 'object' && raw.fields ? raw.fields : {};
        const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];

        let priority = this.str(fieldsRaw.priority).toUpperCase();
        if (!SUPPORTED_PRIORITIES.has(priority)) priority = "";

        let statusAction = this.str(fieldsRaw.status_action);
        if (!SUPPORTED_STATUS_ACTIONS.has(statusAction)) statusAction = "";

        return {
            intent,
            confidence,
            task_ref: {
                task_id: this.str(taskRefRaw.task_id),
                tapd_story_id: this.str(taskRefRaw.tapd_story_id),
                title: this.str(taskRefRaw.title),
            },
            fields: {
                title: this.str(fieldsRaw.title),
                description: this.str(fieldsRaw.description),
                due_date: this.str(fieldsRaw.due_date),
                priority,
                owner_open_id: this.str(fieldsRaw.owner_open_id),
                progress: this.str(fieldsRaw.progress),
                status_action: statusAction,
            },
            tasks: tasksRaw.map((item: any) => this.normalizeTaskDraft(item)).filter((item: IntentTaskDraft) => (
                item.title || item.description || item.owner_open_id || item.due_date || item.priority || item.acceptance_criteria.length
            )),
            needs_clarification: !!raw.needs_clarification,
            clarification: this.str(raw.clarification),
            error: "",
            available: true
        };
    }

    private normalizeTaskDraft(raw: any): IntentTaskDraft {
        const item = typeof raw === 'object' && raw ? raw : {};
        let priority = this.str(item.priority).toUpperCase();
        if (!SUPPORTED_PRIORITIES.has(priority)) priority = "";
        const acceptanceRaw = Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria : [];

        return {
            title: this.str(item.title),
            description: this.str(item.description),
            due_date: this.str(item.due_date),
            priority,
            owner_open_id: this.str(item.owner_open_id),
            acceptance_criteria: acceptanceRaw.map((value: any) => this.str(value)).filter(Boolean),
        };
    }

    private compactReplyContext(context: Record<string, any> | null): Record<string, any> | null {
        if (!context) return null;
        return {
            context_type: context.context_type || "",
            task_id: context.task_id || "",
            task_title: context.task_title || "",
            target_open_id: context.target_open_id || "",
            metadata: context.metadata || {},
        };
    }

    private compactTask(task: Record<string, any> | null): Record<string, any> | null {
        if (!task) return null;
        return {
            id: task.id || "",
            title: task.title || "",
            description: task.description || "",
            tapd_story_id: task.tapd_story_id || "",
            primary_owner_open_id: task.primary_owner_open_id || "",
            primary_owner_name: task.primary_owner_name || "",
            priority: task.priority || "",
            due_date: task.due_date || "",
            status: task.status || "",
        };
    }

    private str(value: any): string {
        return typeof value === 'string' ? value.trim() : "";
    }
}
