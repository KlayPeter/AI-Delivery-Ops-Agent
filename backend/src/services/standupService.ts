import dayjs from 'dayjs';
import { SourceMessage, utcNowIso } from '@/models/types';
import { looksLikeStandup, parseStandup } from '@/services/standup';
import { HandlerContext } from './messageHandler/types';
import { TaskService } from './taskService';

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

    static async handlePrivateMessage(ctx: HandlerContext, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
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

        if (!hasStandupContent(standup) && standupContext && ctx.intentParser?.llm) {
            const llmParsed = await this.parseStandupWithLLM(ctx.intentParser.llm, message.text || "");
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
                    await ctx.feishu.sendPrivateText(message.sender_open_id || "", "我还没识别到站会内容，请按【昨日完成】【今日计划】【阻塞/需要帮助】【风险/可能延期】【需要决策】补充后再发送。");
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

    static async parseStandupWithLLM(llm: any, text: string): Promise<any> {
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
                if (parsed.is_standup === false || String(parsed.is_standup).toLowerCase() === "false") return null;
                return parsed;
            }
        } catch (e) {
            console.error("LLM parse standup error", e);
        }
        return null;
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
