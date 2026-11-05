import dayjs from 'dayjs';
import { SourceMessage, utcNowIso } from '@/models/types';
import { looksLikeStandup, parseStandup } from '@/services/standup';
import { HandlerContext } from './messageHandler/types';
import { TaskService } from './taskService';
import { aiFailureLabel, classifyAiFailure, type AiFailure } from '@/platform/aiDegradation';
import { zonedClock } from '@/core/scheduleTime';

interface StandupAiParseResult {
    parsed: any | null;
    failure?: AiFailure;
}

export class StandupService {
    static isGroupEnabled(group: any): boolean {
        const schedule = group?.schedule || {};
        return schedule.module_standup_enabled !== false
            && schedule.standup_push_enabled !== false;
    }

    static buildSummaryView(standups: any[], members: any[] = []): any {
        const activeMembers = members.filter(member => member?.is_active !== false && member?.open_id);
        const submittedIds = new Set(standups.map(standup => standup.open_id));
        const missingMembers = activeMembers.filter(member => !submittedIds.has(member.open_id));
        const people = standups.map(standup => ({
            open_id: standup.open_id || "",
            name: standup.user_name || "未知成员",
            yesterday_done: standup.yesterday_done || [],
            today_plan: standup.today_plan || [],
            blockers: standup.blockers || [],
            risks: standup.risks || [],
            decisions_needed: standup.decisions_needed || [],
        }));
        const entries = (key: string) => people.flatMap(person => ((person as any)[key] || []).map((text: string) => ({ name: person.name, text })));
        const todayEntries = entries("today_plan");

        return {
            submitted: standups.length,
            total_members: activeMembers.length,
            missing: missingMembers.length,
            missing_names: missingMembers.map(member => member.name),
            people,
            team_focus: todayEntries.slice(0, 3),
            yesterday_entries: entries("yesterday_done"),
            today_entries: todayEntries,
            blocker_entries: entries("blockers"),
            risk_entries: entries("risks"),
            decision_entries: entries("decisions_needed"),
            today_plan: todayEntries.map(entry => entry.text),
            blockers: entries("blockers").map(entry => entry.text),
            risks: entries("risks").map(entry => entry.text),
            decisions_needed: entries("decisions_needed").map(entry => entry.text),
        };
    }

    static isTaskStandupEnabled(group: any): boolean {
        const schedule = group?.schedule || {};
        return schedule.module_standup_enabled !== false
            && schedule.task_standup_enabled === true;
    }

    static async handleTaskStandupMessage(ctx: HandlerContext, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        if (replyContext?.context_type === "standup_commitment_prompt") {
            return this.handleCommitmentReport(ctx, message, source, replyContext);
        }
        if (source !== "group") return null;

        const group = ctx.config?.groups?.find((item: any) => item.chat_id === message.chat_id);
        if (!this.isTaskStandupEnabled(group)) return null;
        const parsed = parseCommitment(
            message,
            ctx.config?.feishu?.bot_open_id || "",
            replyContext?.context_type === "task_standup_template",
        );
        if (!parsed) return null;

        message.ai_result = { type: "standup_commitment", parser: "deterministic_rule", title: parsed.title, due_at: parsed.dueAt };
        message.confidence = 1;
        await ctx.store.saveSourceMessage(message);
        const task = await TaskService.createStandupCommitment(ctx, message, parsed);
        const result = await ctx.feishu.sendReplyText(message.id, `已记录任务型站会事项：\n\n任务：${task.title}\n负责人：${task.primary_owner_name}\n交付时间：${formatCommitmentTime(task.due_date)}\n\n到时间后我会在本群提醒负责人汇报。`);
        await ctx.store.appendAuditLog("standup_commitment_created", {
            task_id: task.id,
            group_id: task.source_group_id,
            owner_open_id: task.primary_owner_open_id,
            due_at: task.due_date,
            receipt_message_id: result?.message_id,
        });
        return { handled: true, action: "standup_commitment_created", task_id: task.id };
    }

    static async handleCommitmentReport(ctx: HandlerContext, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        const task = await ctx.store.getTask(replyContext.task_id || "");
        if (!task || !TaskService.isStandupCommitment(task)) return null;

        const botOpenId = ctx.config?.feishu?.bot_open_id || "";
        const mismatchedMention = (message.mentions || [])
            .filter(item => item.open_id && item.open_id !== botOpenId)
            .find(item => item.open_id !== message.sender_open_id);
        if (mismatchedMention) {
            const text = `请由被@的负责人 ${mismatchedMention.name || task.primary_owner_name} 本人引用机器人提醒回复，当前回复人是 ${message.sender_name || "其他成员"}，本次未更新任务。`;
            if (source === "group") await ctx.feishu.sendReplyText(message.id, text);
            else await ctx.feishu.sendPrivateText(message.sender_open_id || "", text);
            await ctx.store.appendAuditLog("standup_commitment_report_rejected", {
                task_id: task.id,
                group_id: task.source_group_id,
                reason: "mentioned_owner_mismatch",
                mentioned_open_id: mismatchedMention.open_id,
                reply_sender_open_id: message.sender_open_id,
            });
            return { handled: true, action: "standup_commitment_report_rejected", reason: "mentioned_owner_mismatch" };
        }

        if (message.sender_open_id !== task.primary_owner_open_id) {
            const text = `这项任务需要由负责人 ${task.primary_owner_name} 本人引用机器人提醒回复，本次未更新任务。`;
            if (source === "group") await ctx.feishu.sendReplyText(message.id, text);
            else await ctx.feishu.sendPrivateText(message.sender_open_id || "", text);
            await ctx.store.appendAuditLog("standup_commitment_report_rejected", {
                task_id: task.id,
                group_id: task.source_group_id,
                reason: "sender_owner_mismatch",
                task_owner_open_id: task.primary_owner_open_id,
                reply_sender_open_id: message.sender_open_id,
            });
            return { handled: true, action: "standup_commitment_report_rejected", reason: "sender_owner_mismatch" };
        }

        const report = parseCommitmentReport(message.text || "", message.sent_at);
        if (report.status === "delayed" && !report.nextDueAt) {
            const prompt = `已识别到“${task.title}”需要延期，请补充新的交付时间，例如：延期到明天上午10点。`;
            if (source === "group") await ctx.feishu.sendReplyText(message.id, prompt);
            else await ctx.feishu.sendPrivateText(message.sender_open_id || "", prompt);
            return { handled: true, action: "standup_commitment_due_time_required", task_id: task.id };
        }
        const updated = await TaskService.reportStandupCommitment(ctx, task, message, report);
        const statusText = commitmentStatusLabel(report.status);
        const nextText = report.nextDueAt ? `，新的交付时间为 ${formatCommitmentTime(report.nextDueAt)}` : "";
        const receipt = `已记录“${task.title}”的进展：${statusText}${nextText}。`;
        if (source === "group") await ctx.feishu.sendReplyText(message.id, receipt);
        else await ctx.feishu.sendPrivateText(message.sender_open_id || "", receipt);
        await ctx.store.appendAuditLog("standup_commitment_reported", {
            task_id: updated.id,
            group_id: updated.source_group_id,
            owner_open_id: message.sender_open_id,
            status: report.status,
            next_due_at: report.nextDueAt,
        });
        return { handled: true, action: "standup_commitment_reported", task_id: updated.id, status: report.status };
    }

    static async handlePrivateMessage(ctx: HandlerContext, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        const commitment = await this.handleTaskStandupMessage(ctx, message, source, replyContext);
        if (commitment) return commitment;
        if (source !== "private") {
            if (!looksLikeStandup(message.text || "")) return null;
            await ctx.feishu.sendReplyText(message.id || "", "已识别为站会内容。请在机器人私聊中回复今天对应的【站会提醒】后重新发送，本条不会作为任务状态更新或站会提交处理。");
            await ctx.store.appendAuditLog("standup_group_submission_rejected", { message_id: message.id, chat_id: message.chat_id, sender_open_id: message.sender_open_id });
            return { handled: true, action: "standup_group_submission_rejected" };
        }

        const standupContext = await this.resolveContext(ctx, message, replyContext);
        if (standupContext && standupContext.context_type === "ambiguous") {
            await ctx.feishu.sendPrivateText(message.sender_open_id || "", "已识别为站会内容，但您属于多个项目组，无法确定归属群组。本次不会保存或计入提交；请长按或引用具体的【站会提醒消息】后重新发送，谢谢！");
            await ctx.store.appendAuditLog("standup_ambiguous", { open_id: message.sender_open_id, message_id: message.id, text: message.text });
            return { handled: true, action: "standup_ambiguous" };
        }
        if (standupContext && standupContext.context_type === "standup_group_unresolved") {
            await ctx.feishu.sendPrivateText(message.sender_open_id || "", "已识别为站会内容，但无法关联到项目群。本次不会保存或计入提交；请直接回复今天对应的【站会提醒】后重新发送。若问题持续，请联系管理员检查成员绑定。");
            await ctx.store.appendAuditLog("standup_group_unresolved", { open_id: message.sender_open_id, message_id: message.id, text: message.text });
            return { handled: true, action: "standup_group_unresolved" };
        }

        const isStandupPromptReply = replyContext && replyContext.context_type === "standup_prompt";
        let isStandup = looksLikeStandup(message.text || "") || isStandupPromptReply;
        let standup = parseStandup(message.sender_open_id || "", message.sender_name || "", message.text || "", message.id || "", standupDateFromContext(standupContext));
        let aiParseFailure: AiFailure | undefined;

        if (!hasStandupContent(standup) && standupContext && ctx.intentParser?.llm) {
            const llmResult = await this.parseStandupWithLLM(ctx.intentParser.llm, message.text || "");
            const llmParsed = llmResult.parsed;
            aiParseFailure = llmResult.failure;
            if (aiParseFailure) {
                await Promise.resolve(ctx.store.appendAuditLog("ai_standup_parse_failed", {
                    message_id: message.id,
                    open_id: message.sender_open_id,
                    group_id: standupContext?.metadata?.group_id || "",
                    category: aiParseFailure.category,
                    error: aiParseFailure.error,
                    fallback: "structured_rule",
                })).catch(() => {});
            }
            if (llmParsed && (llmParsed.yesterday_done?.length > 0 || llmParsed.today_plan?.length > 0 || llmParsed.blockers?.length > 0 || llmParsed.risks?.length > 0)) {
                isStandup = true;
                standup.yesterday_done = llmParsed.yesterday_done || [];
                standup.today_plan = llmParsed.today_plan || [];
                standup.blockers = llmParsed.blockers || [];
                standup.risks = llmParsed.risks || [];
                standup.decisions_needed = llmParsed.decisions_needed || [];
            }
        }

        if (isStandup) {
            if (!hasStandupContent(standup)) {
                if (isStandupPromptReply) {
                    const failurePrefix = aiParseFailure
                        ? `${aiFailureLabel(aiParseFailure.category)}，本次未能完成自然语言解析；固定格式规则也`
                        : "我还";
                    await ctx.feishu.sendPrivateText(message.sender_open_id || "", `${failurePrefix}没识别到站会内容，请按【昨日完成】【今日计划】【阻塞/需要帮助】【风险/可能延期】【需要决策】补充后再发送。`);
                    await ctx.store.appendAuditLog("standup_empty_rejected", { open_id: message.sender_open_id, message_id: message.id, text: message.text });
                    return { handled: true, action: "standup_empty_rejected" };
                }
                return null;
            }

            const groupId = standupContext?.metadata?.group_id || "";
            if (!groupId) {
                await ctx.feishu.sendPrivateText(message.sender_open_id || "", "已识别为站会内容，但无法关联到项目群。本次不会保存或计入提交；请直接回复今天对应的【站会提醒】后重新发送。");
                await ctx.store.appendAuditLog("standup_group_unresolved", { open_id: message.sender_open_id, message_id: message.id, text: message.text });
                return { handled: true, action: "standup_group_unresolved" };
            }

            standup.ai_result = { type: "standup", parser: "structured_or_natural_language" };
            standup.source_group_id = groupId;
            standup.id = `standup-${standup.date}-${groupId}-${standup.open_id}`;
            standup.source_sender_open_id = message.sender_open_id;
            standup.source_sender_name = message.sender_name;
            standup.source_sent_at = message.sent_at;

            await ctx.store.saveStandup(standup);
            const linked = await this.linkToTasks(ctx, standup, message);
            const group = ctx.config.groups.find(g => g.chat_id === groupId);
            const groupName = `【${group?.name || groupId}】的`;
            const receipt = await ctx.feishu.sendPrivateText(message.sender_open_id || "", `已收到${groupName}今日站会，谢谢。`);
            if (receipt.message_id) {
                await ctx.store.saveBotMessageContext({
                    message_id: receipt.message_id,
                    context_type: "standup_receipt",
                    created_at: utcNowIso(),
                    chat_id: receipt.chat_id || "",
                    chat_type: "p2p",
                    target_open_id: message.sender_open_id || "",
                    metadata: { date: standup.date, group_id: groupId, standup_id: standup.id },
                });
            }
            const contextResolution = replyContext
                ? "quoted_bot_message"
                : ["standup_prompt", "standup_receipt"].includes(standupContext?.context_type)
                    ? "same_day_prompt"
                    : "single_group_membership";
            await ctx.store.appendAuditLog("standup_saved", {
                open_id: standup.open_id,
                user_name: standup.user_name,
                group_id: groupId,
                date: standup.date,
                context_resolution: contextResolution,
                standup_id: standup.id,
                linked_task_ids: linked,
            });
            return { handled: true, action: "standup_saved", standup_id: standup.id, linked_task_ids: linked };
        }
        return null;
    }

    static async resolveContext(ctx: HandlerContext, message: SourceMessage, replyContext: any): Promise<any> {
        if (replyContext && ["standup_prompt", "standup_receipt"].includes(replyContext.context_type)) {
            return replyContext.metadata?.group_id ? replyContext : { context_type: "standup_group_unresolved" };
        }

        const textLooksLikeStandup = looksLikeStandup(message.text || "");
        if (!textLooksLikeStandup || !message.sender_open_id) return replyContext;

        const today = dayjs(message.sent_at || new Date()).format('YYYY-MM-DD');
        const contexts = await ctx.store.listBotMessageContexts();
        const candidateContexts = contexts
            .filter((context: any) => ["standup_prompt", "standup_receipt"].includes(context.context_type))
            .filter((context: any) => context.target_open_id === message.sender_open_id)
            .filter((context: any) => context.metadata?.date === today)
            .sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));

        const contextByGroup = new Map<string, any>();
        for (const c of candidateContexts) {
            const gid = c.metadata?.group_id;
            if (gid && !contextByGroup.has(gid)) {
                contextByGroup.set(gid, c);
            }
        }

        const uniqueGroupIds = Array.from(contextByGroup.keys());
        if (uniqueGroupIds.length === 1) {
            return contextByGroup.get(uniqueGroupIds[0]);
        }

        if (uniqueGroupIds.length > 1) {
            return { context_type: "ambiguous" };
        }

        const memberGroups = ctx.config.groups.filter((group: any) =>
            (group.members || []).some((member: any) => member.open_id === message.sender_open_id && member.is_active !== false)
        );
        if (memberGroups.length === 1) {
            return {
                context_type: "standup_membership",
                metadata: { date: today, group_id: memberGroups[0].chat_id },
            };
        }

        return memberGroups.length > 1
            ? { context_type: "ambiguous" }
            : { context_type: "standup_group_unresolved" };
    }

    static async parseStandupWithLLM(llm: any, text: string): Promise<StandupAiParseResult> {
        const prompt = `你是一个站会内容解析助手。用户发来了一段话，请首先判断这段话是否真的是每日工作站会汇报。
如果只是普通的问句、闲聊、或者对系统的疑问（例如"我提交了，咋没有我的名字"、"为什么没收到"等），请将 is_standup 设为 false，其他字段为空数组。

如果是真实的工作内容汇报，请将 is_standup 设为 true，并从中提取以下5个维度的信息：
1. yesterday_done (昨日完成/已完成事项)
2. today_plan (今日计划/准备做的事项/今日工作)
3. blockers (阻塞/需要帮助/卡点)
4. risks (风险/可能延期)
5. decisions_needed (需要决策)

返回严格的JSON格式，例如：
{"is_standup":true,"yesterday_done":["修了两个bug"],"today_plan":["继续联调"],"blockers":[],"risks":[],"decisions_needed":[]}`;
        try {
            const res = await llm.chat(prompt, text);
            if (res.ok && res.content) {
                let content = res.content.trim();
                if (content.startsWith("\`\`\`json")) {
                    content = content.replace(/^\`\`\`json/, "").replace(/\`\`\`$/, "").trim();
                } else if (content.startsWith("\`\`\`")) {
                    content = content.replace(/^\`\`\`/, "").replace(/\`\`\`$/, "").trim();
                }
                const parsed = JSON.parse(content);
                if (parsed.is_standup === false || String(parsed.is_standup).toLowerCase() === "false") return { parsed: null };
                return { parsed };
            }
            return { parsed: null, failure: classifyAiFailure(res.error || "empty_response") };
        } catch (e) {
            return { parsed: null, failure: classifyAiFailure(e) };
        }
    }

    static async linkToTasks(ctx: HandlerContext, standup: any, message: SourceMessage): Promise<string[]> {
        const linked: string[] = [];
        const seen = new Set<string>();

        if (typeof ctx.store.deleteStandupTaskUpdates === "function") {
            await ctx.store.deleteStandupTaskUpdates(standup.id);
        }

        const progressSections = [
            { key: "yesterday_done", label: "昨日完成", items: standup.yesterday_done || [] },
            { key: "today_plan", label: "今日计划", items: standup.today_plan || [] },
        ];
        for (const section of progressSections) {
            for (const item of section.items) {
                const taskData = await this.matchTask(ctx, item, standup.open_id);
                if (!taskData) continue;

                await TaskService.saveUpdate(ctx, taskData, standup.open_id, standup.user_name, "progress", `任务：【${taskData.title}】${section.label}：${item}`, "standup", message.id, {
                    standup_id: standup.id,
                    standup_section: section.key,
                });
                if (!seen.has(taskData.id)) {
                    linked.push(taskData.id);
                    seen.add(taskData.id);
                }
            }
        }

        for (const item of (standup.blockers || [])) {
            const taskData = await this.matchTask(ctx, item, standup.open_id);
            if (!taskData) continue;

            await TaskService.saveUpdate(ctx, taskData, standup.open_id, standup.user_name, "standup_blocker", `任务：【${taskData.title}】站会阻塞：${item}`, "standup", message.id, { standup_id: standup.id });
            if (!seen.has(taskData.id)) {
                linked.push(taskData.id);
                seen.add(taskData.id);
            }
        }

        return linked;
    }

    static async missingMembers(config: any, store: any, groupId: string, day: Date): Promise<any[]> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const missing: any[] = [];

        for (const group of config.groups.filter((g: any) => g.chat_id === groupId)) {
            const standups = await this.listGroupSubmissions(config, store, dateText, group);
            const submitted = new Set(standups.map((s: any) => s.open_id));
            for (const member of group.members) {
                if (member.is_active && !submitted.has(member.open_id)) {
                    missing.push(member);
                }
            }
        }
        return missing;
    }

    static async listGroupSubmissions(config: any, store: any, dateText: string, group: any): Promise<any[]> {
        const groupOpenIds = new Set(group.members.map((m: any) => m.open_id));
        const submittedByOpenId = new Map<string, any>();

        for (const standup of await store.listStandups(dateText, group.chat_id)) {
            if (groupOpenIds.has(standup.open_id)) submittedByOpenId.set(standup.open_id, standup);
        }

        const memberGroupCount: Record<string, number> = {};
        for (const configuredGroup of config.groups) {
            for (const member of configuredGroup.members) {
                memberGroupCount[member.open_id] = (memberGroupCount[member.open_id] || 0) + 1;
            }
        }

        for (const standup of await store.listStandups(dateText, null)) {
            if (standup.source_group_id) continue;
            if (!groupOpenIds.has(standup.open_id)) continue;
            if (memberGroupCount[standup.open_id] !== 1) continue;
            if (!submittedByOpenId.has(standup.open_id)) submittedByOpenId.set(standup.open_id, standup);
        }

        return Array.from(submittedByOpenId.values());
    }

    static async listLateGroupSubmissions(config: any, store: any, dateText: string, group: any, after: Date): Promise<any[]> {
        const cutoff = dayjs(after);
        if (!cutoff.isValid()) return [];
        const submissions = await this.listGroupSubmissions(config, store, dateText, group);
        return submissions.filter((standup: any) => {
            const submittedAt = dayjs(standup.submitted_at || standup.source_sent_at);
            return submittedAt.isValid() && submittedAt.isAfter(cutoff);
        });
    }

    static async listTaskCommitments(store: any, dateText: string, group: any): Promise<any[]> {
        const groupMemberIds = new Set((group.members || []).map((member: any) => member.open_id));
        const timeZone = group.schedule?.overdue_scan_timezone || "Asia/Shanghai";
        const businessDateOf = (value: unknown): string => zonedClock(String(value || ""), timeZone)?.date || "";
        const tasks = (await store.listTasks()).filter((task: any) => {
            return TaskService.isStandupCommitment(task)
                && task.source_group_id === group.chat_id
                && businessDateOf(task.source_sent_at || task.created_at) === dateText;
        });
        const updates = typeof store.listTaskUpdates === "function" ? await store.listTaskUpdates() : [];
        const updatesByTask = new Map<string, any[]>();
        for (const update of updates) {
            if (!update.metadata?.standup_commitment) continue;
            const current = updatesByTask.get(update.task_id) || [];
            current.push(update);
            updatesByTask.set(update.task_id, current);
        }

        return tasks
            .filter((task: any) => groupMemberIds.size === 0 || groupMemberIds.has(task.primary_owner_open_id))
            .map((task: any) => {
                const latestUpdate = (updatesByTask.get(task.id) || [])
                    .filter((update: any) => businessDateOf(update.created_at) === dateText)
                    .sort((left: any, right: any) => String(right.created_at || "").localeCompare(String(left.created_at || "")))[0];
                const reportStatus = latestUpdate?.metadata?.report_status;
                const status = latestUpdate?.update_type === "standup_unreported"
                    ? "unreported"
                    : reportStatus || (latestUpdate?.update_type === "standup_committed" ? "pending" : "in_progress");
                return {
                    id: task.id,
                    title: task.title,
                    owner_open_id: task.primary_owner_open_id,
                    owner_name: task.primary_owner_name,
                    due_at: task.due_date || null,
                    status,
                    status_label: ({
                        pending: "待交付",
                        unreported: "未完成（未汇报）",
                        completed: "已完成",
                        in_progress: "进行中",
                        blocked: "有阻塞",
                        delayed: "已延期",
                    } as Record<string, string>)[status] || "进行中",
                    reported: ["completed", "in_progress", "blocked", "delayed"].includes(status),
                    content: latestUpdate?.content || "",
                    created_at: task.source_sent_at || task.created_at,
                };
            })
            .sort((left: any, right: any) => String(left.due_at || "").localeCompare(String(right.due_at || "")));
    }

    static async matchTask(ctx: HandlerContext, item: string, openId: string): Promise<any> {
        let bestTask = null;
        let bestScore = 0.0;

        for (const task of await ctx.store.listTasks()) {
            if (["accepted", "cancelled"].includes(task.status || "")) continue;
            if (openId !== task.primary_owner_open_id && !(task.assignee_open_ids || []).includes(openId)) continue;

            const score = this.titleOverlapScore(item, task.title || "");
            if (score > bestScore) {
                bestTask = task;
                bestScore = score;
            }
        }
        return bestScore >= 0.45 ? bestTask : null;
    }

    private static titleOverlapScore(text: string, title: string): number {
        const normalizedText = this.normalizeMatchText(text);
        const normalizedTitle = this.normalizeMatchText(title);

        if (!normalizedText || !normalizedTitle) return 0.0;
        if (normalizedTitle.includes(normalizedText) || normalizedText.includes(normalizedTitle)) return 1.0;

        const titleChars = new Set(normalizedTitle.split(''));
        const textChars = new Set(normalizedText.split(''));
        let common = 0;
        for (const char of titleChars) if (textChars.has(char)) common++;

        if (common < 4) return 0.0;
        return common / titleChars.size;
    }

    private static normalizeMatchText(value: string): string {
        let text = value.replace(/[\s，,。；;：:、/\\-]+/g, "");
        const tokens = ["任务", "父", "子", "昨天", "今日", "今天", "计划", "继续", "准备", "已经", "已完成", "完成了", "完成"];
        for (const token of tokens) text = text.split(token).join("");
        return text;
    }
}

function parseCommitment(message: SourceMessage, botOpenId: string, allowQuotedTemplate: boolean = false): { title: string; ownerOpenId: string; ownerName: string; dueAt: string } | null {
    const text = String(message.text || "").trim();
    const mentions = message.mentions || [];
    if (!mentions.some(item => item.open_id === botOpenId)) return null;
    if (/(?:创建|新建|同步).{0,8}(?:TAPD|任务|需求)|(?:TAPD).{0,8}(?:任务|需求)/i.test(text)) return null;
    if (!/(?:交付|完成|提交|汇报|产出|给到)/.test(text)) return null;
    const dueAt = parseCommitmentDueAt(text, message.sent_at);
    if (!dueAt) return null;

    const owner = mentions.find(item => item.open_id !== botOpenId) || {
        open_id: message.sender_open_id,
        name: message.sender_name,
    };
    let title = text;
    for (const mention of mentions) {
        title = title.replace(new RegExp(`@?${escapeRegExp(mention.name)}`, "g"), " ");
        if (mention.key) title = title.replace(new RegExp(escapeRegExp(mention.key), "g"), " ");
    }
    if (allowQuotedTemplate) {
        title = title.replace(/(?:任务|事项|负责人|执行人|责任人|交付时间|截止时间|完成时间)\s*[:：]?/g, " ");
    }
    title = title
        .replace(/(?:今天|今日|明天|明日|明早|明晚|后天)?\s*(?:上午|早上|中午|下午|晚上|今晚)?\s*\d{1,2}(?::\d{2}|点(?:半|\d{1,2}分?)?)\s*(?:前|之前|左右)?/g, " ")
        .replace(/^(?:请|麻烦|辛苦)?\s*/, "")
        .replace(/(?:交付|完成|提交|汇报|产出|给到)(?:任务)?\s*[:：]?/g, " ")
        .replace(/\b(?:任务)\b/gi, " ")
        .replace(/[，,。；;]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!title) return null;
    return { title, ownerOpenId: owner.open_id, ownerName: owner.name || message.sender_name, dueAt };
}

function parseCommitmentDueAt(text: string, reference?: string): string | null {
    const match = /(?:(今天|今日|明天|明日|明早|明晚|后天)\s*)?(上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})(?::(\d{2})|点(半|\d{1,2}分?)?)/.exec(text);
    if (!match) return null;
    const base = dayjs(reference || new Date());
    const dayToken = match[1] || "今天";
    const period = match[2] || (dayToken === "明早" ? "早上" : dayToken === "明晚" ? "晚上" : "");
    let hour = Number(match[3]);
    let minute = Number(match[4] || 0);
    if (match[5] === "半") minute = 30;
    else if (match[5]) minute = Number(match[5].replace("分", ""));
    if (["下午", "晚上", "今晚"].includes(period) && hour < 12) hour += 12;
    if (period === "中午" && hour < 11) hour += 12;
    if (hour > 23 || minute > 59) return null;
    const offset = ["明天", "明日", "明早", "明晚"].includes(dayToken) ? 1 : dayToken === "后天" ? 2 : 0;
    let due = base.add(offset, "day").hour(hour).minute(minute).second(0).millisecond(0);
    if (!match[1] && !due.isAfter(base)) due = due.add(1, "day");
    return due.isValid() ? due.toISOString() : null;
}

function parseCommitmentReport(text: string, reference?: string): { status: "completed" | "in_progress" | "blocked" | "delayed"; content: string; nextDueAt?: string } {
    const content = text.trim();
    if (/(?:延期|延后|推迟|改到|改为|做不完)/.test(content)) {
        return { status: "delayed", content, nextDueAt: parseCommitmentDueAt(content, reference) || undefined };
    }
    if (/(?:阻塞|卡住|卡在|缺少|还没给|等待.+(?:提供|确认|回复))/.test(content)) return { status: "blocked", content };
    if (/(?:未完成|没完成|进行中|还在|预计|尚未)/.test(content)) return { status: "in_progress", content };
    if (/(?:已完成|完成了|完成|已交付|提交了|已提交|搞定|发给|交给)/.test(content)) return { status: "completed", content };
    return { status: "in_progress", content };
}

function formatCommitmentTime(value?: string | null): string {
    const parsed = dayjs(value || "");
    return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : "未设置";
}

function commitmentStatusLabel(status: string): string {
    return ({ completed: "已完成", in_progress: "进行中", blocked: "有阻塞", delayed: "已延期" } as Record<string, string>)[status] || "进行中";
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStandupContent(standup: any): boolean {
    return [
        standup.yesterday_done,
        standup.today_plan,
        standup.blockers,
        standup.risks,
        standup.decisions_needed,
    ].some((items: any) => Array.isArray(items) && items.length > 0);
}

function standupDateFromContext(replyContext: any): Date {
    const dateText = replyContext?.metadata?.date;
    if (typeof dateText === "string" && dateText) {
        const parsed = dayjs(dateText);
        if (parsed.isValid()) return parsed.toDate();
    }
    return new Date();
}
