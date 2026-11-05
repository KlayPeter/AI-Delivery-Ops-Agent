import * as fs from 'fs';
import * as path from 'path';
import { PrismaStore } from '@/core/storage';
import { DashboardArtifact, utcNowIso } from '@/models/types';
import { TaskService, type ProjectTaskSyncResult } from '@/services/taskService';
import { taskBelongsToMembers } from '@/services/taskScope';
import dayjs from 'dayjs';
import { randomUUID } from 'node:crypto';
import { overduePolicy } from '@/domains/task/overduePolicy';
import { StandupService } from '@/services/standupService';

const STATUS_LABELS: Record<string, string> = {
    "pending_primary_owner": "待指定主负责人",
    "pending_confirmation": "待负责人确认",
    "requirement": "需求",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "development_completed": "开发完成",
    "blocked": "阻塞",
    "owner_marked_done": "转测试",
    "testing": "测试进行中",
    "accepted": "已验收",
    "cancelled": "已取消",
    "overdue": "已超期",
};

const DASHBOARD_STATUS_COLORS: Record<string, string> = {
    pending_primary_owner: '#aec1d3',
    pending_confirmation: '#aec1d3',
    requirement: '#f06292',
    confirmed: '#4d9bff',
    in_progress: '#4d9bff',
    development_completed: '#ffd477',
    owner_marked_done: '#c5a4ff',
    testing: '#69ddd3',
    accepted: '#51d292',
    blocked: '#ff8585',
    overdue: '#ffb86f',
    cancelled: '#aec1d3',
};

const STATUS_SORT: Record<string, number> = { "blocked": 0, "overdue": 1, "pending_primary_owner": 2, "pending_confirmation": 3, "in_progress": 4, "development_completed": 5, "owner_marked_done": 6, "testing": 7 };
const PRIORITY_SORT: Record<string, number> = { "P0": 0, "P1": 1, "P2": 2, "P3": 3 };
type WorkloadCategory = "requirement" | "development" | "testing";

function workloadCategory(task: any): WorkloadCategory {
    const workflow = task.trace?.workflow || {};
    const phase = String(task.effective_phase || workflow.phase || "").trim();
    const status = String(task.status || "").trim().toLowerCase();
    if (phase === "testing" && workflow.substate === "pending_product_acceptance") return "requirement";
    if (["owner_marked_done", "testing"].includes(status)) return "testing";
    if (["pending_primary_owner", "pending_confirmation", "requirement"].includes(status)) return "requirement";
    if (["transfer_test", "testing"].includes(phase)) return "testing";
    if (["development", "development_completed"].includes(phase)) return "development";
    if (["draft", "requirement"].includes(phase)) return "requirement";

    if (["confirmed", "in_progress", "development_completed", "blocked"].includes(status)) return "development";

    const workitemType = String(task.trace?.tapd?.workitem_type_key || task.trace?.tapd?.workitem_type || "").trim().toUpperCase();
    return ["DEVELOP", "ARTS"].includes(workitemType) ? "development" : "requirement";
}

function escapeHtml(unsafe: any): string {
    return String(unsafe ?? "")
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export class DashboardService {
    private store: PrismaStore;
    private dataDir: string;
    private projectName: string;
    private publicBaseUrl: string;

    constructor(store: PrismaStore, dataDir: string, projectName: string, publicBaseUrl: string = "") {
        this.store = store;
        this.dataDir = dataDir;
        this.projectName = projectName;
        this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    }

    async generateForGroup(group: any, day: Date = new Date(), highlights?: string[]): Promise<DashboardArtifact> {
        return this.generateForProject([group], day, undefined, highlights);
    }

    async generateForProject(groups: any[], day: Date = new Date(), sync?: ProjectTaskSyncResult, highlights?: string[]): Promise<DashboardArtifact> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const allTasks = await this.store.listTasks();
        const group = groups[0];
        if (!group) throw new Error("看板缺少目标群配置");
        const hierarchy = TaskService.projectHierarchy(allTasks);
        const taskById = new Map(allTasks.map((task: any) => [task.id, task]));
        const activeTasks = allTasks.filter((task: any) => taskBelongsToMembers(task, group.members || []));

        const memberById = new Map<string, any>();
        for (const currentGroup of [group]) {
            for (const member of (currentGroup.members || [])) {
                if (member.is_active !== false && member.open_id) memberById.set(member.open_id, member);
            }
        }
        const standupByMember = new Map<string, any>();
        for (const currentGroup of [group]) {
            const groupStandups = await this.store.listStandups(dateText, currentGroup.chat_id);
            for (const standup of groupStandups) {
                if (!memberById.has(standup.open_id)) continue;
                const existing = standupByMember.get(standup.open_id);
                if (!existing || (standup.submitted_at || "") > (existing.submitted_at || "")) {
                    standupByMember.set(standup.open_id, { ...standup, group_name: currentGroup.name });
                }
            }
        }
        const standups = Array.from(standupByMember.values());

        const activeTaskIds = new Set(activeTasks.map((task: any) => task.id));
        const allUpdates = await this.store.listTaskUpdates();
        const latestUpdateByTask = new Map<string, any>();
        for (const update of allUpdates) {
            if (!activeTaskIds.has(update.task_id)) continue;
            const existing = latestUpdateByTask.get(update.task_id);
            if (!existing || (update.created_at || "") > (existing.created_at || "")) latestUpdateByTask.set(update.task_id, update);
        }
        const tasks = this.sortTaskTree(activeTasks.map((task: any) => {
            const hierarchyState = hierarchy.get(task);
            const completionSource = hierarchyState.completion_source_id ? taskById.get(hierarchyState.completion_source_id) : undefined;
            return this.enrichTask(task, dateText, latestUpdateByTask.get(task.id), hierarchyState, completionSource);
        }));
        const updates = allUpdates.filter((u: any) => activeTaskIds.has(u.task_id) && (u.created_at || "").startsWith(dateText));
        const stats = this.buildStats(tasks, standups, dateText, memberById.size);
        const resolvedHighlights = highlights || this.defaultHighlights(tasks, standups);

        const dashboardData = {
            date: dateText,
            project_name: this.projectName,
            group_name: group.name || group.chat_id,
            group_id: group.chat_id,
            stats,
            highlights: resolvedHighlights,
            tasks,
            standups,
            updates,
            status_distribution: this.statusDistribution(tasks),
            blockers: this.buildBlockers(tasks, standups),
            risks: this.buildRisks(tasks, standups),
            standup_summary: this.buildStandupSummary(standups, memberById),
            burndown: this.buildBurndown(tasks.filter(task => task.is_leaf), day),
            workload: this.buildWorkload(tasks, memberById),
            month_calendar: this.buildMonthCalendar(tasks, day),
        };

        const dashboardsDir = path.join(this.dataDir, "dashboards");
        if (!fs.existsSync(dashboardsDir)) fs.mkdirSync(dashboardsDir, { recursive: true });

        const snapshotKey = `${dayjs().format('YYYYMMDDTHHmmssSSS')}-${randomUUID().slice(0, 8)}`;
        const groupKey = String(group.chat_id || "group").replace(/[^a-zA-Z0-9_-]/g, "_");
        const statsPath = path.join(dashboardsDir, `stats-${groupKey}-${dateText}-${snapshotKey}.json`);
        fs.writeFileSync(statsPath, JSON.stringify(dashboardData, null, 2) + "\n", 'utf-8');

        const htmlPath = path.join(dashboardsDir, `delivery-dashboard-${groupKey}-${dateText}-${snapshotKey}.html`);
        fs.writeFileSync(htmlPath, this.renderHtml(dashboardData), 'utf-8');

        const publicUrl = this.publicBaseUrl ? `${this.publicBaseUrl}/${path.basename(htmlPath)}` : undefined;

        const artifact: DashboardArtifact = {
            id: `dashboard-${groupKey}-${dateText}-${snapshotKey}`,
            date: dateText,
            html_path: htmlPath,
            stats_path: statsPath,
            created_at: utcNowIso(),
            public_url: publicUrl,
        };
        await this.store.saveDashboardArtifact(artifact);
        return artifact;
    }

    private buildStats(tasks: any[], standups: any[], dateText: string, totalMembers: number): any {
        const statuses = tasks.reduce((acc, task) => {
            const st = task.dashboard_status || task.status || "unknown";
            acc[st] = (acc[st] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        return {
            total_tasks: tasks.length,
            parent_tasks: tasks.filter(task => !task.is_leaf).length,
            leaf_tasks: tasks.filter(task => task.is_leaf).length,
            active_leaf_tasks: tasks.filter(task => task.workload_eligible).length,
            completed_leaf_tasks: tasks.filter(task => task.is_leaf && task.effective_completed).length,
            new_tasks_today: tasks.filter(t => (t.created_at || "").startsWith(dateText)).length,
            completed_today: tasks.filter(t => t.effective_completed && (t.completed_at || t.updated_at || "").startsWith(dateText)).length,
            in_progress: (statuses["in_progress"] || 0) + (statuses["confirmed"] || 0),
            blocked: statuses["blocked"] || 0,
            overdue: tasks.filter(t => t.workload_eligible && t.is_overdue).length,
            overdue_day1: tasks.filter(t => t.workload_eligible && t.is_overdue && t.overdue_tier === "overdue_day1").length,
            overdue_day3: tasks.filter(t => t.workload_eligible && t.is_overdue && t.overdue_tier === "overdue_day3").length,
            overdue_day5: tasks.filter(t => t.workload_eligible && t.is_overdue && t.overdue_tier === "overdue_day5").length,
            pending_confirmation: (statuses["pending_primary_owner"] || 0) + (statuses["pending_confirmation"] || 0),
            owner_marked_done: statuses["owner_marked_done"] || 0,
            standup_submit_rate: totalMembers > 0 ? Math.round((standups.length / totalMembers) * 100) / 100 : 0,
            standup_submitted: standups.length,
            standup_total_members: totalMembers,
        };
    }

    private defaultHighlights(tasks: any[], standups: any[]): string[] {
        const highlights: string[] = [];
        const actionable = tasks.filter(t => t.workload_eligible);
        const blocked = actionable.filter(t => t.dashboard_status === "blocked");
        const overdue = actionable.filter(t => t.is_overdue);
        const pending = actionable.filter(t => ["pending_primary_owner", "pending_confirmation"].includes(t.dashboard_status));
        const inProgress = actionable.filter(t => ["confirmed", "in_progress"].includes(t.dashboard_status));
        const highPriority = actionable.filter(t => ["P0", "P1"].includes(t.priority));
        const unassigned = actionable.filter(t => !t.primary_owner_name);

        if (pending.length) highlights.push(`${pending.length} 个任务等待负责人确认。`);
        if (blocked.length) highlights.push(`${blocked.length} 个任务处于阻塞状态，需要协助推进。`);
        if (overdue.length) highlights.push(`${overdue.length} 个任务已超期，建议尽快确认下一步。`);
        if (unassigned.length) highlights.push(`${unassigned.length} 个任务尚未指定主负责人，需要当天补齐。`);
        if (highPriority.length) highlights.push(`${highPriority.length} 个 P0 / P1 任务仍未完成，需要优先保障。`);
        if (inProgress.length) highlights.push(`${inProgress.length} 个任务正在推进，建议负责人及时更新最新进展。`);

        if (standups.length) {
            const blockersCount = standups.reduce((sum, s) => sum + (s.blockers?.length || 0), 0);
            if (blockersCount) highlights.push(`本次站会暴露 ${blockersCount} 条阻塞/协助需求。`);
        }

        if (!highlights.length) highlights.push(`暂无明显交付风险，建议保持任务状态更新。`);
        if (highlights.length < 3) highlights.push(`当前快照纳入 ${tasks.length} 个有效任务，已排除删除、取消和草稿数据。`);
        if (highlights.length < 3) highlights.push(`今日已有 ${standups.length} 人提交站会，团队计划已汇总到看板。`);
        return highlights.slice(0, 5);
    }

    private renderHtml(data: any): string {
        const stats = data.stats;
        const taskRows = data.tasks.map(this.taskRow).join("\n") || "<tr><td colspan='10' class='empty'>暂无任务</td></tr>";
        const highlightItems = data.highlights.map((item: string, index: number) => `<li><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(item)}</p></li>`).join("\n");
        const blockerRows = data.blockers.map((item: any) => this.blockerRow(item)).join("\n") || "<tr><td colspan='5' class='empty'>当前无阻塞事项</td></tr>";
        const riskRows = data.risks.map((item: any) => this.issueRow(item)).join("\n") || "<tr><td colspan='4' class='empty'>当前无风险提示</td></tr>";
        const standupSummary = data.standup_summary;
        const standupFocus = (standupSummary.team_focus || []).map((entry: any, index: number) => `<li><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(entry.name)}</b><p>${escapeHtml(entry.text)}</p></div></li>`).join('') || '<li class="standup-empty-item">暂无团队重点</li>';
        const standupPeople = (key: string) => (standupSummary.people || []).map((person: any) => {
            const items = person[key] || [];
            const content = items.length ? items.map((item: string) => `<li>${escapeHtml(item)}</li>`).join('') : '<li class="muted">暂无</li>';
            return `<article class="standup-person"><div class="standup-person-head"><b>${escapeHtml(person.name)}</b></div><ul>${content}</ul></article>`;
        }).join('') || '<div class="standup-empty-wide">暂无站会提交</div>';
        const standupSignals = (entries: any[], emptyText: string) => entries.length
            ? entries.map((entry: any) => `<li><b>${escapeHtml(entry.name)}</b><span>${escapeHtml(entry.text)}</span></li>`).join('')
            : `<li class="standup-signal-empty">${escapeHtml(emptyText)}</li>`;
        const standupMissing = standupSummary.missing_names.length
            ? standupSummary.missing_names.map((name: string) => `<span>${escapeHtml(name)}</span>`).join('')
            : '<strong>全员已提交 ✓</strong>';
        const total = Math.max(1, data.status_distribution.reduce((sum: number, item: any) => sum + item.count, 0));
        let cursor = 0;
        const donutStops = data.status_distribution.map((item: any) => {
            const start = cursor;
            cursor += item.count / total * 360;
            return `${DASHBOARD_STATUS_COLORS[item.status] || DASHBOARD_STATUS_COLORS.pending_confirmation} ${start}deg ${cursor}deg`;
        }).join(', ');
        const statusLegend = data.status_distribution.map((item: any) => `<div class='legend-row'><i style='background:${DASHBOARD_STATUS_COLORS[item.status] || DASHBOARD_STATUS_COLORS.pending_confirmation}'></i><span>${escapeHtml(item.label)}</span><b>${item.count}</b></div>`).join('');
        const maxWorkload = Math.max(1, ...data.workload.map((item: any) => item.task_count));
        const workloadRows = data.workload.map((item: any, index: number) => {
            const taskWidth = item.task_count ? Math.max(5, item.task_count / maxWorkload * 100) : 0;
            const initial = String(item.name || '未分配').trim().slice(0, 1);
            return `<div class='workload-row ${index === 0 ? 'workload-top' : ''}'><div class='workload-person'><span class='workload-avatar'>${escapeHtml(initial)}</span><div><b>${escapeHtml(item.name)}</b><small>需求 ${item.requirement_tasks} · 开发 ${item.development_tasks} · 测试 ${item.testing_tasks}</small></div></div><div class='workload-track'><i style='width:${taskWidth}%'></i></div><div class='workload-meta'><b>${item.task_count}</b><span>项</span>${item.estimated_days ? `<em>${item.estimated_days} 人天</em>` : '<em>暂无人天估算</em>'}${item.unestimated_tasks ? `<em class='unestimated'>未估 ${item.unestimated_tasks} 项</em>` : ''}</div></div>`;
        }).join('') || '<div class="empty">当前群暂无有效成员</div>';
        const calendarTasksJson = JSON.stringify(data.month_calendar.tasks).replace(/</g, '\\u003c');

        return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.project_name)} 交付进度看板 ${escapeHtml(data.date)}</title>
  <style>
    :root { --bg:#07111f; --panel:#0c1a2a; --panel2:#0f2134; --line:#22364a; --muted:#7890a8; --text:#e8f1f8; --cyan:#21a6ff; --green:#24d19b; --orange:#ff9f43; --red:#ff5f5f; --violet:#a78bfa; --gold:#f4c76b; }
    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body { margin:0; min-width:1180px; color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background-color:var(--bg); background-image:radial-gradient(circle at 82% 2%,rgba(33,166,255,.13),transparent 28%),radial-gradient(circle at 12% 44%,rgba(167,139,250,.08),transparent 24%),linear-gradient(rgba(52,83,111,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(52,83,111,.07) 1px,transparent 1px); background-size:auto,auto,28px 28px,28px 28px; }
    a { color:#55baff; text-decoration:none; } a:hover { text-decoration:underline; }
    header { position:relative; padding:42px 42px 32px; border-bottom:1px solid var(--line); background:linear-gradient(110deg,rgba(11,25,41,.98) 0%,rgba(16,38,58,.98) 62%,rgba(10,23,37,.98) 100%); overflow:hidden; }
    header:before { content:""; position:absolute; left:42px; top:0; width:110px; height:3px; background:linear-gradient(90deg,var(--cyan),var(--violet)); box-shadow:0 0 22px rgba(33,166,255,.6); }
    header:after { content:""; position:absolute; width:380px; height:380px; right:-80px; top:-220px; border:1px solid rgba(33,166,255,.25); transform:rotate(45deg); box-shadow:0 0 0 18px rgba(33,166,255,.025),0 0 0 36px rgba(33,166,255,.02); }
    .eyebrow { color:var(--cyan); font:700 13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.18em; text-transform:uppercase; }
    h1 { margin:8px 0 8px; font-size:32px; line-height:1.2; letter-spacing:-.03em; }
    .subtitle { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-top:12px; color:#aebfd0; font-size:16px; font-weight:600; letter-spacing:.01em; }
    .subtitle strong { color:#edf6ff; font-size:18px; letter-spacing:.02em; } .subtitle i { width:4px; height:4px; border-radius:50%; background:var(--cyan); box-shadow:0 0 9px rgba(33,166,255,.7); } .subtitle small { color:#93a8bb; font-size:15px; font-weight:500; }
    .header-meta { position:absolute; right:42px; bottom:28px; display:flex; gap:22px; color:var(--muted); font:14px ui-monospace,SFMono-Regular,Menlo,monospace; z-index:2; }
    .health { color:var(--green); } .health:before { content:""; display:inline-block; width:7px; height:7px; margin-right:7px; border-radius:50%; background:var(--green); box-shadow:0 0 12px var(--green); }
    main { max-width:1680px; margin:0 auto; padding:30px 42px 44px; }
    .metrics { display:grid; grid-template-columns:repeat(7,1fr); gap:10px; background:transparent; }
    .metric { min-height:116px; padding:18px 18px 14px; border:1px solid var(--line); border-radius:12px; position:relative; overflow:hidden; background:linear-gradient(145deg,rgba(16,37,57,.98),rgba(9,24,39,.92)); box-shadow:0 14px 30px rgba(0,0,0,.16); }
    .metric:last-child { border-right:1px solid var(--line); } .metric:before { content:""; position:absolute; left:0; top:0; height:3px; width:100%; background:linear-gradient(90deg,#41566b,transparent); }
    .metric:after { content:""; position:absolute; width:84px; height:84px; right:-36px; bottom:-42px; border:1px solid rgba(255,255,255,.08); border-radius:50%; box-shadow:0 0 0 12px rgba(255,255,255,.02),0 0 0 24px rgba(255,255,255,.015); }
    .metric.alert:before { background:var(--red); } .metric.warn:before { background:var(--orange); } .metric.good:before { background:var(--green); } .metric.active:before { background:var(--cyan); }
    .metric span { display:block; color:var(--muted); font-size:14px; letter-spacing:.06em; }
    .metric strong { display:block; margin-top:9px; color:#f4fbff; font:700 32px/1 ui-monospace,SFMono-Regular,Menlo,monospace; text-shadow:0 0 18px rgba(33,166,255,.18); }
    .metric small { display:block; margin-top:8px; color:#526b82; font-size:13px; }
    .section { margin-top:22px; border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,rgba(12,29,46,.96),rgba(8,20,33,.96)); box-shadow:0 16px 34px rgba(0,0,0,.14); overflow:hidden; }
    .section-head { display:flex; align-items:center; justify-content:space-between; min-height:60px; padding:0 18px; border-bottom:1px solid var(--line); background:linear-gradient(90deg,rgba(14,34,53,.98),rgba(12,27,44,.76)); }
    .section-head h2 { margin:0; font-size:17px; letter-spacing:.03em; }
    .section-head span { color:var(--muted); font-size:13px; }
    .section-title { display:flex; align-items:center; gap:10px; }
    .section-icon { display:grid; width:26px; height:26px; place-items:center; border:1px solid rgba(33,166,255,.35); border-radius:8px; color:var(--cyan); background:rgba(33,166,255,.1); font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .section-count { padding:5px 9px; border:1px solid rgba(120,144,168,.3); border-radius:999px; background:rgba(120,144,168,.08); color:#b8cbda!important; font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .blocker-panel .section-icon { color:var(--red); border-color:rgba(255,95,95,.35); background:rgba(255,95,95,.1); }
    .blocker-count { color:#ff9c9c!important; border-color:rgba(255,95,95,.35); background:rgba(255,95,95,.1); }
    .risk-panel .section-icon { color:var(--orange); border-color:rgba(255,159,67,.35); background:rgba(255,159,67,.1); }
    .risk-count { color:#ffd18e!important; border-color:rgba(255,159,67,.35); background:rgba(255,159,67,.1); }
    .charts { display:grid; grid-template-columns:1.35fr .75fr 1fr; gap:14px; margin-top:22px; }
    .chart-card { border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,rgba(12,29,46,.96),rgba(8,20,33,.96)); min-height:320px; box-shadow:0 16px 34px rgba(0,0,0,.14); overflow:hidden; }
    .chart-body { padding:18px; }
    .burndown svg { width:100%; height:226px; overflow:visible; }
    .chart-note { color:var(--muted); font-size:13px; }
    .workload-chart { padding:18px 18px 0; }
    .workload-row { display:grid; grid-template-columns:166px minmax(80px,1fr) 92px; gap:12px; align-items:center; min-height:52px; border-top:1px solid rgba(34,54,74,.72); }
    .workload-person { display:flex; align-items:center; gap:8px; min-width:0; }
    .workload-avatar { display:grid; flex:0 0 auto; width:26px; height:26px; place-items:center; border:1px solid rgba(33,166,255,.35); border-radius:9px; color:#c8edff; background:linear-gradient(145deg,rgba(33,166,255,.25),rgba(167,139,250,.18)); font-weight:700; }
    .workload-person div { min-width:0; } .workload-person b,.workload-person small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .workload-person b { color:#e2eff7; font-size:14px; } .workload-person small { margin-top:2px; color:#6f899f; font-size:11px; }
    .workload-track { position:relative; height:10px; overflow:hidden; border-radius:999px; background:repeating-linear-gradient(90deg,rgba(91,121,145,.13) 0,rgba(91,121,145,.13) 1px,transparent 1px,transparent 25%),#091725; box-shadow:inset 0 0 0 1px rgba(89,119,144,.18); }
    .workload-track i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,var(--cyan),var(--violet)); box-shadow:0 0 14px rgba(33,166,255,.5); }
    .workload-top .workload-track i { background:linear-gradient(90deg,var(--orange),var(--red)); box-shadow:0 0 14px rgba(255,159,67,.42); }
    .workload-meta { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:baseline; gap:0 5px; text-align:right; }
    .workload-meta b { color:#f4fbff; font:700 18px ui-monospace,SFMono-Regular,Menlo,monospace; } .workload-meta span { color:#90a7b8; font-size:12px; } .workload-meta em { flex-basis:100%; color:#6f899f; font-style:normal; font-size:11px; } .workload-meta .unestimated { color:#f3bd72; }
    .status-wrap { display:grid; place-items:center; padding:22px 20px; }
    .donut { width:154px; height:154px; border:8px solid rgba(6,17,29,.7); border-radius:50%; background:conic-gradient(${donutStops}); position:relative; box-shadow:0 0 0 1px rgba(33,166,255,.12),0 0 34px rgba(33,166,255,.12); }
    .donut:after { content:"${stats.total_tasks}"; position:absolute; inset:27px; display:grid; place-items:center; border-radius:50%; background:#0c1a2a; color:#fff; font:700 26px ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow:0 0 0 1px var(--line); }
    .legend { width:100%; margin-top:15px; } .legend-row { display:grid; grid-template-columns:10px 1fr auto; gap:9px; align-items:center; padding:5px 0; color:#9eb1c3; font-size:14px; }
    .legend-row i { width:7px; height:7px; } .legend-row b { color:var(--text); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .focus { margin-top:22px; }
    .focus-list { list-style:none; padding:10px 18px; margin:0; } .focus-list li { display:grid; grid-template-columns:34px 1fr; gap:12px; padding:14px 0; border-bottom:1px dashed #20364b; }
    .focus-list li:last-child { border:0; } .focus-list li>span { color:var(--cyan); font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace; } .focus-list p { margin:0; }
    .month-calendar { overflow:hidden; background:#091725; }
    .month-weekdays { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); min-height:38px; border-bottom:1px solid #294057; background:#0b1b2c; }
    .month-weekday { display:grid; place-items:center; border-right:1px solid var(--line); color:#7890a8; font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; }
    .month-weekday:last-child { border-right:0; } .month-weekday.weekend { color:#b17878; }
    .month-week { --week-lanes:1; position:relative; display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); grid-template-rows:31px repeat(var(--week-lanes),23px) 22px; min-height:82px; border-bottom:1px solid #294057; }
    .month-week:last-child { border-bottom:0; }
    .month-day-cell { z-index:0; grid-row:1/-1; border-right:1px solid rgba(35,58,79,.74); background:#091725; }
    .month-day-cell.weekend { background:rgba(255,95,95,.025); } .month-day-cell.outside { background:#06111c; }
    .month-day-cell.outside.weekend { background:#07111d; }
    .month-day-cell.today { background:rgba(33,166,255,.075); box-shadow:inset 0 3px 0 var(--cyan); }
    .month-day-number { z-index:2; grid-row:1; display:grid; width:100%; height:31px; place-items:center; color:#758ba0; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
    .month-day-number.outside { color:#30465a; } .month-day-number.today { color:#8bd5ff; font-weight:800; }
    .month-task-segment { position:relative; z-index:2; align-self:center; min-width:0; height:19px; margin:0 2px; overflow:hidden; border:1px solid rgba(77,155,255,.45); border-radius:4px; background:linear-gradient(90deg,rgba(33,166,255,.78),rgba(105,221,211,.67)); box-shadow:0 3px 10px rgba(33,166,255,.12); }
    .month-task-segment.parent { border-color:rgba(167,139,250,.58); background:repeating-linear-gradient(135deg,rgba(167,139,250,.72) 0 7px,rgba(95,126,232,.72) 7px 14px); }
    .month-task-segment.risk-high { border-color:rgba(255,95,95,.72); background:linear-gradient(90deg,rgba(255,95,95,.84),rgba(255,159,67,.74)); }
    .month-task-segment.risk-medium { border-color:rgba(255,159,67,.65); background:linear-gradient(90deg,rgba(255,159,67,.8),rgba(244,199,107,.7)); }
    .month-task-segment.completed { opacity:.48; filter:saturate(.5); }
    .month-task-segment.continues-before { margin-left:0; border-left:0; border-radius:0 4px 4px 0; } .month-task-segment.continues-after { margin-right:0; border-right:0; border-radius:4px 0 0 4px; }
    .month-task-segment.continues-before.continues-after { border-radius:0; }
    .month-task-segment span { display:flex; height:17px; min-width:0; align-items:center; overflow:hidden; padding:0 6px; color:#f4f9fc; font-size:10px; line-height:17px; text-overflow:ellipsis; white-space:nowrap; } .month-task-segment span em { overflow:hidden; color:rgba(235,246,252,.72); font-style:normal; font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
    .parent-deadline { position:absolute; z-index:3; top:0; bottom:0; width:2px; background:#ffe09a; box-shadow:0 0 7px rgba(255,224,154,.9); }
    .month-week-overflow { z-index:3; grid-row:-2; align-self:center; justify-self:start; margin-left:6px; color:#7992a8; font:10px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .month-empty { display:grid; min-height:210px; place-items:center; color:#577087; }
    .table-wrap { overflow:hidden; } table { width:100%; border-collapse:collapse; table-layout:fixed; } th,td { padding:13px 12px; border-bottom:1px solid #1d3145; text-align:left; vertical-align:top; font-size:13px; overflow-wrap:anywhere; }
    .table-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:58px; padding:12px 14px; border-bottom:1px solid var(--line); background:#091827; }
    .filter-label { display:flex; flex-direction:column; min-width:104px; } .filter-label b { color:#d9e8f5; font-size:14px; } .filter-label span { margin-top:2px; color:#627d95; font-size:12px; }
    .toolbar { display:flex; flex:1; flex-wrap:wrap; justify-content:flex-end; gap:9px; }
    .toolbar input,.toolbar select,.pager button,.pager input,.calendar-nav button { height:34px; border:1px solid #29425a; border-radius:8px; background:#0e2134; color:var(--text); padding:0 10px; font:13px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .toolbar input { min-width:190px; } .toolbar input:focus,.toolbar select:focus { border-color:var(--cyan); outline:none; }
    .pager input { width:46px; padding:0 5px; text-align:center; }
    .pager input:focus { border-color:var(--cyan); outline:none; }
    .page-label { display:inline-flex; align-items:center; gap:5px; }
    .pager,.calendar-nav { display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:10px 14px; color:var(--muted); font-size:13px; }
    .calendar-nav { padding:0; } .pager button:disabled { opacity:.35; }
    th { color:#7890a8; background:#0b1b2c; font-size:12px; letter-spacing:.05em; text-transform:uppercase; } tbody tr:nth-child(even) { background:rgba(17,38,59,.35); } tbody tr:hover { background:rgba(25,65,94,.36); } .task-completed { opacity:.52; filter:saturate(.55); }
    .task-parent-row { background:linear-gradient(90deg,rgba(33,166,255,.08),rgba(13,31,49,.42))!important; box-shadow:inset 3px 0 0 rgba(33,166,255,.5); }
    .task-title-tree { display:flex; align-items:flex-start; gap:7px; min-width:0; padding-left:calc(var(--tree-depth) * 18px); }
    .task-tree-branch { flex:0 0 auto; width:12px; color:#48657e; font:13px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .task-title-copy { min-width:0; } .task-title-copy strong { display:block; color:#dce9f2; font-weight:650; line-height:1.45; } .task-title-copy small { display:block; margin-top:3px; color:#617b92; font-size:10px; }
    .split { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:22px; }
    .split .section { margin-top:0; }
    .issue-main { display:flex; align-items:flex-start; gap:9px; }
    .issue-main strong { color:#e7f2fa; font-weight:650; line-height:1.45; }
    .issue-dot { flex:0 0 auto; width:8px; height:8px; margin-top:5px; border-radius:50%; background:var(--cyan); box-shadow:0 0 10px currentColor; }
    .blocker-dot { color:var(--red); background:var(--red); } .risk-dot { color:var(--orange); background:var(--orange); }
    .person-chip,.duration-chip { display:inline-flex; max-width:100%; align-items:center; padding:4px 8px; border:1px solid rgba(120,144,168,.3); border-radius:999px; background:rgba(120,144,168,.08); color:#c5d6e2; white-space:normal; }
    .helper-chip { color:#d2c8ff; border-color:rgba(167,139,250,.34); background:rgba(167,139,250,.1); }
    .duration-chip { color:#ffd58b; border-color:rgba(244,199,107,.34); background:rgba(244,199,107,.1); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .risk-copy { color:#ffc27d; } .action-text { color:#9eb4c4; line-height:1.45; }
    .task-table th:nth-child(1){width:20%} .task-table th:nth-child(2){width:7%} .task-table th:nth-child(3){width:7%} .task-table th:nth-child(4){width:10%} .task-table th:nth-child(5){width:8%} .task-table th:nth-child(6){width:5%} .task-table th:nth-child(7){width:8%} .task-table th:nth-child(8){width:22%} .task-table th:nth-child(9){width:6%} .task-table th:nth-child(10){width:7%}
    .pill,.risk-pill { display:inline-block; padding:3px 7px; border:1px solid #385069; background:#14263a; color:#aec0d0; font-size:11px; line-height:1.2; white-space:nowrap; }
    .priority-pill { display:inline-flex; align-items:center; min-width:30px; justify-content:center; padding:3px 7px; border:1px solid #385069; font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.04em; }
    .priority-p0 { color:#ff8787; border-color:#8b3941; background:rgba(180,45,58,.18); } .priority-p1 { color:#ffc06d; border-color:#865b2a; background:rgba(180,109,30,.16); } .priority-p2 { color:#62bfff; border-color:#285d88; background:rgba(24,107,170,.17); } .priority-p3 { color:#aab9c8; border-color:#405369; background:rgba(93,113,132,.14); }
    .pill-pending_primary_owner,.pill-pending_confirmation { color:#aec1d3; border-color:rgba(126,154,184,.26); background:rgba(111,143,176,.15); }
    .pill-requirement { color:#f06292; border-color:rgba(226,67,133,.35); background:rgba(170,20,80,.2); }
    .pill-in_progress,.pill-confirmed { color:#4d9bff; border-color:rgba(28,116,236,.26); background:rgba(10,93,207,.2); }
    .pill-development_completed { color:#ffd477; border-color:rgba(244,199,107,.38); background:rgba(139,99,19,.25); }
    .pill-owner_marked_done { color:#c5a4ff; border-color:rgba(167,118,239,.38); background:rgba(103,58,171,.24); }
    .pill-testing { color:#69ddd3; border-color:rgba(62,199,190,.34); background:rgba(20,132,125,.22); }
    .pill-accepted { color:#51d292; border-color:rgba(29,187,112,.24); background:rgba(17,137,81,.21); }
    .pill-blocked { color:#ff8585; border-color:#7c3838; background:rgba(178,54,54,.2); } .pill-overdue { color:#ffb86f; border-color:#80552c; background:rgba(171,101,32,.2); }
    .risk-high { color:#ff8585; } .risk-medium { color:#ffb86f; } .risk-low { color:#77d8b8; }
    .empty { padding:28px!important; color:var(--muted); text-align:center; }
    .standup-kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; padding:14px; background:rgba(7,18,30,.5); } .standup-kpis div { position:relative; padding:16px 17px; border:1px solid var(--line); border-radius:10px; background:linear-gradient(145deg,#10263a,#0b1b2c); } .standup-kpis div:after { content:""; position:absolute; right:12px; bottom:12px; width:26px; height:26px; border:1px solid rgba(33,166,255,.16); border-radius:50%; } .standup-kpis span { color:var(--muted); font-size:14px; } .standup-kpis b { display:block; margin-top:5px; color:#f4fbff; font:700 27px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .standup-body { padding:16px; background:linear-gradient(180deg,rgba(7,18,30,.48),rgba(8,22,36,.82)); }
    .standup-block-title { display:flex; align-items:center; gap:9px; margin:0 0 10px; color:#dceaf4; font-size:15px; letter-spacing:.04em; } .standup-block-title i { display:block; width:7px; height:7px; border-radius:50%; background:var(--cyan); box-shadow:0 0 10px rgba(33,166,255,.72); }
    .standup-focus-card { padding:14px 16px; border:1px solid rgba(33,166,255,.24); border-radius:12px; background:linear-gradient(120deg,rgba(20,54,79,.7),rgba(13,34,53,.48)); }
    .standup-focus-list { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; list-style:none; margin:0; padding:0; }
    .standup-focus-list li { display:grid; grid-template-columns:30px minmax(0,1fr); gap:9px; min-height:68px; padding:10px; border:1px solid rgba(72,116,151,.2); border-radius:9px; background:rgba(7,22,35,.45); }
    .standup-focus-list li>span { color:var(--cyan); font:800 12px ui-monospace,SFMono-Regular,Menlo,monospace; } .standup-focus-list b { color:#dcebf5; font-size:14px; } .standup-focus-list p { margin:4px 0 0; color:#9db2c3; font-size:13px; line-height:1.6; }
    .standup-focus-list .standup-empty-item { display:grid; grid-template-columns:1fr; grid-column:1/-1; width:100%; min-height:54px; place-items:center; color:#6f879b; writing-mode:horizontal-tb; white-space:nowrap; word-break:keep-all; overflow-wrap:normal; }
    .standup-dual { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; }
    .standup-column { overflow:hidden; border:1px solid var(--line); border-radius:12px; background:rgba(8,24,39,.66); }
    .standup-column-head { display:flex; align-items:center; justify-content:space-between; min-height:44px; padding:0 13px; border-bottom:1px solid var(--line); background:rgba(17,43,64,.6); } .standup-column-head b { font-size:14px; } .standup-column-head span { color:#678198; font-size:12px; }
    .standup-people { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1px; background:#1a3044; }
    .standup-person { min-width:0; padding:12px 13px; background:#0a1b2b; }
    .standup-person-head { display:flex; align-items:center; margin-bottom:7px; } .standup-person-head b { overflow:hidden; color:#e2edf5; font-size:15px; text-overflow:ellipsis; white-space:nowrap; }
    .standup-person ul { margin:0; padding-left:18px; color:#9db0c0; } .standup-person li { margin:4px 0; font-size:13px; line-height:1.6; overflow-wrap:anywhere; } .standup-person li::marker { color:#3f9ed8; } .standup-person li.muted { color:#526b80; list-style:none; }
    .standup-empty-wide { grid-column:1/-1; min-height:90px; padding:28px; color:#6d8599; background:#0a1b2b; text-align:center; }
    .standup-signal-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:12px; }
    .standup-signal-card { min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:11px; background:#091a2a; }
    .standup-signal-card h3 { display:flex; align-items:center; gap:7px; margin:0; padding:11px 12px; border-bottom:1px solid var(--line); color:#cddce7; font-size:13px; } .standup-signal-card h3 span { margin-left:auto; color:#688198; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .standup-signal-card.blockers h3 { color:#ffad8b; } .standup-signal-card.risks h3 { color:#ffd079; } .standup-signal-card.decisions h3 { color:#c8b8ff; }
    .standup-signal-card ul { list-style:none; margin:0; padding:7px 12px 11px; } .standup-signal-card li { display:grid; grid-template-columns:minmax(68px,.28fr) minmax(0,1fr); gap:8px; padding:8px 0; border-bottom:1px dashed rgba(44,71,94,.7); font-size:12px; line-height:1.55; } .standup-signal-card li:last-child { border-bottom:0; } .standup-signal-card li b { color:#dbe7ef; } .standup-signal-card li span { color:#94a9ba; overflow-wrap:anywhere; }
    .standup-signal-card .standup-signal-empty { display:block; padding:18px 0; color:#60788d; text-align:center; }
    .standup-missing { display:flex; align-items:center; gap:8px; margin-top:12px; padding:11px 12px; border:1px dashed rgba(120,144,168,.28); border-radius:10px; color:#70879a; font-size:12px; } .standup-missing>b { margin-right:3px; color:#9db0bf; } .standup-missing span { padding:3px 7px; border:1px solid rgba(255,159,67,.24); border-radius:999px; color:#ffc27d; background:rgba(255,159,67,.08); } .standup-missing strong { color:#70d4ad; }
    @media (max-width:1300px) { body{min-width:1000px}.charts{grid-template-columns:1fr 1fr}.chart-card:last-child{grid-column:1/-1}.metrics{grid-template-columns:repeat(4,1fr)}.metric{border-bottom:1px solid var(--line)} }
    @media print { @page{size:1600px auto;margin:0} body{min-width:1500px;-webkit-print-color-adjust:exact;print-color-adjust:exact}.section,.chart-card{break-inside:avoid} header,main{width:100%} a{text-decoration:none} }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">Delivery Control / Project Snapshot</div>
    <h1>${escapeHtml(data.project_name)} 交付进度看板</h1>
    <div class="subtitle"><strong>${escapeHtml(data.date)}</strong><i></i><strong>${escapeHtml(data.group_name)}</strong><i></i><small>创建人或开发人员属于本群的全部有效任务</small></div>
    <div class="header-meta"><span class="health">数据校验通过</span></div>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><span>总任务数</span><strong>${stats.total_tasks}</strong><small>父项 ${stats.parent_tasks} · 叶子执行项 ${stats.leaf_tasks}</small></div>
      <div class="metric active"><span>今日新增</span><strong>${stats.new_tasks_today}</strong><small>按创建日期</small></div>
      <div class="metric good"><span>今日完成</span><strong>${stats.completed_today}</strong><small>已验收 / 已完成</small></div>
      <div class="metric active"><span>进行中</span><strong>${stats.in_progress}</strong><small>已确认 + 开发中</small></div>
      <div class="metric alert"><span>阻塞任务</span><strong>${stats.blocked}</strong><small>需要外部协助</small></div>
      <div class="metric warn"><span>超期任务</span><strong>${stats.overdue}</strong><small>1–2 天 ${stats.overdue_day1} · 3–4 天 ${stats.overdue_day3} · 5 天以上 ${stats.overdue_day5}</small></div>
      <div class="metric ${stats.standup_submit_rate >= .8 ? 'good' : 'warn'}"><span>站会提交率</span><strong>${Math.round(stats.standup_submit_rate * 100)}%</strong><small>${stats.standup_submitted} / ${stats.standup_total_members} 人</small></div>
    </div>
    <div class="charts">
      <section class="chart-card burndown"><div class="section-head"><h2>近 7 天未完成任务趋势</h2><span>群内关联叶子任务</span></div><div class="chart-body">${this.renderBurndownSvg(data.burndown)}<div class="chart-note">按创建与完成时间还原每日未完成叶子任务；任务新增或范围变化时曲线可以上升。</div></div></section>
      <section class="chart-card"><div class="section-head"><h2>状态分布</h2><span>8 类交付状态</span></div><div class="status-wrap"><div class="donut"></div><div class="legend">${statusLegend}</div></div></section>
      <section class="chart-card"><div class="section-head"><div class="section-title"><span class="section-icon">◒</span><h2>群成员任务负载</h2></div><span>按当前责任阶段 · 需求 / 开发 / 测试</span></div><div class="workload-chart">${workloadRows}<div class="chart-note">流程角色优先决定当前负责人；待测试和测试中只计入测试任务，产品验收计入需求任务。父项与子项分别计数，已完成子树不计入负载。</div></div></section>
    </div>
    <div class="focus">
      <section class="section" style="margin-top:0"><div class="section-head"><h2>今日重点</h2><span>优先处理 3–5 项</span></div><ol class="focus-list">${highlightItems}</ol></section>
    </div>
    <section class="section"><div class="section-head"><div class="section-title"><span class="section-icon">▤</span><h2>月度任务区间</h2></div><div class="calendar-nav"><button id="calendar-prev" type="button">← 上月</button><span id="calendar-range">${escapeHtml(data.month_calendar.anchor_month)}</span><button id="calendar-current" type="button">本月</button><button id="calendar-next" type="button">下月 →</button></div></div><div id="task-calendar"></div></section>
      <section class="section"><div class="section-head"><div class="section-title"><span class="section-icon">▦</span><h2>任务列表</h2></div><span>父子树展示 · 父项汇总，子项缩进 · 组内风险优先</span></div><div class="table-toolbar"><div class="filter-label"><b>任务筛选</b><span>匹配子项时保留父项上下文</span></div><div class="toolbar"><input id="task-person-filter" type="search" placeholder="查询创建人 / 负责人 / 参与人"><select id="task-status-filter"><option value="">全部状态</option><option value="pending_confirmation">待确认</option><option value="requirement">需求</option><option value="in_progress">进行中</option><option value="development_completed">开发完成</option><option value="owner_marked_done">转测试</option><option value="testing">测试进行中</option><option value="blocked">阻塞</option><option value="accepted">已完成</option><option value="overdue">已超期</option></select><select id="task-overdue-filter"><option value="">全部超期分层</option><option value="overdue_day1">超期 1–2 天</option><option value="overdue_day3">超期 3–4 天</option><option value="overdue_day5">超期 5 天以上</option></select><select id="task-priority-filter"><option value="">全部优先级</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select><select id="task-risk-filter"><option value="">全部风险</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select><select id="task-time-filter"><option value="">全部时间</option><option value="overdue">已超期</option><option value="today">今日截止</option><option value="next7">未来 7 天</option><option value="none">未设置时间</option></select></div></div><div class="table-wrap"><table class="task-table"><thead><tr><th>任务标题</th><th>创建人</th><th>主负责人</th><th>参与人</th><th>状态</th><th>优先级</th><th>截止时间</th><th>最近更新</th><th>风险</th><th>TAPD</th></tr></thead><tbody id="task-body">${taskRows}</tbody></table></div><div class="pager"><span id="task-count"></span><button id="task-prev" type="button">上一页</button><span class="page-label"><input id="task-page-input" type="number" min="1" value="1" aria-label="跳转任务页码"><span>/</span><span id="task-pages"></span></span><button id="task-next" type="button">下一页</button></div></section>
      <div class="split">
      <section class="section blocker-panel"><div class="section-head"><div class="section-title"><span class="section-icon">!</span><h2>阻塞事项</h2></div><span class="section-count blocker-count">${data.blockers.length} 项</span></div><div class="table-wrap"><table><thead><tr><th>阻塞描述</th><th>被阻塞人</th><th>需要协助人</th><th>时长</th><th>建议动作</th></tr></thead><tbody>${blockerRows}</tbody></table></div></section>
      <section class="section risk-panel"><div class="section-head"><div class="section-title"><span class="section-icon">↗</span><h2>风险提示</h2></div><span class="section-count risk-count">${data.risks.length} 项</span></div><div class="table-wrap"><table><thead><tr><th>风险描述</th><th>负责人</th><th>影响任务</th><th>建议动作</th></tr></thead><tbody id="risk-body">${riskRows}</tbody></table></div><div class="pager"><button id="risk-prev" type="button">上一页</button><span class="page-label"><input id="risk-page-input" type="number" min="1" value="1" aria-label="跳转风险页码"><span>/</span><span id="risk-pages"></span></span><button id="risk-next" type="button">下一页</button></div></section>
    </div>
    <section class="section standup-panel"><div class="section-head"><div class="section-title"><span class="section-icon">◷</span><h2>今日站会摘要</h2></div><span>未提交：${escapeHtml(data.standup_summary.missing_names.join('、') || '无')}</span></div>
      <div class="standup-kpis"><div><span>已提交人数</span><b>${data.standup_summary.submitted}</b></div><div><span>未提交人数</span><b>${data.standup_summary.missing}</b></div><div><span>需要决策</span><b>${data.standup_summary.decisions_needed.length}</b></div></div>
      <div class="standup-body">
        <section class="standup-focus-card"><h3 class="standup-block-title"><i></i>团队重点概览</h3><ol class="standup-focus-list">${standupFocus}</ol></section>
        <div class="standup-dual">
          <section class="standup-column"><div class="standup-column-head"><b>✓ 昨日完成</b><span>按成员保留原始内容</span></div><div class="standup-people">${standupPeople('yesterday_done')}</div></section>
          <section class="standup-column"><div class="standup-column-head"><b>→ 当日计划</b><span>按成员保留原始内容</span></div><div class="standup-people">${standupPeople('today_plan')}</div></section>
        </div>
        <div class="standup-signal-grid">
          <section class="standup-signal-card blockers"><h3>■ 阻塞 / 需要帮助<span>${standupSummary.blocker_entries.length}</span></h3><ul>${standupSignals(standupSummary.blocker_entries, '暂无阻塞')}</ul></section>
          <section class="standup-signal-card risks"><h3>▲ 风险 / 可能延期<span>${standupSummary.risk_entries.length}</span></h3><ul>${standupSignals(standupSummary.risk_entries, '暂无风险')}</ul></section>
          <section class="standup-signal-card decisions"><h3>◆ 需要决策<span>${standupSummary.decision_entries.length}</span></h3><ul>${standupSignals(standupSummary.decision_entries, '暂无决策事项')}</ul></section>
        </div>
        <div class="standup-missing"><b>未提交情况</b>${standupMissing}</div>
      </div>
    </section>
  </main>
  <script>
    (function () {
      var pageSize = 20, taskPage = 1, riskPage = 1, riskPageSize = 10;
      var snapshotDate = '${escapeHtml(data.date)}';
      var calendarTasks = ${calendarTasksJson};
      var calendarUndated = ${Number(data.month_calendar.undated_count || 0)};
      var calendarAnchor = new Date(snapshotDate.slice(0, 7) + '-01T00:00:00');
      function taskRows() { return Array.from(document.querySelectorAll('#task-body tr[data-task]')); }
      function taskMatches(row) {
        var person = document.getElementById('task-person-filter').value.trim().toLowerCase();
        var status = document.getElementById('task-status-filter').value;
        var overdueTier = document.getElementById('task-overdue-filter').value;
        var priority = document.getElementById('task-priority-filter').value;
        var risk = document.getElementById('task-risk-filter').value;
        var time = document.getElementById('task-time-filter').value;
        var due = row.dataset.due;
        var today = new Date(snapshotDate + 'T00:00:00');
        var dueDate = due ? new Date(due + 'T00:00:00') : null;
        var diff = dueDate ? Math.round((dueDate - today) / 86400000) : null;
        var timeOk = !time || (time === 'none' && !due) || (time === 'overdue' && diff !== null && diff < 0) || (time === 'today' && diff === 0) || (time === 'next7' && diff !== null && diff >= 0 && diff <= 7);
        return (!person || row.dataset.people.toLowerCase().includes(person)) && (!status || row.dataset.status === status) && (!overdueTier || row.dataset.overdueTier === overdueTier) && (!priority || row.dataset.priority === priority) && (!risk || row.dataset.risk === risk) && timeOk;
      }
      function matchedTaskTree() {
        var all = taskRows(), direct = all.filter(taskMatches), visibleIds = new Set(direct.map(function (row) { return row.dataset.taskId; }));
        var rowById = new Map(all.map(function (row) { return [row.dataset.taskId, row]; }));
        var childrenByParent = new Map();
        all.forEach(function (row) { var parentId = row.dataset.parentId; if (!parentId) return; var children = childrenByParent.get(parentId) || []; children.push(row); childrenByParent.set(parentId, children); });
        function addAncestors(row) { var parent = rowById.get(row.dataset.parentId); if (!parent || visibleIds.has(parent.dataset.taskId)) return; visibleIds.add(parent.dataset.taskId); addAncestors(parent); }
        function addDescendants(row) { (childrenByParent.get(row.dataset.taskId) || []).forEach(function (child) { if (!visibleIds.has(child.dataset.taskId)) visibleIds.add(child.dataset.taskId); addDescendants(child); }); }
        direct.forEach(function (row) { addAncestors(row); if (childrenByParent.has(row.dataset.taskId)) addDescendants(row); });
        return { rows: all.filter(function (row) { return visibleIds.has(row.dataset.taskId); }), directCount: direct.length };
      }
      function renderTasks() {
        var matchedTree = matchedTaskTree(), matched = matchedTree.rows;
        var pages = Math.max(1, Math.ceil(matched.length / pageSize));
        taskPage = Math.min(taskPage, pages);
        taskRows().forEach(function (row) { row.style.display = 'none'; });
        matched.slice((taskPage - 1) * pageSize, taskPage * pageSize).forEach(function (row) { row.style.display = ''; });
        document.getElementById('task-count').textContent = '匹配 ' + matchedTree.directCount + ' 条 · 含父子上下文共 ' + matched.length + ' 条';
        document.getElementById('task-page-input').value = taskPage;
        document.getElementById('task-page-input').max = pages;
        document.getElementById('task-pages').textContent = pages;
        document.getElementById('task-prev').disabled = taskPage <= 1;
        document.getElementById('task-next').disabled = taskPage >= pages;
      }
      ['task-person-filter','task-status-filter','task-overdue-filter','task-priority-filter','task-risk-filter','task-time-filter'].forEach(function (id) { document.getElementById(id).addEventListener('input', function () { taskPage = 1; renderTasks(); }); });
      document.getElementById('task-prev').onclick = function () { taskPage--; renderTasks(); };
      document.getElementById('task-next').onclick = function () { taskPage++; renderTasks(); };
      function jumpTaskPage() {
        var matched = matchedTaskTree().rows, pages = Math.max(1, Math.ceil(matched.length / pageSize));
        taskPage = Math.max(1, Math.min(pages, parseInt(document.getElementById('task-page-input').value, 10) || 1));
        renderTasks();
      }
      document.getElementById('task-page-input').addEventListener('change', jumpTaskPage);
      document.getElementById('task-page-input').addEventListener('keydown', function (event) { if (event.key === 'Enter') jumpTaskPage(); });
      function renderRisks() {
        var rows = Array.from(document.querySelectorAll('#risk-body tr[data-risk]')), pages = Math.max(1, Math.ceil(rows.length / riskPageSize));
        riskPage = Math.min(riskPage, pages); rows.forEach(function (row) { row.style.display = 'none'; });
        rows.slice((riskPage - 1) * riskPageSize, riskPage * riskPageSize).forEach(function (row) { row.style.display = ''; });
        document.getElementById('risk-page-input').value = riskPage;
        document.getElementById('risk-page-input').max = pages;
        document.getElementById('risk-pages').textContent = pages;
        document.getElementById('risk-prev').disabled = riskPage <= 1; document.getElementById('risk-next').disabled = riskPage >= pages;
      }
      document.getElementById('risk-prev').onclick = function () { riskPage--; renderRisks(); };
      document.getElementById('risk-next').onclick = function () { riskPage++; renderRisks(); };
      function jumpRiskPage() {
        var rows = Array.from(document.querySelectorAll('#risk-body tr[data-risk]')), pages = Math.max(1, Math.ceil(rows.length / riskPageSize));
        riskPage = Math.max(1, Math.min(pages, parseInt(document.getElementById('risk-page-input').value, 10) || 1));
        renderRisks();
      }
      document.getElementById('risk-page-input').addEventListener('change', jumpRiskPage);
      document.getElementById('risk-page-input').addEventListener('keydown', function (event) { if (event.key === 'Enter') jumpRiskPage(); });
      function iso(date) { var y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0'); return y + '-' + m + '-' + d; }
      function parseDate(value) { var parts = String(value || '').split('-').map(Number); return parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : null; }
      function safe(value) { return String(value || '').replace(/[&<>"']/g, function (character) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]; }); }
      function renderCalendar() {
        var year = calendarAnchor.getFullYear(), month = calendarAnchor.getMonth(), monthStart = new Date(year, month, 1), monthEnd = new Date(year, month + 1, 0);
        var monthStartKey = iso(monthStart), monthEndKey = iso(monthEnd), snapshot = parseDate(snapshotDate);
        var tasks = calendarTasks.filter(function (task) { return task.start <= monthEndKey && task.end >= monthStartKey; });
        var leadingDays = (monthStart.getDay() + 6) % 7, gridStart = new Date(year, month, 1 - leadingDays);
        var weekCount = 6, weekdays = ['周一','周二','周三','周四','周五','周六','周日'];
        var weekdayHeader = weekdays.map(function (label, index) { return '<span class="month-weekday ' + (index >= 5 ? 'weekend' : '') + '">' + label + '</span>'; }).join('');
        var weeks = '';
        for (var weekIndex = 0; weekIndex < weekCount; weekIndex++) {
          var weekStart = new Date(gridStart); weekStart.setDate(gridStart.getDate() + weekIndex * 7);
          var weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
          var cells = '', numbers = '';
          for (var column = 0; column < 7; column++) {
            var cellDate = new Date(weekStart); cellDate.setDate(weekStart.getDate() + column);
            var outside = cellDate.getMonth() !== month, weekend = column >= 5, today = iso(cellDate) === snapshotDate;
            cells += '<i class="month-day-cell ' + (outside ? 'outside ' : '') + (weekend ? 'weekend ' : '') + (today ? 'today' : '') + '" style="grid-column:' + (column + 1) + '"></i>';
            numbers += '<span class="month-day-number ' + (outside ? 'outside ' : '') + (today ? 'today' : '') + '" style="grid-column:' + (column + 1) + '">' + cellDate.getDate() + '</span>';
          }
          var weekTasks = tasks.filter(function (task) { return task.start <= iso(weekEnd) && task.end >= iso(weekStart); });
          var laneEnds = [], segments = '', hidden = 0, maxVisibleLanes = 8;
          weekTasks.forEach(function (task) {
            var taskStart = parseDate(task.start), taskEnd = parseDate(task.end), segmentStart = taskStart < weekStart ? weekStart : taskStart, segmentEnd = taskEnd > weekEnd ? weekEnd : taskEnd;
            var startColumn = Math.round((segmentStart - weekStart) / 86400000), endColumn = Math.round((segmentEnd - weekStart) / 86400000);
            var lane = laneEnds.findIndex(function (lastColumn) { return lastColumn < startColumn; });
            if (lane < 0) { lane = laneEnds.length; laneEnds.push(endColumn); } else laneEnds[lane] = endColumn;
            if (lane >= maxVisibleLanes) { hidden++; return; }
            var continuesBefore = taskStart < weekStart, continuesAfter = taskEnd > weekEnd, spanDays = endColumn - startColumn + 1;
            var ownEnd = parseDate(task.own_end), deadline = '';
            if (task.is_parent && ownEnd && ownEnd >= segmentStart && ownEnd <= segmentEnd) {
              var deadlineOffset = Math.round((ownEnd - segmentStart) / 86400000);
              deadline = '<i class="parent-deadline" style="left:' + (((deadlineOffset + .5) / spanDays) * 100) + '%" title="父项自身截止 ' + safe(task.own_end) + '"></i>';
            }
            var segmentClass = 'month-task-segment ' + (task.is_parent ? 'parent ' : '') + 'risk-' + safe(task.risk) + ' ' + (task.completed ? 'completed ' : '') + (continuesBefore ? 'continues-before ' : '') + (continuesAfter ? 'continues-after' : '');
            segments += '<div class="' + segmentClass + '" style="grid-column:' + (startColumn + 1) + '/' + (endColumn + 2) + ';grid-row:' + (lane + 2) + '" title="' + safe(task.title + ' · ' + task.start + ' → ' + task.end + ' · ' + task.owner) + '">' + deadline + '<span>' + safe(task.title) + '<em> · ' + safe(task.owner) + '</em></span></div>';
          });
          var visibleLanes = Math.max(1, Math.min(maxVisibleLanes, laneEnds.length));
          var overflow = hidden ? '<span class="month-week-overflow">另有 ' + hidden + ' 项任务</span>' : '';
          weeks += '<div class="month-week" style="--week-lanes:' + visibleLanes + '">' + cells + numbers + segments + overflow + '</div>';
        }
        var html = '<div class="month-calendar"><div class="month-weekdays">' + weekdayHeader + '</div>' + weeks + '</div>';
        document.getElementById('task-calendar').innerHTML = html;
        document.getElementById('calendar-range').textContent = year + '年' + String(month + 1).padStart(2, '0') + '月 · ' + tasks.length + ' 个区间 · ' + calendarUndated + ' 个任务未设置日期';
      }
      document.getElementById('calendar-prev').onclick = function () { calendarAnchor.setMonth(calendarAnchor.getMonth() - 1, 1); renderCalendar(); };
      document.getElementById('calendar-next').onclick = function () { calendarAnchor.setMonth(calendarAnchor.getMonth() + 1, 1); renderCalendar(); };
      document.getElementById('calendar-current').onclick = function () { calendarAnchor = new Date(snapshotDate.slice(0, 7) + '-01T00:00:00'); renderCalendar(); };
      renderTasks(); renderRisks(); renderCalendar();
    })();
  </script>
</body>
</html>`;
    }

    private renderBurndownSvg(burndown: any): string {
        const points = burndown.points || [];
        const max = Math.max(1, ...points.map((point: any) => point.remaining).filter((value: any) => value !== null));
        const coords = (key: string) => points.map((point: any, index: number) => ({ point, index })).filter(({ point }: any) => point[key] !== null).map(({ point, index }: any) => {
            const x = 42 + index * (520 / Math.max(1, points.length - 1));
            const y = 190 - (Number(point[key]) / max) * 150;
            return `${x},${y}`;
        }).join(' ');
        const labels = points.map((point: any, index: number) => `<text x="${42 + index * (520 / Math.max(1, points.length - 1))}" y="218" text-anchor="middle">${escapeHtml(point.label)}</text>`).join('');
        const dots = points.map((point: any, index: number) => ({ point, index })).filter(({ point }: any) => point.remaining !== null).map(({ point, index }: any) => {
            const x = 42 + index * (520 / Math.max(1, points.length - 1));
            const y = 190 - (Number(point.remaining) / max) * 150;
            return `<circle cx="${x}" cy="${y}" r="3.5"/><text class="value" x="${x}" y="${y - 10}" text-anchor="middle">${point.remaining}</text>`;
        }).join('');
        return `<svg viewBox="0 0 604 230" role="img" aria-label="近 7 天未完成任务趋势"><g stroke="#193249" stroke-width="1"><line x1="42" y1="40" x2="562" y2="40"/><line x1="42" y1="90" x2="562" y2="90"/><line x1="42" y1="140" x2="562" y2="140"/><line x1="42" y1="190" x2="562" y2="190"/></g><polyline points="${coords('remaining')}" fill="none" stroke="#21a6ff" stroke-width="3"/><g fill="#21a6ff">${dots}</g><g fill="#7890a8" font-size="12" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${labels}</g><g font-size="12" font-family="ui-monospace,SFMono-Regular,Menlo,monospace"><text x="42" y="22" fill="#21a6ff">未完成叶子任务</text></g><style>.value{fill:#d9ecf9;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style></svg>`;
    }

    private taskRow(task: any): string {
        const link = task.tapd_url || "";
        const linkHtml = link ? `<a href='${escapeHtml(link)}' target='_blank' rel='noopener noreferrer'>查看</a>` : "";
        const statusRaw = task.dashboard_status || task.status || "";
        const filterStatus = ["pending_primary_owner", "pending_confirmation"].includes(statusRaw)
            ? "pending_confirmation"
            : ["confirmed", "in_progress"].includes(statusRaw) ? "in_progress" : statusRaw;
        const statusLabel = STATUS_LABELS[statusRaw] || statusRaw;
        const people = Array.from(new Set([
            task.creator_name,
            task.primary_owner_name,
            ...(task.assignee_names || []),
        ].filter(Boolean)));
        const depth = Math.max(0, Number(task.display_depth || 0));
        const branch = depth > 0 ? "└" : !task.is_leaf ? "▾" : "•";
        const childNote = !task.is_leaf ? `${task.child_count || 0} 个直接子项` : "";
        const rowClasses = [task.effective_completed ? "task-completed" : "", !task.is_leaf ? "task-parent-row" : ""].filter(Boolean).join(" ");
        return (
            `<tr class='${rowClasses}' data-task data-task-id='${escapeHtml(task.id || '')}' data-parent-id='${escapeHtml(task.display_parent_id || '')}' data-root-id='${escapeHtml(task.display_root_id || task.id || '')}' data-depth='${depth}' data-people='${escapeHtml(people.join('、'))}' data-status='${escapeHtml(filterStatus)}' data-overdue-tier='${escapeHtml(task.overdue_tier || '')}' data-priority='${escapeHtml(task.priority || '')}' data-risk='${escapeHtml(task.risk_level || '')}' data-due='${escapeHtml(task.due_date || '')}'>` +
            `<td><div class='task-title-tree' style='--tree-depth:${depth}'><span class='task-tree-branch'>${branch}</span><div class='task-title-copy'><strong>${escapeHtml(task.title || '')}</strong>${childNote ? `<small>${escapeHtml(childNote)}</small>` : ''}</div></div></td>` +
            `<td>${escapeHtml(task.creator_name || '未记录')}</td>` +
            `<td>${escapeHtml(task.primary_owner_name || '未分配')}</td>` +
            `<td>${escapeHtml((task.assignee_names || []).join('、') || '—')}</td>` +
            `<td><span class='pill pill-${escapeHtml(statusRaw)}'>${escapeHtml(statusLabel)}</span>${task.overdue_label ? `<br><small>${escapeHtml(task.overdue_label)}</small>` : ''}</td>` +
            `<td><span class='priority-pill priority-${escapeHtml(String(task.priority || 'P3').toLowerCase())}'>${escapeHtml(task.priority || '—')}</span></td>` +
            `<td>${escapeHtml(task.due_date || '未设置')}</td>` +
            `<td>${escapeHtml(task.latest_update || '暂无进展')}<br><small>${escapeHtml(task.latest_update_at || '')}</small></td>` +
            `<td><span class='risk-pill risk-${escapeHtml(task.risk_level)}'>${escapeHtml(task.risk_label)}</span></td>` +
            `<td>${linkHtml}</td>` +
            "</tr>"
        );
    }

    private blockerRow(item: any): string {
        return `<tr class="blocker-row"><td><div class="issue-main"><i class="issue-dot blocker-dot"></i><strong>${escapeHtml(item.title)}</strong></div></td><td><span class="person-chip">${escapeHtml(item.owner || '未分配')}</span></td><td><span class="person-chip helper-chip">${escapeHtml(item.helper || '待确认')}</span></td><td><span class="duration-chip">${escapeHtml(item.duration || '待补充')}</span></td><td><span class="action-text">${escapeHtml(item.action)}</span></td></tr>`;
    }

    private issueRow(item: any): string {
        return (
            "<tr class=\"risk-row\" data-risk>" +
            `<td><div class="issue-main"><i class="issue-dot risk-dot"></i><strong>${escapeHtml(item.title || '')}</strong></div></td>` +
            `<td><span class="person-chip">${escapeHtml(item.owner || '未分配')}</span></td>` +
            `<td><span class="risk-copy">${escapeHtml(item.impact || '')}</span></td>` +
            `<td><span class="action-text">${escapeHtml(item.action || '')}</span></td>` +
            "</tr>"
        );
    }

    private compareTasks(a: any, b: any): number {
        const completionA = a.effective_completed ? 1 : 0;
        const completionB = b.effective_completed ? 1 : 0;
        if (completionA !== completionB) return completionA - completionB;
        const rA = [STATUS_SORT[a.dashboard_status || a.status] ?? 9, PRIORITY_SORT[a.priority || "P2"] ?? 5, a.due_date || "9999-12-31", a.updated_at || ""];
        const rB = [STATUS_SORT[b.dashboard_status || b.status] ?? 9, PRIORITY_SORT[b.priority || "P2"] ?? 5, b.due_date || "9999-12-31", b.updated_at || ""];
        for (let index = 0; index < rA.length; index++) {
            if (rA[index] < rB[index]) return -1;
            if (rA[index] > rB[index]) return 1;
        }
        return 0;
    }

    private sortTaskTree(tasks: any[]): any[] {
        const taskByExternalId = new Map<string, any>();
        for (const task of tasks) {
            taskByExternalId.set(String(task.id), task);
            if (task.tapd_story_id) taskByExternalId.set(String(task.tapd_story_id), task);
        }

        const childrenByParentId = new Map<string, any[]>();
        const roots: any[] = [];
        for (const task of tasks) {
            const parent = task.parent_id ? taskByExternalId.get(String(task.parent_id)) : undefined;
            if (!parent || parent.id === task.id) {
                roots.push(task);
                continue;
            }
            const children = childrenByParentId.get(parent.id) || [];
            children.push(task);
            childrenByParentId.set(parent.id, children);
        }
        const result: any[] = [];
        const visited = new Set<string>();
        const append = (task: any, depth: number, rootId: string, parent?: any) => {
            if (visited.has(task.id)) return;
            visited.add(task.id);
            const children = (childrenByParentId.get(task.id) || []).sort((left, right) => this.compareTasks(left, right));
            result.push({
                ...task,
                display_depth: depth,
                display_parent_id: parent?.id || "",
                display_root_id: rootId,
                child_count: children.length,
            });
            for (const child of children) append(child, depth + 1, rootId, task);
        };

        roots.sort((left, right) => this.compareTasks(left, right));
        for (const root of roots) append(root, 0, root.id);
        for (const task of tasks.sort((left, right) => this.compareTasks(left, right))) {
            if (!visited.has(task.id)) append(task, 0, task.id);
        }
        return result;
    }

    private statusDistribution(tasks: any[]): any[] {
        const definitions = [
            { status: "pending_confirmation", label: "待确认", sources: ["pending_primary_owner", "pending_confirmation"] },
            { status: "in_progress", label: "进行中", sources: ["confirmed", "in_progress"] },
            { status: "development_completed", label: "开发完成", sources: ["development_completed"] },
            { status: "owner_marked_done", label: "转测试", sources: ["owner_marked_done"] },
            { status: "testing", label: "测试进行中", sources: ["testing"] },
            { status: "blocked", label: "阻塞", sources: ["blocked"] },
            { status: "accepted", label: "已完成", sources: ["accepted"] },
            { status: "overdue", label: "已超期", sources: ["overdue"] },
        ];
        return definitions.map(definition => ({
            status: definition.status,
            label: definition.label,
            count: tasks.filter(task => definition.sources.includes(task.dashboard_status || task.status)).length,
        }));
    }

    private buildBlockers(tasks: any[], standups: any[]): any[] {
        const values: any[] = [];
        for (const task of tasks) {
            if (!task.workload_eligible || task.dashboard_status !== "blocked") continue;
            const blocker = task.blocker_info || {};
            values.push({
                title: blocker.reason || task.title || "",
                owner: task.primary_owner_name || "",
                helper: blocker.blocked_by_name || blocker.helper_name || "",
                duration: this.blockedDuration(task),
                action: blocker.suggested_action || "确认协助人和下一步恢复动作"
            });
        }
        for (const item of standups) {
            for (const blocker of (item.blockers || [])) {
                values.push({
                    title: blocker,
                    owner: item.user_name || "",
                    helper: "",
                    duration: "站会当日提出",
                    action: "当天确认协助对象和处理时限"
                });
            }
        }
        return values;
    }

    private buildRisks(tasks: any[], standups: any[]): any[] {
        const values = tasks
            .filter(t => t.workload_eligible && ["high", "medium"].includes(t.risk_level))
            .map(t => ({
                title: t.title || "",
                owner: t.primary_owner_name || "",
                impact: !t.primary_owner_name
                    ? "未分配负责人"
                    : t.overdue_label
                    ? `${t.overdue_label} · 风险 ${t.risk_label}`
                    : `风险 ${t.risk_label} · ${STATUS_LABELS[t.dashboard_status] || t.dashboard_status}`,
                action: !t.primary_owner_name ? "请尽快分配主负责人" : "确认是否需要调整计划或资源"
            }));

        for (const item of standups) {
            for (const risk of (item.risks || [])) {
                values.push({
                    title: risk,
                    owner: item.user_name || "",
                    impact: "站会提出延期或交付风险",
                    action: "确认风险等级和缓解动作"
                });
            }
        }
        return values;
    }

    private buildStandupSummary(standups: any[], memberById: Map<string, any>): any {
        return StandupService.buildSummaryView(standups, Array.from(memberById.values()));
    }

    private enrichTask(task: any, dateText: string, latestUpdate?: any, hierarchyState?: any, completionSource?: any): any {
        const rawStatus = task.status || "pending_confirmation";
        const effectiveCompleted = Boolean(hierarchyState?.is_completed);
        const inheritedPhase = hierarchyState?.inherited_phase || null;
        const inheritedStatus = inheritedPhase === "testing" ? "testing" : inheritedPhase === "transfer_test" ? "owner_marked_done" : null;
        const completedAt = task.trace?.tapd?.completed_at || completionSource?.trace?.tapd?.completed_at || (effectiveCompleted ? completionSource?.updated_at || task.updated_at : null);
        const due = task.due_date ? dayjs(task.due_date) : null;
        const overdue = !effectiveCompleted && hierarchyState?.is_leaf !== false && due?.isValid() && due.isBefore(dayjs(dateText), 'day');
        const isOverdue = rawStatus === "overdue" || overdue;
        const dashboardStatus = hierarchyState?.completed_by_ancestor
            ? "accepted"
            : inheritedStatus || (isOverdue ? "overdue" : rawStatus);
        const policy = overdue ? overduePolicy(task.due_date, dateText) : null;
        const daysToDue = due?.isValid() ? due.diff(dayjs(dateText), 'day') : null;
        const workloadEligible = Boolean(hierarchyState?.is_active && hierarchyState?.is_leaf && !effectiveCompleted);
        const assignmentEligible = Boolean(hierarchyState?.is_active && !effectiveCompleted);
        const highRisk = workloadEligible && (["blocked", "overdue"].includes(dashboardStatus) || isOverdue || !task.primary_owner_name);
        const mediumRisk = workloadEligible && !highRisk && (["P0", "P1"].includes(task.priority) || (daysToDue !== null && daysToDue <= 2));
        const riskLevel = highRisk ? "high" : mediumRisk ? "medium" : "low";
        const riskLabel = highRisk ? "高" : mediumRisk ? "中" : "低";
        const rawEffort = task.trace?.tapd?.effort_days;
        const effort = rawEffort === null || rawEffort === undefined || rawEffort === "" ? NaN : Number(rawEffort);
        return {
            ...task,
            dashboard_status: dashboardStatus,
            effective_phase: inheritedPhase || task.trace?.workflow?.phase || null,
            inherited_phase: inheritedPhase,
            inherited_phase_source_id: hierarchyState?.inherited_phase_source_id || null,
            is_overdue: isOverdue,
            effective_completed: effectiveCompleted,
            completed_by_ancestor: Boolean(hierarchyState?.completed_by_ancestor),
            is_leaf: hierarchyState?.is_leaf !== false,
            workload_eligible: workloadEligible,
            assignment_eligible: assignmentEligible,
            overdue_days: policy?.daysOverdue || 0,
            overdue_tier: policy?.tier || "",
            overdue_label: policy?.label || "",
            completed_at: completedAt,
            effort_days: Number.isFinite(effort) && effort >= 0 ? effort : null,
            latest_update: latestUpdate?.content || (task.trace?.tapd?.modified_at ? "TAPD 状态已同步" : ""),
            latest_update_at: latestUpdate?.created_at || task.updated_at || "",
            risk_level: riskLevel,
            risk_label: riskLabel,
        };
    }

    private buildBurndown(tasks: any[], day: Date): any {
        const current = dayjs(day).startOf('day');
        const start = current.subtract(6, 'day');
        const remainingAt = (date: dayjs.Dayjs) => tasks.filter(task => {
            const created = dayjs(task.created_at || start);
            const completed = task.completed_at ? dayjs(task.completed_at) : null;
            return (!created.isValid() || !created.isAfter(date, 'day')) && (!completed?.isValid() || completed.isAfter(date, 'day'));
        }).length;
        const points = Array.from({ length: 7 }, (_, index) => {
            const date = start.add(index, 'day');
            return {
            date: date.format('YYYY-MM-DD'),
            label: date.format('MM-DD'),
            remaining: remainingAt(date),
            };
        });
        return { unit: "task_count", start: points[0].date, end: points[6].date, points };
    }

    private buildWorkload(tasks: any[], memberById: Map<string, any>): any[] {
        const values = new Map<string, any>();
        const memberByName = new Map<string, any>();
        for (const member of memberById.values()) {
            values.set(member.open_id, {
                open_id: member.open_id,
                name: member.name,
                task_count: 0,
                requirement_tasks: 0,
                development_tasks: 0,
                testing_tasks: 0,
                estimated_days: 0,
                unestimated_tasks: 0,
            });
            if (member.name) memberByName.set(String(member.name).trim(), member);
        }

        for (const task of tasks.filter(task => task.assignment_eligible)) {
            const category = workloadCategory(task);
            const owners = new Map<string, any>();
            const roles = task.trace?.workflow?.roles || task.trace?.roles || {};
            const role = category === "requirement" ? roles.product : category === "development" ? roles.developer : roles.tester;
            if (role?.open_id || role?.name) {
                const owner = memberById.get(role.open_id) || memberByName.get(String(role.name || '').trim());
                if (owner) owners.set(owner.open_id, owner);
            } else {
                for (let index = 0; index < Math.max(task.assignee_open_ids?.length || 0, task.assignee_names?.length || 0); index++) {
                    const owner = memberById.get(task.assignee_open_ids?.[index]) || memberByName.get(String(task.assignee_names?.[index] || '').trim());
                    if (owner) owners.set(owner.open_id, owner);
                }
                const primaryOwner = memberById.get(task.primary_owner_open_id) || memberByName.get(String(task.primary_owner_name || '').trim());
                if (primaryOwner) owners.set(primaryOwner.open_id, primaryOwner);
            }

            for (const owner of owners.values()) {
                const value = values.get(owner.open_id);
                value.task_count++;
                value[`${category}_tasks`]++;
                if (task.effort_days === null || task.effort_days === undefined) value.unestimated_tasks++;
                else value.estimated_days = Math.round((value.estimated_days + Number(task.effort_days)) * 100) / 100;
            }
        }

        return Array.from(values.values()).sort((left, right) => right.task_count - left.task_count || right.estimated_days - left.estimated_days || left.name.localeCompare(right.name));
    }

    private buildMonthCalendar(tasks: any[], day: Date): any {
        const taskByExternalId = new Map<string, any>();
        for (const task of tasks) {
            taskByExternalId.set(String(task.id), task);
            if (task.tapd_story_id) taskByExternalId.set(String(task.tapd_story_id), task);
        }

        const childrenByParentId = new Map<string, any[]>();
        for (const task of tasks) {
            const parent = task.parent_id ? taskByExternalId.get(String(task.parent_id)) : undefined;
            if (!parent || parent.id === task.id) continue;
            const children = childrenByParentId.get(parent.id) || [];
            children.push(task);
            childrenByParentId.set(parent.id, children);
        }
        const calendarRoots = tasks.filter(task => !task.display_parent_id);

        const dateText = (value: any): string | null => {
            if (!value) return null;
            const parsed = dayjs(value);
            return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
        };
        const rangeByTaskId = new Map<string, any>();
        const resolving = new Set<string>();
        const taskRange = (task: any): any => {
            if (rangeByTaskId.has(task.id)) return rangeByTaskId.get(task.id);
            if (resolving.has(task.id)) return null;
            resolving.add(task.id);

            const ownBegin = dateText(task.trace?.tapd?.begin_date);
            const ownDue = dateText(task.due_date);
            const ownDates = [ownBegin, ownDue].filter(Boolean) as string[];
            const childRanges = (childrenByParentId.get(task.id) || []).map(taskRange).filter(Boolean);
            const starts = [...ownDates, ...childRanges.map(range => range.start)];
            const ends = [...ownDates, ...childRanges.map(range => range.end)];
            const range = starts.length ? {
                start: starts.sort()[0],
                end: ends.sort().reverse()[0],
                own_start: ownBegin || ownDue || null,
                own_end: ownDue || ownBegin || null,
                source: childRanges.length ? (ownDates.length ? "parent_and_children" : "children") : "task",
            } : null;
            resolving.delete(task.id);
            rangeByTaskId.set(task.id, range);
            return range;
        };

        const subtreeTasks = (root: any): any[] => {
            const values: any[] = [];
            const pending = [root];
            const visited = new Set<string>();
            while (pending.length) {
                const task = pending.shift();
                if (!task || visited.has(task.id)) continue;
                visited.add(task.id);
                values.push(task);
                pending.push(...(childrenByParentId.get(task.id) || []));
            }
            return values;
        };

        const calendarTasks = calendarRoots.flatMap(task => {
            const range = taskRange(task);
            if (!range) return [];
            const subtree = subtreeTasks(task);
            const participants = Array.from(new Set(subtree.flatMap(item => [
                item.primary_owner_name,
                ...(item.assignee_names || []),
            ]).map(name => String(name || "").trim()).filter(Boolean)));
            return [{
                id: task.id,
                parent_id: "",
                root_id: task.id,
                depth: 0,
                title: task.title || "",
                owner: participants.join("、") || "未分配",
                participants,
                status: task.dashboard_status || task.status || "",
                risk: task.risk_level || "low",
                is_parent: Boolean(childrenByParentId.get(task.id)?.length),
                completed: Boolean(task.effective_completed),
                start: range.start,
                end: range.end,
                own_start: range.own_start,
                own_end: range.own_end,
                range_source: range.source,
            }];
        });

        return {
            anchor_month: dayjs(day).format('YYYY-MM'),
            tasks: calendarTasks,
            undated_count: calendarRoots.length - calendarTasks.length,
        };
    }

    private blockedDuration(task: any): string {
        if (!task.blocked_at) return "待补充";
        const started = dayjs(task.blocked_at);
        if (!started.isValid()) return "待补充";
        const hours = Math.max(0, dayjs().diff(started, 'hour'));
        return hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours} 小时`;
    }

    private blockedLongEnough(task: any): boolean {
        if (!task.blocked_at) return false;
        const blockedAt = dayjs(task.blocked_at.replace("Z", ""));
        if (!blockedAt.isValid()) return false;
        return dayjs().diff(blockedAt, 'hour') >= 24;
    }
}
