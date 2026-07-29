import { PrismaStore } from '@/core/storage';
import { LLMAdapter, LLMResult } from '@/adapters/llm';
import { DailySummary, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';
import { isActiveTask } from '@/services/taskScope';
import { overduePolicy } from '@/domains/task/overduePolicy';
import { TaskService } from '@/services/taskService';

export const TASK_HINTS = ["任务", "负责", "跟进", "处理", "完成", "联调", "提测", "修复"];
export const PROGRESS_HINTS = ["进度", "完成了", "已完成", "推进", "联调", "提测", "上线"];
export const BLOCKER_HINTS = ["阻塞", "卡住", "无法", "等待", "需要帮助", "需要协助", "失败"];
export const DECISION_HINTS = ["决定", "决策", "结论", "确认", "拍板", "定为"];
export const RISK_HINTS = ["风险", "延期", "来不及", "不稳定", "超期", "产能", "优先级冲突", "无法全部覆盖", "超时"];
export const SHARE_HINTS = ["分享", "链接", "资料", "参考", "http://", "https://"];
export const TASK_PLAN_HINTS = ["负责人", "人员分工", "任务安排", "接下来研发", "启动如下功能", "开始开发", "后续开发"];
export const COLLABORATION_HINTS = ["配合", "协作", "对齐", "协调", "结对", "主观能动性", "产品同学", "研发同学", "执行不能打折"];
export const MEETING_HINTS = ["评审", "review", "宣讲", "排期", "会议", "开会", "下周", "周一", "周二", "周三", "明天上午", "明天下午", "开始开发", "开发周期"];
export const HELP_HINTS = ["需要帮助", "需要协助", "请求支持", "谁能", "麻烦", "帮忙"];
export const MANAGER_ATTENTION_HINTS = ["人力", "产能", "优先级", "超额任务", "无法全部覆盖", "延期", "严重阻塞", "关键风险", "责任边界", "质量兜底", "执行不能打折"];
export const DAILY_SUMMARY_LLM_TIMEOUT_MS = 32_000;
export const DAILY_SUMMARY_LLM_REQUEST_TIMEOUT_MS = 30_000;

interface MessageClassificationResult {
    classified: Record<string, any[]>;
    abstract?: string;
}

export const STATUS_MAP: Record<string, string> = {
    "pending_primary_owner": "待主负责人处理",
    "pending_confirmation": "待确认",
    "requirement": "需求阶段",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "blocked": "已阻塞",
    "development_completed": "开发完成",
    "owner_marked_done": "负责人已标记完成",
    "testing": "测试中",
    "accepted": "已验收",
    "cancelled": "已取消",
    "overdue": "已超期",
    "deleted": "已删除",
};

export async function buildDailySummary(
    store: PrismaStore,
    groupId: string,
    day: Date = new Date(),
    llm?: LLMAdapter,
    period: string = "00:00-23:59"
): Promise<DailySummary> {
    const dDay = dayjs(day);
    const dateText = dDay.format('YYYY-MM-DD');

    let [startStr, endStr] = period.includes("-") ? period.split("-") : ["00:00", "23:59"];
    let [hStart, mStart] = startStr.split(":").map(Number);
    let [hEnd, mEnd] = endStr.split(":").map(Number);

    let startTime: dayjs.Dayjs;
    if (hStart > hEnd || (hStart === hEnd && mStart >= mEnd)) {
        startTime = dDay.subtract(1, 'day').hour(hStart).minute(mStart).second(0).millisecond(0);
    } else {
        startTime = dDay.hour(hStart).minute(mStart).second(0).millisecond(0);
    }
    const endTime = dDay.hour(hEnd).minute(mEnd).second(59).millisecond(999);

    function inPeriod(dtStr: string): boolean {
        if (!dtStr) return false;
        let dt: dayjs.Dayjs;
        if (/^\d+$/.test(dtStr)) {
            dt = dayjs(parseInt(dtStr));
        } else {
            dt = dayjs(dtStr);
        }
        if (!dt.isValid()) return false;
        return dt.isAfter(startTime) && dt.isBefore(endTime);
    }

    const sourceMessages = await store.listSourceMessages();
    const sourceMessagesById: Record<string, any> = {};
    for (const item of sourceMessages) {
        if (item.id) sourceMessagesById[item.id] = item;
    }
    const storedTasks = await store.listTasks();
    const hierarchy = TaskService.projectHierarchy(storedTasks);
    const allTasks = storedTasks.filter(isActiveTask);
    const tasksById: Record<string, any> = {};
    const groupTaskIds = new Set<string>();
    for (const item of allTasks) {
        if (item.id) tasksById[item.id] = item;
        if (itemGroupId(item, sourceMessagesById) === groupId && item.id) {
            groupTaskIds.add(item.id);
        }
    }

    const messages = sourceMessages.filter(item => inPeriod(item.sent_at || "") && item.chat_id === groupId);

    const uniqueTasks = new Map<string, any>();
    allTasks
        .filter(item => inPeriod(item.created_at || "") && itemGroupId(item, sourceMessagesById) === groupId)
        .map(item => taskSummaryItem(item, sourceMessagesById))
        .forEach(item => uniqueTasks.set(`${item.parent_id || "root"}:${item.title}`, item));
    const tasks = Array.from(uniqueTasks.values());

    const updates = (await store.listTaskUpdates())
        .filter(item => inPeriod(item.created_at || "") && groupTaskIds.has(item.task_id || ""))
        .map(item => ({
            ...updateSummaryItem(item, sourceMessagesById),
            task_title: tasksById[item.task_id || ""]?.title || "",
        }));

    const classification = await classifyMessages(messages, llm, store);
    const classified = classification.classified;
    const taskSourceMessageIds = new Set<string>();
    for (const item of [...tasks, ...updates]) {
        for (const messageId of item.source_message_ids || []) {
            if (messageId) taskSourceMessageIds.add(messageId);
        }
    }
    const taskCommandMessageIds = new Set(
        messages.filter(isTaskCreationCommandMessage).map(item => item.id).filter(Boolean)
    );
    for (const bucket of Object.keys(classified)) {
        classified[bucket] = classified[bucket].filter((item: any) =>
            !(item.source_message_ids || []).some((messageId: string) =>
                taskSourceMessageIds.has(messageId) || taskCommandMessageIds.has(messageId)
            )
        );
    }

    const overdueUpdates = updates
        .filter(item => {
            const task = tasksById[item.task_id || ""];
            return Boolean(task && isOverdueTaskUpdate(item) && hierarchy.isActionableLeaf(task));
        })
        .map(overdueUpdateSummaryItem);
    const progressUpdates = consolidateTaskProgress(
        updates.filter(item => !["blocker", "standup_blocker"].includes(item.update_type) && !isOverdueTaskUpdate(item))
    );
    const taskBlockers = allTasks
        .filter(item => hierarchy.isActionableLeaf(item) && item.status === "blocked" && blockedLongEnough(item) && itemGroupId(item, sourceMessagesById) === groupId)
        .map(item => riskSummaryItem(item, sourceMessagesById, "blocker", dateText));

    const uniqueBlockers = new Map<string, any>();
    [
        ...updates.filter(item => ["blocker", "standup_blocker"].includes(item.type)),
        ...taskBlockers,
        ...classified.blockers
    ].forEach(item => {
        const key = item.title || item.content || item.id;
        if (!uniqueBlockers.has(key)) uniqueBlockers.set(key, item);
    });
    const blockers = Array.from(uniqueBlockers.values());

    const uniqueRisks = new Map<string, any>();
    allTasks
        .filter(item => hierarchy.isActionableLeaf(item) && (overduePolicy(item.due_date, dateText) || item.status === "overdue" || (item.status === "blocked" && blockedLongEnough(item))) && itemGroupId(item, sourceMessagesById) === groupId)
        .map(item => riskSummaryItem(item, sourceMessagesById, "risk", dateText))
        .forEach(item => uniqueRisks.set(item.title, item));

    overdueUpdates.forEach(item => {
        const key = item.task_title || item.title;
        if (!uniqueRisks.has(key)) uniqueRisks.set(key, item);
    });

    classified.risks.forEach(item => {
        if (!uniqueRisks.has(item.title)) {
            uniqueRisks.set(item.title, item);
        }
    });
    const risks = Array.from(uniqueRisks.values());

    const discusses = [...classified.progress_updates, ...classified.discusses];
    const highlights = getHighlights(tasks, progressUpdates, blockers, classified.decisions, risks, classified.helps, classified.shares, classified.meetings, discusses);

    const aiAbstract = classification.abstract || buildRuleAbstract(dateText, tasks, progressUpdates, blockers, risks, classified);

    return {
        id: `summary-${encodeURIComponent(groupId)}-${dateText}`,
        group_id: groupId,
        date: dateText,
        highlights,
        tasks,
        progress_updates: progressUpdates,
        blockers,
        decisions: classified.decisions,
        risks,
        helps: classified.helps,
        shares: classified.shares,
        meetings: classified.meetings,
        discusses,
        created_at: utcNowIso(),
        ai_abstract: aiAbstract
    };
}

export function renderDailySummary(summary: DailySummary): string {
    const hasData = summary.highlights?.length || summary.tasks?.length || summary.progress_updates?.length ||
                    summary.blockers?.length || summary.decisions?.length || summary.risks?.length ||
                    summary.helps?.length || summary.shares?.length || summary.meetings?.length || summary.discusses?.length;
    if (!hasData) return `${summary.date} 群内无可总结的有效工作信息。`;

    const lines: string[] = [];
    const taskBlockers = (summary.blockers || []).filter(isTaskSummaryItem);
    const chatBlockers = (summary.blockers || []).filter(item => !isTaskSummaryItem(item));
    const taskRisks = (summary.risks || []).filter(isTaskSummaryItem).sort((left, right) => (right.overdue_days || 0) - (left.overdue_days || 0));
    const chatRisks = (summary.risks || []).filter(item => !isTaskSummaryItem(item));
    const workDynamics = (summary.discusses || []).filter(item => ["progress", "task_plan"].includes(item.type));
    const collaborationItems = (summary.discusses || []).filter(item => item.type === "collaboration");
    const otherDiscusses = (summary.discusses || []).filter(item => !["progress", "task_plan", "collaboration"].includes(item.type));
    if (summary.ai_abstract) {
        lines.push("🤖 **AI 总结：**", summary.ai_abstract, "");
    }

    lines.push("**💼 第一部分：任务与交付**");
    lines.push("");
    lines.push("**🎯 一、重点概览**");
    const hls = summary.highlights?.length ? summary.highlights : ["暂无重点"];
    hls.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));

    lines.push("", "**📝 二、新增任务**");
    let count = 1;
    if (summary.tasks?.length) {
        renderNewTasks(lines, summary.tasks, () => count++);
    } else {
        lines.push("暂无新增任务。");
    }

    lines.push("", "**🔄 三、任务进度与变更**");
    count = 1;
    if (summary.progress_updates?.length) {
        summary.progress_updates.forEach((item) => {
            const sender = senderName(item);
            if (item.progress_details?.length) {
                lines.push(`${count++}. ${sender}${item.task_title ? `｜**${item.task_title}**` : ""}`);
                item.progress_details.forEach((detail: any) => {
                    lines.push(`   - ${detail.label}：${detail.text}`);
                });
            } else {
                const prefix = item.task_title ? `(所属任务: ${item.task_title}) ` : "";
                lines.push(`${count++}. ${sender}：${prefix}${item.title || ''}`);
            }
        });
    } else {
        lines.push("暂无进度更新。");
    }

    lines.push("", "**🚧 四、任务阻塞**");
    if (taskBlockers.length) {
        taskBlockers.forEach((item, idx) => {
            if (item.status) {
                lines.push(`${idx + 1}. **【${item.title || ''}】**`);
            } else {
                const sender = senderName(item);
                lines.push(`${idx + 1}. ${sender}：${item.title || item.content || ''}`);
            }
            const ai = item.ai_result || {};
            const related = (ai.related_users || []).join("、") || "待定";
            lines.push(`   - 需要协助人：${related}`);
            lines.push(`   - 建议动作：跟进解决阻塞`);
        });
    } else {
        lines.push("暂无明确阻塞。");
    }

    lines.push("", "**⚠️ 五、任务风险**");
    if (taskRisks.length) {
        taskRisks.forEach((item, idx) => {
            if (item.status) {
                const statusStr = item.status ? `当前状态：${statusLabel(item.status)}` : "";
                const overdueLabel = item.overdue_label ? `，${item.overdue_label}` : "";
                lines.push(`${idx + 1}. **【${item.title || ''}】**${statusStr ? '，' + statusStr : ''}${overdueLabel}`);
            } else {
                const sender = senderName(item);
                const statusStr = item.status ? `，当前状态：${statusLabel(item.status)}` : "";
                lines.push(`${idx + 1}. ${sender}：${item.title || ''}${statusStr}`);
            }
            const ai = item.ai_result || {};
            const riskLevel = riskLevelLabel(ai.risk_level);
            lines.push(`   - 风险等级：${riskLevel}`);
            lines.push(`   - 建议动作：跟进风险情况`);
        });
    } else {
        lines.push("暂无明显风险。");
    }

    lines.push("", "---");
    lines.push("**💬 第二部分：群聊天内容**");
    lines.push("");
    lines.push("**🗣️ 一、工作动态**");
    if (workDynamics.length) {
        workDynamics.forEach((item, idx) => {
            lines.push(`${idx + 1}. **【${chatTypeLabel(item.type)}】** ${senderName(item)}：${item.title || ''}`);
        });
    } else {
        lines.push("暂无工作动态。");
    }

    lines.push("", "**📅 二、决策与排期**");
    const decisionsAndSchedule = [...(summary.decisions || []), ...(summary.meetings || [])];
    if (decisionsAndSchedule.length) {
        decisionsAndSchedule.forEach((item, idx) => lines.push(`${idx + 1}. **【${chatTypeLabel(item.type)}】** ${senderName(item)}：${item.title || ''}`));
    } else {
        lines.push("暂无决策与排期。");
    }

    lines.push("", "**🚧 三、风险与协作**");
    const risksAndCollaboration = [...chatBlockers, ...chatRisks, ...(summary.helps || []), ...collaborationItems];
    if (risksAndCollaboration.length) {
        risksAndCollaboration.forEach((item, idx) => lines.push(`${idx + 1}. **【${chatTypeLabel(item.type)}】** ${senderName(item)}：${item.title || item.content || ''}`));
    } else {
        lines.push("暂无风险与协作事项。");
    }

    lines.push("", "**🔗 四、资料与其他**");
    const resourcesAndOthers = [...(summary.shares || []), ...otherDiscusses];
    if (resourcesAndOthers.length) {
        resourcesAndOthers.forEach((item, idx) => {
            lines.push(`${idx + 1}. **【${chatTypeLabel(item.type)}】** ${senderName(item)}：${item.title || ''}`);
            const ai = item.ai_result || {};
            const urls = item.urls || ai.urls || (ai.url ? [ai.url] : []);
            urls.forEach((url: string) => lines.push(`   - 链接：${url}`));
        });
    } else {
        lines.push("暂无资料或其他群内讨论。");
    }

    lines.push("", "**👀 需要管理者特别关注**");
    const managerAttention = managerAttentionItems(summary);
    if (managerAttention.length) {
        managerAttention.forEach((item, idx) => {
            const reason = item.attention_reason || item.ai_result?.attention_reason || "";
            lines.push(`${idx + 1}. ${item.title || item.content || ''}${reason ? `（${reason}）` : ""}`);
        });
    } else {
        lines.push("暂无需要管理者特别关注的事项。");
    }

    return lines.join("\n");
}

function renderNewTasks(lines: string[], tasks: any[], nextCount: () => number): void {
    const taskKey = (task: any, index: number) => String(task.id || task.tapd_story_id || `${task.title || "untitled"}-${index}`);
    const parentKeys = new Map<string, string>();
    tasks.forEach((task, index) => {
        const key = taskKey(task, index);
        for (const reference of [task.id, task.tapd_story_id]) {
            if (reference) parentKeys.set(String(reference), key);
        }
    });

    const childrenByParent = new Map<string, any[]>();
    const roots: Array<{ task: any, index: number }> = [];
    tasks.forEach((task, index) => {
        const parentKey = task.parent_id ? parentKeys.get(String(task.parent_id)) : undefined;
        if (!parentKey) {
            roots.push({ task, index });
            return;
        }
        const children = childrenByParent.get(parentKey) || [];
        children.push(task);
        childrenByParent.set(parentKey, children);
    });

    roots.forEach(({ task, index }) => {
        lines.push(`${nextCount()}. **${task.title || '未命名任务'}**${taskInlineDetails(task)}`);
        for (const child of childrenByParent.get(taskKey(task, index)) || []) {
            lines.push(`   - ${child.title || '未命名子任务'}${taskInlineDetails(child)}`);
        }
    });
}

function taskInlineDetails(task: any): string {
    const owner = task.primary_owner_name || (task.assignee_names || []).filter(Boolean).join("、") || "未指定";
    const details = [`负责人：${owner}`];
    if (task.status) details.push(`当前状态：${statusLabel(task.status)}`);
    if (task.due_date) details.push(`截止：${task.due_date}`);
    return `（${details.join("；")}）`;
}

function getHighlights(
    tasks: any[], progressUpdates: any[], blockers: any[], decisions: any[], risks: any[], helps: any[], shares: any[], meetings: any[], discusses: any[]
): string[] {
    const values: string[] = [];
    if (tasks.length) values.push(`新增 ${tasks.length} 个显式任务。`);
    if (progressUpdates.length) values.push(`记录 ${progressUpdates.length} 条任务或进度信息。`);
    if (blockers.length) values.push(`记录 ${blockers.length} 条阻塞，需要关注协助动作。`);
    if (decisions.length) values.push(`沉淀 ${decisions.length} 条决策结论。`);
    if (risks.length) values.push(`记录 ${risks.length} 项风险，需要关注影响和缓解动作。`);
    if (helps.length) values.push(`收到 ${helps.length} 个求助问题。`);
    if (shares.length) values.push(`沉淀 ${shares.length} 条资料分享。`);
    if (meetings.length) values.push(`发布 ${meetings.length} 条会议或重要通知。`);
    if (discusses.length) values.push(`记录 ${discusses.length} 条日常讨论与团队交流。`);
    return values.slice(0, 5);
}

function buildRuleAbstract(
    dateText: string,
    tasks: any[],
    progressUpdates: any[],
    blockers: any[],
    risks: any[],
    classified: Record<string, any[]>,
): string {
    const topicCount = Object.values(classified).reduce((total, items) => total + items.length, 0);
    const focus = [
        ...classified.progress_updates,
        ...classified.discusses.filter(item => item.type === "task_plan"),
        ...classified.decisions,
        ...classified.meetings,
    ].map(item => String(item.title || "").trim()).filter(Boolean).slice(0, 2).join("；");
    const counts = [
        tasks.length ? `${tasks.length}项新增任务` : "",
        progressUpdates.length ? `${progressUpdates.length}项任务进展` : "",
        blockers.length ? `${blockers.length}项阻塞` : "",
        risks.length ? `${risks.length}项风险` : "",
    ].filter(Boolean).join("、");
    return `${dateText} 共归纳 ${topicCount} 个业务主题${counts ? `，包括${counts}` : ""}${focus ? `。重点：${compactTitle(focus)}` : "。"}`;
}

async function classifyMessages(messages: any[], llm?: LLMAdapter, store?: PrismaStore): Promise<MessageClassificationResult> {
    const candidateMessages = messages.filter(message => {
        if (message.message_type === "system") return false;
        const text = String(message.text || "").trim();
        return text && !isIgnorableChatMessage(text) && !isTaskCreationCommandMessage(message);
    });
    const aiResult = llm ? await classifyMessagesWithAi(candidateMessages, llm, store) : null;
    const classified = ensureRelevantMessageCoverage(
        candidateMessages,
        aiResult?.classified || classifyMessagesWithRules(candidateMessages),
    );
    return {
        classified: mergeClassificationTopics(classified),
        abstract: aiResult?.abstract,
    };
}

function isTaskCreationCommandMessage(message: any): boolean {
    if (String(message.ai_result?.type || "") === "task_command") return true;
    const text = String(message.text || "").trim();
    if (!text) return false;
    const createsTask = /(?:创建|新建|新增)(?:一个|一条)?(?:子)?任务/.test(text);
    const botOrTaskDetails = /(?:机器人|Robot|Bot|父任务|子任务|负责人)/i.test(text);
    return createsTask && botOrTaskDetails;
}

function classifyMessagesWithRules(messages: any[]): Record<string, any[]> {
    const result = emptyClassification();
    for (const message of messages) {
        const text = String(message.text || "").trim();
        if (!text || isIgnorableChatMessage(text)) continue;

        const urls = extractUrls(text);
        if (urls.length) {
            const item = messageSummaryItem(message, "share", 0.8, "rule_daily_summary");
            item.urls = urls;
            item.ai_result = { ...(item.ai_result || {}), urls, url: urls[0] };
            result.shares.push(item);
        } else if (hasAny(text, RISK_HINTS)) {
            result.risks.push(messageSummaryItem(message, "risk", 0.76, "rule_daily_summary"));
        } else if (hasAny(text, HELP_HINTS)) {
            result.helps.push(messageSummaryItem(message, "help", 0.74, "rule_daily_summary"));
        } else if (hasAny(text, BLOCKER_HINTS)) {
            result.blockers.push(messageSummaryItem(message, "blocker", 0.72, "rule_daily_summary"));
        } else if (hasAny(text, DECISION_HINTS)) {
            result.decisions.push(messageSummaryItem(message, "decision", 0.75, "rule_daily_summary"));
        } else if (hasAny(text, MEETING_HINTS)) {
            result.meetings.push(messageSummaryItem(message, "meeting", 0.75, "rule_daily_summary"));
        } else if (hasAny(text, TASK_PLAN_HINTS)) {
            result.discusses.push(messageSummaryItem(message, "task_plan", 0.72, "rule_daily_summary"));
        } else if (hasAny(text, COLLABORATION_HINTS)) {
            result.discusses.push(messageSummaryItem(message, "collaboration", 0.72, "rule_daily_summary"));
        } else if (hasAny(text, TASK_HINTS) || hasAny(text, PROGRESS_HINTS)) {
            result.progress_updates.push(messageSummaryItem(message, "progress", 0.68, "rule_daily_summary"));
        } else if (text.length >= 80) {
            result.discusses.push(messageSummaryItem(message, "discuss", 0.62, "rule_daily_summary"));
        }
    }
    return result;
}

function ensureRelevantMessageCoverage(messages: any[], classified: Record<string, any[]>): Record<string, any[]> {
    const result = emptyClassification();
    for (const bucket of Object.keys(result)) {
        result[bucket].push(...(classified[bucket] || []));
    }

    const covered = new Set<string>();
    for (const bucket of Object.keys(result)) {
        for (const item of result[bucket]) {
            for (const messageId of item.source_message_ids || []) covered.add(String(messageId));
        }
    }

    const fallback = classifyMessagesWithRules(messages);
    for (const bucket of Object.keys(fallback)) {
        for (const item of fallback[bucket]) {
            const messageIds = (item.source_message_ids || []).map(String);
            if (messageIds.some((messageId: string) => covered.has(messageId))) continue;
            const relatedTopic = result[bucket].find(existing => shouldAttachFallbackToTopic(existing, item));
            if (relatedTopic) {
                attachTopicSources(relatedTopic, item);
                messageIds.forEach((messageId: string) => covered.add(messageId));
                continue;
            }
            result[bucket].push(item);
            messageIds.forEach((messageId: string) => covered.add(messageId));
        }
    }
    return result;
}

function shouldAttachFallbackToTopic(existing: any, fallback: any): boolean {
    if (existing?.type !== fallback?.type || String(fallback?.title || "").length > 80) return false;
    const existingText = `${existing.title || ""} ${existing.raw_text || ""}`;
    const fallbackText = `${fallback.title || ""} ${fallback.raw_text || ""}`;
    const topicHints = ["评审", "review", "宣讲", "会议", "排期", "开发", "联调", "提测", "上线", "发布"];
    const hasSharedHint = topicHints.some(hint => existingText.toLowerCase().includes(hint) && fallbackText.toLowerCase().includes(hint));
    if (!hasSharedHint) return false;
    const timeHints = ["今天", "明天", "后天", "本周", "下周", "周一", "周二", "周三", "周四", "周五", "月底", "月初"];
    return timeHints.some(hint => existingText.includes(hint) && fallbackText.includes(hint));
}

function attachTopicSources(target: any, source: any): void {
    const sourceMessageIds = Array.from(new Set([...(target.source_message_ids || []), ...(source.source_message_ids || [])].map(String)));
    const senderNames = Array.from(new Set([senderName(target), senderName(source)].filter(name => name && name !== "未知成员")));
    const rawTexts = Array.from(new Set([target.raw_text, source.raw_text].map(value => String(value || "").trim()).filter(Boolean)));
    target.source_message_ids = sourceMessageIds;
    target.sender_name = senderNames.length === 1 ? senderNames[0] : "多人";
    target.raw_text = rawTexts.join("\n\n");
    target.trace = { ...(target.trace || {}), source_message_ids: sourceMessageIds, raw_text: target.raw_text };
}

function mergeClassificationTopics(classified: Record<string, any[]>): Record<string, any[]> {
    const result = emptyClassification();
    for (const bucket of Object.keys(result)) {
        const aiTopics = (classified[bucket] || []).filter(item => item.ai_result?.parser === "llm_daily_summary");
        for (const topic of aiTopics) {
            const relatedIndex = result[bucket].findIndex(existing => shouldMergeAiTopics(existing, topic));
            if (relatedIndex >= 0) {
                result[bucket][relatedIndex] = mergeTopicItems([result[bucket][relatedIndex], topic]);
            } else {
                result[bucket].push(topic);
            }
        }
        const byType = new Map<string, any[]>();
        for (const item of classified[bucket] || []) {
            if (item.ai_result?.parser === "llm_daily_summary") continue;
            const values = byType.get(item.type || bucket) || [];
            values.push(item);
            byType.set(item.type || bucket, values);
        }
        for (const values of byType.values()) {
            result[bucket].push(values.length === 1 ? values[0] : mergeTopicItems(values));
        }
    }
    return result;
}

function shouldMergeAiTopics(existing: any, topic: any): boolean {
    if (existing?.type !== "meeting" || topic?.type !== "meeting") return false;
    const existingText = `${existing.title || ""} ${existing.raw_text || ""}`;
    const topicText = `${topic.title || ""} ${topic.raw_text || ""}`;
    const timeHints = ["今天", "明天", "后天", "本周", "下周", "周一", "周二", "周三", "周四", "周五", "月底", "月初"];
    return timeHints.some(hint => existingText.includes(hint) && topicText.includes(hint));
}

function mergeTopicItems(items: any[]): any {
    const first = { ...items[0], ai_result: { ...(items[0].ai_result || {}) }, trace: { ...(items[0].trace || {}) } };
    const titles = Array.from(new Set(items.map(item => String(item.title || "").trim()).filter(Boolean)));
    const sourceMessageIds = Array.from(new Set(items.flatMap(item => item.source_message_ids || []).map(String)));
    const senderNames = Array.from(new Set(items.map(item => senderName(item)).filter(name => name && name !== "未知")));
    const urls = Array.from(new Set(items.flatMap(item => item.urls || item.ai_result?.urls || (item.ai_result?.url ? [item.ai_result.url] : []))));
    first.title = conciseTopicTitle(titles.join("；"), 100);
    first.source_message_ids = sourceMessageIds;
    first.sender_name = senderNames.length === 1 ? senderNames[0] : "多人";
    first.raw_text = items.map(item => String(item.raw_text || "")).filter(Boolean).join("\n\n");
    first.manager_attention = items.some(item => item.manager_attention === true || item.ai_result?.manager_attention === true);
    first.attention_reason = items.map(item => item.attention_reason || item.ai_result?.attention_reason || "").find(Boolean) || "";
    first.ai_result = { ...first.ai_result, title: first.title, manager_attention: first.manager_attention, attention_reason: first.attention_reason };
    first.trace = { ...first.trace, source_message_ids: sourceMessageIds, raw_text: first.raw_text, ai_result: first.ai_result };
    if (urls.length) {
        first.urls = urls;
        first.ai_result.urls = urls;
        first.ai_result.url = urls[0];
    }
    return first;
}

function extractUrls(text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s<>"'）)\]]+/g) || [];
    return Array.from(new Set(matches.map(url => url.replace(/[，,。；;：:]+$/, ""))));
}

function consolidateTaskProgress(items: any[]): any[] {
    const result: any[] = [];
    const grouped = new Map<string, any>();

    for (const item of items) {
        const standupId = item.metadata?.standup_id;
        if (!standupId) {
            result.push(item);
            continue;
        }

        const key = `${standupId}|${item.task_id || ""}|${item.user_open_id || ""}`;
        const section = item.metadata?.standup_section;
        const label = section === "yesterday_done" ? "昨日完成" : section === "today_plan" ? "今日计划" : "进展";
        const text = String(item.content || "")
            .replace(/^任务：【[^】]+】(?:站会进度更新|昨日完成|今日计划)：/, "")
            .trim();
        const detail = { label, text };
        const existing = grouped.get(key);

        if (existing) {
            if (!existing.progress_details.some((value: any) => value.label === detail.label && value.text === detail.text)) {
                existing.progress_details.push(detail);
            }
            existing.content = existing.progress_details.map((value: any) => `${value.label}：${value.text}`).join("；");
            existing.title = existing.content;
            continue;
        }

        const consolidated = {
            ...item,
            progress_details: [detail],
            content: `${label}：${text}`,
            title: `${label}：${text}`,
        };
        grouped.set(key, consolidated);
        result.push(consolidated);
    }

    return result;
}

function isTaskSummaryItem(item: any): boolean {
    return !!(item?.task_id || item?.status);
}

function chatTypeLabel(type: string): string {
    const labels: Record<string, string> = {
        progress: "工作动态",
        task_plan: "任务安排",
        collaboration: "协作要求",
        discuss: "群内讨论",
        decision: "决策",
        help: "求助",
        meeting: "会议通知",
        blocker: "阻塞",
        risk: "风险",
        share: "资料",
    };
    return labels[type] || "群聊动态";
}

function managerAttentionItems(summary: DailySummary): any[] {
    const candidates = [
        ...(summary.blockers || []),
        ...(summary.risks || []),
        ...(summary.helps || []),
        ...(summary.decisions || []),
        ...(summary.meetings || []),
        ...(summary.discusses || []),
    ];
    const unique = new Map<string, { item: any; score: number }>();

    for (const item of candidates) {
        const text = String(item.title || item.content || item.raw_text || "").trim();
        if (!text) continue;
        let score = 0;
        if (item.manager_attention === true || item.ai_result?.manager_attention === true) score += 4;
        if (["blocker", "risk"].includes(item.type)) score += 3;
        if (item.type === "help") score += 2;
        score += Math.min(4, MANAGER_ATTENTION_HINTS.filter(keyword => text.includes(keyword)).length * 2);
        if (score < 4) continue;

        const key = text.replace(/\s+/g, " ").slice(0, 120);
        const existing = unique.get(key);
        if (!existing || score > existing.score) unique.set(key, { item, score });
    }

    return Array.from(unique.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(entry => entry.item);
}

async function classifyMessagesWithAi(messages: any[], llm: LLMAdapter, store?: PrismaStore): Promise<MessageClassificationResult | null> {
    if (!messages.length) return { classified: emptyClassification() };

    const payload = {
        messages: messages.map(item => ({
            id: item.id || "",
            sender_name: item.sender_name || "",
            sent_at: item.sent_at || "",
            text: item.text || "",
        }))
    };

    const system = "你是研发交付群聊日报分析器。只输出 JSON，不要 Markdown。先完整阅读所有消息，再按业务主题合并总结，不要逐条复述消息。忽略纯确认词、机器人指令、日报生成/AI超时/上下文限制/重新总结等机器人运行讨论，以及无实质信息的闲聊；但链接资料、明确进展、任务安排、决策、评审排期、业务风险阻塞、协作要求必须保留。识别 progress(进展与交付)、task_plan(任务安排与分工)、decision(明确结论)、meeting(评审/会议/时间计划)、blocker(已发生阻塞)、risk(潜在延期/产能/优先级风险)、help(明确求助)、collaboration(跨角色协作)、share(链接或资料)、discuss(有业务意义的其他讨论)。同一主题的多条消息必须合并为一个 topic，并列出该主题全部真实 message_ids，短回复若补充同一排期也要并入已有 topic。长消息必须读到末尾，提炼主张、约束、行动和结论，不得整段照抄；每个 title 控制在30至100字，保留编号、负责人、时间、前置条件、结论和限制。管理者关注最多标记 3 个最突出的问题，仅限人力产能、优先级冲突、严重延期/阻塞、跨角色责任失衡、质量底线或关键承诺；普通评审通知不得标记。输出格式：{\"abstract\":\"80至150字的当日整体总结\",\"topics\":[{\"message_ids\":[\"真实消息ID\"],\"type\":\"progress|task_plan|decision|meeting|blocker|risk|help|collaboration|share|discuss\",\"title\":\"30至100字、按主题归并后的中文摘要，不得复制整段原文\",\"related_users\":[\"姓名\"],\"risk_level\":\"low|medium|high|\",\"impact_scope\":\"受影响范围\",\"urls\":[\"完整链接\"],\"manager_attention\":false,\"attention_reason\":\"仅在确需管理者关注时填写\",\"confidence\":0.0}]}。";

    const result = await chatWithDailySummaryTimeout(llm, system, JSON.stringify(payload));
    if (!result.ok || !result.content.trim()) {
        if (store) await store.appendAuditLog("ai_daily_summary_failed", { stage: "classification", reason: result.error || "empty_response", message_count: messages.length });
        return null;
    }

    let raw: any;
    try {
        raw = JSON.parse(extractJson(result.content));
    } catch (exc: any) {
        if (store) await store.appendAuditLog("ai_daily_summary_failed", { stage: "classification", reason: `invalid_json: ${exc.message}`, message_count: messages.length });
        return null;
    }

    const rawItems = Array.isArray(raw?.topics) ? raw.topics : (Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : []));
    if (!Array.isArray(rawItems)) {
        if (store) await store.appendAuditLog("ai_daily_summary_failed", { stage: "classification", reason: "items_not_list", message_count: messages.length });
        return null;
    }

    const messagesById: Record<string, any> = {};
    for (const msg of messages) if (msg.id) messagesById[msg.id] = msg;

    const classified = emptyClassification();
    for (const rawItem of rawItems) {
        if (typeof rawItem !== 'object' || !rawItem) continue;
        const itemType = normalizeSummaryType(rawItem.type);
        const messageIds = messageIdsForTopic(rawItem).filter(messageId => !!messagesById[messageId]);
        const topicMessages = messageIds.map(messageId => messagesById[messageId]);
        const message = topicMessages[0];

        if (!itemType || !message || !topicMessages.length) continue;

        const confidence = parseConfidence(rawItem.confidence);
        if (confidence < 0.6) continue;

        let title = normalizeAiTopicTitle(String(rawItem.title || "").trim(), topicMessages);
        if (confidence < 0.85 && confidence !== 1.0) title = `可能：${title}`;

        const aiResult: any = {
            type: itemType,
            parser: "llm_daily_summary",
            title,
            related_users: stringList(rawItem.related_users),
            risk_level: String(rawItem.risk_level || "").trim(),
            impact_scope: String(rawItem.impact_scope || "").trim(),
            urls: stringList(rawItem.urls),
            url: String(rawItem.url || rawItem.urls?.[0] || "").trim(),
            manager_attention: rawItem.manager_attention === true,
            attention_reason: String(rawItem.attention_reason || "").trim(),
        };
        const item = messageSummaryItem(message, itemType, confidence, "llm_daily_summary", title, aiResult);
        const senderNames = Array.from(new Set(topicMessages.map(topic => String(topic.sender_name || "")).filter(Boolean)));
        const rawText = topicMessages.map(topic => String(topic.text || "")).filter(Boolean).join("\n\n");
        item.source_message_ids = messageIds;
        item.sender_name = senderNames.length === 1 ? senderNames[0] : "多人";
        item.raw_text = rawText;
        item.trace = { ...item.trace, source_message_ids: messageIds, raw_text: rawText, ai_result: aiResult };
        if (aiResult.urls.length || aiResult.url) item.urls = aiResult.urls.length ? aiResult.urls : [aiResult.url];
        classified[summaryBucket(itemType)].push(item);
    }
    return {
        classified,
        abstract: String(raw?.abstract || "").trim() || undefined,
    };
}

async function chatWithDailySummaryTimeout(
    llm: LLMAdapter,
    systemPrompt: string,
    userMessage: string,
): Promise<LLMResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = llm.chat(systemPrompt, userMessage, {
        requestTimeoutMs: DAILY_SUMMARY_LLM_REQUEST_TIMEOUT_MS,
        retryCount: 0,
    }).catch((error: any): LLMResult => ({
        ok: false,
        content: "",
        error: String(error),
    }));
    const deadline = new Promise<LLMResult>((resolve) => {
        timer = setTimeout(() => resolve({
            ok: false,
            content: "",
            error: `daily summary AI step timed out after ${DAILY_SUMMARY_LLM_TIMEOUT_MS}ms`,
        }), DAILY_SUMMARY_LLM_TIMEOUT_MS);
    });

    try {
        return await Promise.race([request, deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function messageSummaryItem(message: any, itemType: string, confidence: number, parser: string = "llm_daily_summary", title?: string, aiResult?: any): any {
    const text = String(message.text || "").trim();
    const t = conciseTopicTitle(title || text);
    const ai = aiResult || { type: itemType, parser, title: t };
    const trace = messageTrace(message, ai, confidence);

    const item: any = {
        type: itemType,
        title: t,
        source_message_ids: trace.source_message_ids,
        source_group_id: trace.source_group_id,
        sender_open_id: trace.sender_open_id,
        sender_name: trace.sender_name,
        sent_at: trace.sent_at,
        raw_text: trace.raw_text,
        ai_result: ai,
        confidence,
        trace
    };
    if (ai.related_users) item.related_users = ai.related_users;
    if (ai.risk_level) item.risk_level = ai.risk_level;
    if (ai.impact_scope) item.impact_scope = ai.impact_scope;
    if (ai.manager_attention) item.manager_attention = true;
    if (ai.attention_reason) item.attention_reason = ai.attention_reason;
    return item;
}

function taskSummaryItem(task: any, messagesById: Record<string, any>): any {
    const item = { ...task };
    const sourceMessageId = item.source_message_id;
    const aiResult = item.ai_result || { type: "task", parser: "structured_record", title: item.title || "" };
    const confidence = item.confidence !== undefined ? item.confidence : 1.0;
    const trace = item.trace || traceFromSource(item, messagesById, aiResult, confidence);

    item.type = "task";
    item.source_message_ids = sourceMessageId ? [sourceMessageId] : [];
    item.ai_result = aiResult;
    item.confidence = confidence;
    item.trace = trace;
    copyTraceToTopLevel(item, trace);
    return item;
}

function updateSummaryItem(update: any, messagesById: Record<string, any>): any {
    const item = { ...update };
    const sourceMessageId = item.source_message_id;
    const aiResult = item.ai_result || { type: item.update_type || "progress", parser: "structured_record" };
    const confidence = item.confidence !== undefined ? item.confidence : 1.0;
    const trace = item.trace || traceFromSource(item, messagesById, aiResult, confidence);

    item.type = item.update_type;
    item.title = item.content || "";
    item.source_message_ids = sourceMessageId ? [sourceMessageId] : [];
    item.ai_result = aiResult;
    item.confidence = confidence;
    item.trace = trace;
    copyTraceToTopLevel(item, trace);
    return item;
}

function riskSummaryItem(task: any, messagesById: Record<string, any>, itemType: string = "risk", referenceDate: Date | string = new Date()): any {
    const item = taskSummaryItem(task, messagesById);
    const policy = overduePolicy(task.due_date, referenceDate);
    item.type = itemType;
    item.overdue_days = policy?.daysOverdue || 0;
    item.overdue_tier = policy?.tier || "";
    item.overdue_label = policy?.label || "";
    item.ai_result = { type: itemType, parser: "structured_record", title: item.title || "", overdue_tier: item.overdue_tier };
    if (item.trace) item.trace.ai_result = item.ai_result;
    return item;
}

function senderName(item: any): string {
    let name = String(item.source_sender_name || item.sender_name || item.creator_name || item.user_name || "").trim();
    if (!name || name.startsWith("ou_") || ["unknown", "undefined", "null"].includes(name.toLowerCase())) name = "未知成员";
    return name;
}

function statusLabel(status: any): string {
    const value = String(status || "").trim();
    if (!value) return "待确认";
    if (STATUS_MAP[value]) return STATUS_MAP[value];
    return /[\u4e00-\u9fff]/.test(value) ? value : "状态待同步";
}

function riskLevelLabel(riskLevel: any): string {
    const value = String(riskLevel || "").trim().toLowerCase();
    const labels: Record<string, string> = {
        low: "低",
        medium: "中",
        high: "高",
        critical: "高",
    };
    if (!value) return "中";
    if (labels[value]) return labels[value];
    return /[\u4e00-\u9fff]/.test(value) ? value : "中";
}

function blockedLongEnough(task: any): boolean {
    if (!task || task.status !== "blocked") return false;
    if (!task.blocked_at) return false;
    const blockedAt = dayjs(task.blocked_at);
    if (!blockedAt.isValid()) return false;
    return dayjs().diff(blockedAt, 'hour') >= 24;
}

function hasAny(text: string, keywords: string[]): boolean {
    return keywords.some(k => text.includes(k));
}

function isIgnorableChatMessage(text: string): boolean {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (/^(好|好的|收到|明白|了解|可以|行|嗯|ok|OK|谢谢)[。.!！~～]*$/.test(normalized)) return true;
    if (/总结一下(?:今天|昨天|本日)?.*日报/.test(normalized) && /机器人|AI 交付助理/.test(normalized)) return true;
    if (normalized.includes("@") && /机器人|AI 交付助理/.test(normalized) && /(日报|日总结|群聊总结|研发总结|每日总结|总结聊天|聊天总结)/.test(normalized)) return true;
    if (/(?:ai|AI|机器人).{0,24}(?:超时|上下文限制)|(?:超时|上下文限制).{0,24}(?:ai|AI|机器人)/.test(normalized) && /(?:日报|总结|重新总结|重试)/.test(normalized)) return true;
    if (/^[{[]/.test(normalized) && /clipped content to top/i.test(normalized)) return true;
    if (/^[{[]/.test(normalized)) {
        try {
            const payload = JSON.parse(normalized);
            if (
                payload && typeof payload === "object" &&
                typeof payload.template === "string" &&
                "divider_text" in payload &&
                (Array.isArray(payload.from_user) || Array.isArray(payload.to_chatters))
            ) return true;
        } catch {}
    }
    return false;
}

function compactTitle(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').replace(/^[ ，,。]+/, "").replace(/[ ，,。]+$/, "");
    return cleaned.length > 1200 ? cleaned.substring(0, 1200) + "..." : cleaned;
}

function conciseTopicTitle(text: string, maxLength: number = 180): string {
    const cleaned = compactTitle(text);
    if (cleaned.length <= maxLength) return cleaned;

    const clauses = Array.from(new Set(cleaned.split(/(?:[。！？；]|\n|——)+/).map(value => value.trim()).filter(Boolean)));
    const important = clauses.filter(value => /(?:必须|不要|需要|建议|计划|安排|完成|推进|确认|确定|可以|风险|阻塞|延期|负责人|评审|开发|上线|发布)/.test(value));
    const selected = important.length
        ? Array.from(new Set([clauses[0], ...important.slice(0, 4)].filter(Boolean)))
        : Array.from(new Set([clauses[0], clauses[clauses.length - 1]].filter(Boolean)));
    const summary = selected.join("；");
    if (summary.length <= maxLength) return summary;
    const headLength = Math.ceil((maxLength - 1) * 0.62);
    return `${summary.slice(0, headLength).trim()}…${summary.slice(-(maxLength - headLength - 1)).trim()}`;
}

function normalizeAiTopicTitle(rawTitle: string, topicMessages: any[]): string {
    const sourceText = topicMessages.map(item => String(item.text || "")).filter(Boolean).join("；");
    const candidate = rawTitle || sourceText;
    const semanticTitle = semanticTitleForKnownBusinessPattern(candidate);
    if (semanticTitle) return semanticTitle;

    const comparableTitle = comparableSummaryText(candidate);
    const comparableSource = comparableSummaryText(sourceText);
    const isVerbatim = comparableTitle.length >= 40 && comparableSource.includes(comparableTitle);
    return conciseTopicTitle(candidate, isVerbatim ? 100 : 120);
}

function semanticTitleForKnownBusinessPattern(text: string): string {
    if (/(?:超纲|超量)/.test(text) && /执行.{0,12}(?:不要打折扣|不打折)/.test(text) && /调研.{0,20}(?:宽度|范围).{0,20}(?:阶段性|缩减|阉割)/.test(text)) {
        return "调研范围可阶段性收缩，但执行质量不能打折；参与需求推进应帮助明确调研方向与产出";
    }
    if (/UI/i.test(text) && /(?:AI.{0,12}图|图.{0,12}(?:确认|看))/i.test(text) && /(?:视觉.{0,12}达标|美化)/.test(text)) {
        return "涉及UI的功能需先提供AI设计图确认，避免视觉不达标；产品侧可协助美化";
    }
    return "";
}

function comparableSummaryText(text: string): string {
    return text.replace(/[\s，,。.!！?？；;：:“”'‘’（）()【】\[\]<>《》@]/g, "").toLowerCase();
}

function isOverdueTaskUpdate(item: any): boolean {
    const updateType = String(item?.update_type || item?.type || "").toLowerCase();
    const content = String(item?.content || item?.title || "");
    return ["overdue", "overdue_reminder", "task_overdue"].includes(updateType) || /任务已超期|任务逾期|已逾期/.test(content);
}

function overdueUpdateSummaryItem(item: any): any {
    const title = item.task_title || String(item.title || item.content || "").replace(/^任务已超期[:：]?\s*/, "");
    const aiResult = {
        ...(item.ai_result || {}),
        type: "risk",
        parser: item.ai_result?.parser || "structured_record",
        title,
        risk_level: item.ai_result?.risk_level || "medium",
    };
    return {
        ...item,
        type: "risk",
        title,
        content: item.content || item.title || "任务已超期",
        ai_result: aiResult,
        risk_level: aiResult.risk_level,
        trace: { ...(item.trace || {}), ai_result: aiResult },
    };
}

function emptyClassification(): Record<string, any[]> {
    return { progress_updates: [], blockers: [], decisions: [], risks: [], helps: [], shares: [], meetings: [], discusses: [] };
}

function messageTrace(message: any, aiResult: any, confidence: number): any {
    const messageId = String(message.id || "");
    return {
        source_group_id: String(message.chat_id || ""),
        source_message_id: messageId,
        source_message_ids: messageId ? [messageId] : [],
        sender_open_id: String(message.sender_open_id || ""),
        sender_name: String(message.sender_name || ""),
        sent_at: String(message.sent_at || ""),
        raw_text: String(message.text || ""),
        ai_result: aiResult,
        confidence
    };
}

function traceFromSource(item: any, messagesById: Record<string, any>, aiResult: any, confidence: number): any {
    const sourceMessageId = item.source_message_id;
    const message = messagesById[sourceMessageId || ""];
    if (message) return messageTrace(message, aiResult, confidence);

    return {
        source_group_id: String(item.source_group_id || ""),
        source_message_id: sourceMessageId || "",
        source_message_ids: sourceMessageId ? [sourceMessageId] : [],
        sender_open_id: String(item.source_sender_open_id || ""),
        sender_name: String(item.source_sender_name || ""),
        sent_at: String(item.source_sent_at || ""),
        raw_text: String(item.raw_text || ""),
        ai_result: aiResult,
        confidence
    };
}

function copyTraceToTopLevel(item: any, trace: any): void {
    if (trace.source_group_id) item.source_group_id = trace.source_group_id;
    if (trace.source_message_ids) item.source_message_ids = trace.source_message_ids;
    if (trace.sender_open_id) item.sender_open_id = trace.sender_open_id;
    if (trace.sender_name) item.sender_name = trace.sender_name;
    if (trace.sent_at) item.sent_at = trace.sent_at;
    if (trace.raw_text) item.raw_text = trace.raw_text;
}

function itemGroupId(item: any, messagesById: Record<string, any>): string {
    if (item.source_group_id) return String(item.source_group_id);
    const sourceMessageId = String(item.source_message_id || "");
    const msg = messagesById[sourceMessageId];
    return msg ? String(msg.chat_id || "") : "";
}

function normalizeSummaryType(value: any): string {
    const type = String(value || "").trim();
    return ["progress", "task_plan", "blocker", "decision", "risk", "help", "collaboration", "share", "meeting", "discuss"].includes(type) ? type : "";
}

function summaryBucket(itemType: string): string {
    const map: Record<string, string> = {
        "progress": "progress_updates",
        "task_plan": "discusses",
        "blocker": "blockers",
        "decision": "decisions",
        "risk": "risks",
        "help": "helps",
        "collaboration": "discusses",
        "share": "shares",
        "meeting": "meetings",
        "discuss": "discusses",
    };
    return map[itemType];
}

function firstMessageId(item: any): string {
    if (item.message_id) return String(item.message_id).trim();
    if (item.source_message_id) return String(item.source_message_id).trim();
    if (Array.isArray(item.source_message_ids) && item.source_message_ids.length > 0) {
        return String(item.source_message_ids[0]).trim();
    }
    return "";
}

function messageIdsForTopic(item: any): string[] {
    const values = Array.isArray(item.message_ids)
        ? item.message_ids
        : Array.isArray(item.source_message_ids)
            ? item.source_message_ids
            : [firstMessageId(item)];
    return Array.from(new Set(values.map((value: any) => String(value || "").trim()).filter(Boolean)));
}

function parseConfidence(value: any): number {
    if (typeof value !== 'number') return 1.0;
    return Math.max(0.0, Math.min(value, 1.0));
}

function stringList(value: any): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(i => String(i || "").trim()).filter(i => i);
}

function extractJson(content: string): string {
    const text = content.trim();
    const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
    if (fenced) return fenced[1];

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end >= start) return text.substring(start, end + 1);
    return text;
}
