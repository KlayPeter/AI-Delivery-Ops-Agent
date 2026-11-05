import * as fs from "fs";
import * as path from "path";
import { canonicalTapdStatus } from "@/domains/task/tapdPolicy";
import type { WeeklyNarrative, WeeklyReportFacts } from "./types";

export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const STATUS_LABELS: Record<string, string> = {
    pending_primary_owner: "待主负责人处理",
    pending_confirmation: "待确认",
    requirement: "需求阶段",
    confirmed: "已确认",
    in_progress: "进行中",
    blocked: "已阻塞",
    development_completed: "开发完成",
    owner_marked_done: "负责人已标记完成",
    testing: "测试中",
    accepted: "已验收",
    cancelled: "已取消",
    overdue: "已超期",
    deleted: "已删除",
};

export function weeklyTaskStatusLabel(status: unknown): string {
    const value = String(status || "").trim();
    if (!value) return "待确认";
    if (STATUS_LABELS[value]) return STATUS_LABELS[value];
    return /[\u4e00-\u9fff]/.test(value) ? value : "状态待同步";
}

function uniqueItems(items: string[], limit: number): string[] {
    return Array.from(new Set(items.map(item => String(item || "").trim()).filter(Boolean))).slice(0, limit);
}

function compactList(items: string[], emptyText: string): string {
    if (!items.length) return `<span class="empty">${escapeHtml(emptyText)}</span>`;
    return `<ul class="compact-list">${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function statusTone(status: unknown): string {
    const value = String(status || "");
    if (["accepted", "development_completed", "owner_marked_done"].includes(value)) return "done";
    if (value === "blocked" || value === "overdue") return "risk";
    if (value === "testing") return "test";
    return "active";
}

function shortDate(value: unknown): string {
    const date = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(5, 10).replace("-", "/") : "-";
}

function safeTapdUrl(value: unknown): string | null {
    try {
        const url = new URL(String(value || ""));
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch {
        return null;
    }
}

function taskTypeLabel(task: any): "STORY" | "DEVELOP" | "ARTS" | null {
    const values = [
        task?.trace?.tapd?.workitem_type_key,
        task?.trace?.tapd?.workitem_type,
        ...(Array.isArray(task?.tags) ? task.tags : []),
    ];
    for (const value of values) {
        const text = String(value || "").trim().toLowerCase();
        if (!text) continue;
        if (/(^|[^a-z])(arts?|artwork)([^a-z]|$)|美术|视觉/.test(text)) return "ARTS";
        if (/develop|development|开发|研发|技术/.test(text)) return "DEVELOP";
        if (/story|requirement|需求|产品/.test(text)) return "STORY";
    }
    return null;
}

interface TaskTreeNode {
    task: any;
    depth: number;
    hasChildren: boolean;
}

function flattenTaskTree(tasks: any[]): TaskTreeNode[] {
    const byId = new Map<string, any>();
    const children = new Map<string, any[]>();
    for (const task of tasks) {
        const aliases = [task?.id, task?.tapd_story_id]
            .map(value => String(value || "").trim())
            .filter(Boolean);
        for (const alias of aliases) byId.set(alias, task);
    }
    const roots: any[] = [];
    for (const task of tasks) {
        const aliases = new Set([task?.id, task?.tapd_story_id].map(value => String(value || "").trim()).filter(Boolean));
        const parentId = String(task?.parent_id || "").trim();
        if (parentId && !aliases.has(parentId) && byId.has(parentId)) {
            const siblings = children.get(parentId) || [];
            siblings.push(task);
            children.set(parentId, siblings);
        } else {
            roots.push(task);
        }
    }
    const flattened: TaskTreeNode[] = [];
    const visited = new Set<any>();
    const visit = (task: any, depth: number) => {
        if (visited.has(task)) return;
        visited.add(task);
        const aliases = [task?.id, task?.tapd_story_id]
            .map(value => String(value || "").trim())
            .filter(Boolean);
        const descendants = aliases.flatMap(alias => children.get(alias) || []);
        flattened.push({ task, depth, hasChildren: descendants.length > 0 });
        for (const child of descendants) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);
    for (const task of tasks) visit(task, 0);
    return flattened;
}

function taskCard(node: TaskTreeNode): string {
    const { task } = node;
    const tapdUrl = safeTapdUrl(task.tapd_url);
    const title = tapdUrl
        ? `<a class="task-title" href="${escapeHtml(tapdUrl)}" target="_blank" rel="noopener noreferrer" title="在 TAPD 中打开">${escapeHtml(task.title)}<span class="external" aria-hidden="true">↗</span></a>`
        : `<span class="task-title static">${escapeHtml(task.title)}</span>`;
    const dateRange = `${shortDate(task.trace?.tapd?.begin_date)} — ${shortDate(task.due_date)}`;
    const depth = Math.min(Math.max(0, node.depth), 4);
    const classes = ["task-item", depth > 0 ? "child-node" : "", node.hasChildren ? "has-children" : ""].filter(Boolean).join(" ");
    const branch = depth > 0 ? `<span class="tree-branch" aria-hidden="true"></span>` : "";
    const typeLabel = taskTypeLabel(task);
    const typeBadge = typeLabel
        ? `<span class="task-type ${typeLabel.toLowerCase()}">${typeLabel}</span>`
        : "";
    return `<article class="${classes}" style="--depth:${depth}">
        <div class="task-title-line">${branch}${typeBadge}${title}</div>
        <div class="task-meta">
            <span>${escapeHtml(task.primary_owner_name || task.assignee_names?.join("、") || "未分配")}</span>
            <span class="status ${statusTone(task.status)}">${escapeHtml(weeklyTaskStatusLabel(task.status))}</span>
            <span class="date-range">${escapeHtml(dateRange)}</span>
        </div>
    </article>`;
}

function taskColumn(title: string, tasks: any[], tone: string): string {
    const tree = flattenTaskTree(tasks);
    const visible = tree.slice(0, 8);
    const hidden = tree.slice(8);
    const cards = visible.length
        ? visible.map(taskCard).join("")
        : `<div class="empty-state">本周期暂无</div>`;
    const expandable = hidden.length
        ? `<details class="task-more">
            <summary><span class="when-closed">展开其余 ${hidden.length} 项</span><span class="when-open">收起任务</span></summary>
            <div class="expanded-list">${hidden.map(taskCard).join("")}</div>
        </details>`
        : "";
    return `<section class="task-column ${tone}">
        <div class="column-head"><h3>${escapeHtml(title)}</h3><b>${tasks.length}</b></div>
        <div class="task-list">${cards}${expandable}</div>
    </section>`;
}

function changeFieldLabel(field: string): string {
    const labels: Record<string, string> = {
        status: "状态",
        tapd_status: "TAPD 状态",
        priority: "优先级",
        progress: "进度",
        primary_owner_name: "主负责人",
        owner: "负责人",
        developer: "开发人员",
        due_date: "截止日期",
        title: "标题",
    };
    return labels[field] || (/[\u4e00-\u9fff]/.test(field) ? field : "字段");
}

function changeFieldTone(field: string): "status" | "priority" | "progress" | "owner" | "date" | "general" {
    if (field === "status" || field === "tapd_status") return "status";
    if (field === "priority") return "priority";
    if (field === "progress") return "progress";
    if (["primary_owner_name", "owner", "developer"].includes(field)) return "owner";
    if (field === "due_date") return "date";
    return "general";
}

function changeValue(field: string, value: unknown): string {
    if (field === "status") return weeklyTaskStatusLabel(value);
    if (field === "tapd_status") return weeklyTaskStatusLabel(canonicalTapdStatus(value));
    const text = String(value ?? "").trim();
    return text || "未设置";
}

function renderTaskChanges(changes: WeeklyReportFacts["task_changes"]): string {
    if (!changes.length) return `<div class="empty-state">本周没有任务字段或状态流转</div>`;
    const items = changes.map(change => {
        const fields = Object.entries(change.changes || {});
        const flow = fields.length
            ? fields.map(([field, value]) => `<div class="change-flow ${changeFieldTone(field)}">
                <span class="field">${escapeHtml(changeFieldLabel(field))}</span>
                <span class="from">${escapeHtml(changeValue(field, value.from))}</span>
                <i>→</i>
                <strong class="to">${escapeHtml(changeValue(field, value.to))}</strong>
            </div>`).join("")
            : `<div class="change-flow"><span>${escapeHtml(change.summary)}</span></div>`;
        return `<article class="change-item">
            <time>${escapeHtml(shortDate(change.at))}</time>
            <div><h3>${escapeHtml(change.title)}</h3>${flow}</div>
        </article>`;
    }).join("");
    return `<div class="change-grid">${items}</div>`;
}

export function renderWeeklyReportHtml(facts: WeeklyReportFacts, _narrative: WeeklyNarrative): string {
    const metrics = facts.metrics;
    const percent = Math.round(metrics.standup_rate * 100);
    const title = `${facts.group.name} · ${facts.period.start} 至 ${facts.period.end} 周报`;
    const memberRows = facts.members.map(member => {
        const outputs = uniqueItems([
            ...member.completed_tasks.map(task => `完成：${task.title}`),
            ...member.yesterday_done,
        ], 3);
        const focus = uniqueItems([
            ...member.today_plan,
            ...member.active_tasks.map(task => task.title),
        ], 2);
        const risks = uniqueItems([...member.blockers, ...member.risks], 2);
        const memberRate = member.standup_expected
            ? Math.round(member.standup_submitted / member.standup_expected * 100)
            : 0;
        return `<tr>
            <td class="person"><div class="person-inner"><span class="avatar">${escapeHtml(member.name.slice(0, 1))}</span><div><strong>${escapeHtml(member.name)}</strong><small>站会 ${member.standup_submitted}/${member.standup_expected} · ${memberRate}%</small></div></div></td>
            <td>${compactList(outputs, "暂无已记录产出")}</td>
            <td>${compactList(focus, "暂无后续计划")}</td>
            <td><div class="member-kpis"><span><b>${member.new_tasks.length}</b> 新增</span><span><b>${member.completed_tasks.length}</b> 完成</span><span><b>${member.active_tasks.length}</b> 进行中</span></div></td>
            <td>${compactList(risks, "无")}</td>
        </tr>`;
    }).join("") || `<tr><td colspan="5" class="empty-state">暂无启用成员</td></tr>`;
    const recentOverdue = [...facts.overdue_tasks].sort((a, b) =>
        String(b.due_date || "").localeCompare(String(a.due_date || ""))
    );
    const degradedNotice = _narrative.ai_degraded
        ? `<aside class="degraded-notice">AI 服务本次不可用，本周报已按确定性事实模板生成；正文数字和任务事实不受影响。</aside>`
        : "";

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--paper:#f3f0e8;--sheet:#fffdfa;--ink:#18201c;--muted:#6b716d;--line:#d9d7ce;--orange:#f26a2e;--lime:#c8ed68;--mint:#dff3e8;--rose:#ffe1dc;--sky:#e5edf8}
*{box-sizing:border-box}html{background:var(--paper)}body{margin:0;color:var(--ink);font:14px/1.55 "Avenir Next","PingFang SC","Microsoft YaHei",sans-serif;background-image:linear-gradient(#d7d2c766 1px,transparent 1px),linear-gradient(90deg,#d7d2c744 1px,transparent 1px);background-size:32px 32px}
.page{max-width:1280px;margin:24px auto 48px;padding:0 18px}.hero{position:relative;overflow:hidden;padding:28px 30px 24px;border:1px solid #111;border-radius:4px;background:var(--ink);color:#fff;box-shadow:8px 8px 0 var(--orange)}
.hero:after{content:"";position:absolute;right:-35px;top:-70px;width:220px;height:220px;border:42px solid var(--lime);border-radius:50%;opacity:.95}
.hero h1{position:relative;z-index:1;margin:10px 0 5px;font:700 29px/1.25 "Songti SC","STSong","Noto Serif SC",serif;letter-spacing:.01em}.meta{position:relative;z-index:1;color:#bfc6c1;font-size:12px}
.degraded-notice{margin-top:18px;padding:12px 14px;border:1px solid #d99b25;border-left:5px solid #d99b25;border-radius:4px;background:#fff5d6;color:#6f4b00;font-weight:650}
.scoreboard{position:relative;z-index:1;display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));max-width:760px;margin-top:22px;border:1px solid #4b554e}.score{padding:10px 14px;border-right:1px solid #4b554e}.score:last-child{border:0}.score b{display:block;font-size:22px;line-height:1.1;color:var(--lime)}.score span{font-size:11px;color:#cbd0cc}
.panel{margin-top:18px;padding:22px;background:var(--sheet);border:1px solid var(--ink);border-radius:4px;box-shadow:4px 4px 0 #c8c4b9}.section-head{margin-bottom:14px}.section-head h2{margin:0;font:700 21px/1.2 "Songti SC","STSong","Noto Serif SC",serif}.section-note{margin:5px 0 0;color:var(--muted);font-size:12px}
.table-wrap{overflow-x:auto;border:1px solid var(--line)}table{width:100%;min-width:980px;border-collapse:collapse}th,td{text-align:left;padding:12px 11px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}th{background:#eeeae0;color:#555d57;font-size:11px;letter-spacing:.08em;font-weight:700}tbody tr:hover{background:#fcf8ec}
.person{min-width:135px}.person-inner{display:flex;align-items:center;gap:9px}.person strong,.person small{display:block}.person small{margin-top:3px;color:var(--muted);font-size:11px}.avatar{display:grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border-radius:50%;background:var(--ink);color:var(--lime);font-weight:700}
.compact-list{margin:0;padding-left:16px}.compact-list li{margin:0 0 4px}.compact-list li:last-child{margin:0}.empty{color:#9a9e9b}.member-kpis{display:flex;flex-wrap:wrap;gap:5px}.member-kpis span{padding:3px 7px;background:#efede6;border-radius:3px;white-space:nowrap;font-size:11px}.member-kpis b{font-size:13px}
.task-board{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.task-column{border:1px solid var(--ink);background:#fff}.task-column.new{border-top:5px solid var(--orange)}.task-column.done{border-top:5px solid #5bb485}.task-column.overdue{border-top:5px solid #d84d3f}.column-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#f0ede4;border-bottom:1px solid var(--line)}.column-head h3{margin:0;font-size:15px}.column-head b{display:grid;place-items:center;min-width:27px;height:27px;padding:0 7px;border-radius:50%;background:var(--ink);color:#fff}
.task-list{padding:0 12px}.task-item{position:relative;padding:11px 2px 11px calc(2px + var(--depth,0)*18px);border-bottom:1px dashed var(--line)}.task-title-line{display:flex;align-items:flex-start;gap:7px}.task-item.has-children>.task-title-line:before{content:"";width:6px;height:6px;flex:0 0 6px;margin-top:7px;background:var(--orange);transform:rotate(45deg)}.tree-branch{width:12px;height:13px;flex:0 0 12px;margin-top:-2px;border-left:1px solid #a8ada8;border-bottom:1px solid #a8ada8}.task-type{flex:0 0 auto;margin-top:2px;padding:1px 5px;border-radius:2px;color:#fff;font:700 8px/1.45 "Avenir Next",sans-serif;letter-spacing:.04em}.task-type.story{background:#3478f6}.task-type.develop{background:#7567e8}.task-type.arts{background:#d95e72}.task-title{font-weight:650;line-height:1.4;color:var(--ink)}a.task-title{text-decoration:underline;text-decoration-color:transparent;text-decoration-thickness:2px;text-underline-offset:4px;transition:color .18s ease,text-decoration-color .18s ease}a.task-title:hover{color:#c24718;text-decoration-color:var(--orange)}a.task-title:focus-visible{outline:2px solid var(--orange);outline-offset:3px;border-radius:2px}.external{display:inline-block;margin-left:5px;color:var(--orange);opacity:0;transform:translate(-3px,2px);transition:opacity .18s ease,transform .18s ease}a.task-title:hover .external,a.task-title:focus-visible .external{opacity:1;transform:translate(0,0)}
.task-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:7px;color:var(--muted);font-size:11px}.date-range{font-variant-numeric:tabular-nums}.status{padding:2px 7px;border-radius:20px;color:var(--ink)}.status.active{background:var(--sky)}.status.done{background:var(--mint)}.status.risk{background:var(--rose);color:#9b2e25}.status.test{background:#fff0b8}.empty-state{padding:28px 14px;text-align:center;color:var(--muted)}
.task-more summary{display:flex;align-items:center;justify-content:center;gap:7px;margin:0 -12px;padding:10px 12px;border-top:1px solid var(--line);background:#f6f3eb;color:var(--ink);font-size:12px;font-weight:700;cursor:pointer;list-style:none;transition:background .18s ease,color .18s ease}.task-more summary::-webkit-details-marker{display:none}.task-more summary:after{content:"＋";color:var(--orange);font-size:15px}.task-more summary:hover{background:var(--ink);color:#fff}.task-more[open]{display:flex;flex-direction:column}.task-more[open] summary{order:2}.task-more[open] .expanded-list{order:1}.task-more[open] summary:after{content:"－"}.task-more .when-open{display:none}.task-more[open] .when-closed{display:none}.task-more[open] .when-open{display:inline}.expanded-list .task-item:last-child{border-bottom:0}
.change-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.change-item{display:grid;grid-template-columns:45px 1fr;gap:10px;padding:12px;border:1px solid var(--line);border-left:3px solid #b8c8bf;background:#fff;transition:transform .16s ease,box-shadow .16s ease}.change-item:hover{transform:translateY(-1px);box-shadow:3px 3px 0 #d8d3c8}.change-item time{padding-top:2px;color:var(--orange);font:700 11px/1.2 "Avenir Next",sans-serif}.change-item h3{margin:0 0 8px;font-size:13px}.change-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;color:var(--muted);font-size:11px}.change-flow .field{padding:2px 7px;border-radius:3px;color:#fff;font-weight:700}.change-flow .from{padding:2px 5px;border-radius:3px;background:#f0efe9;color:#747b75}.change-flow i{color:var(--orange);font-style:normal;font-weight:700}.change-flow .to{padding:2px 6px;border:1px solid currentColor;border-radius:3px}.change-flow.status .field{background:#3478f6}.change-flow.status .to{color:#2563c8;background:#e7f0ff}.change-flow.priority .field{background:#c47b15}.change-flow.priority .to{color:#9a5a00;background:#fff0cb}.change-flow.progress .field{background:#127b73}.change-flow.progress .to{color:#087166;background:#dff6ef}.change-flow.owner .field{background:#7865d8}.change-flow.owner .to{color:#624db5;background:#eeeaff}.change-flow.date .field{background:#cf5148}.change-flow.date .to{color:#af382f;background:#ffe5e1}.change-flow.general .field{background:#263b34}.change-flow.general .to{color:#1e5f4d;background:#e2f1e9}
@media(max-width:900px){.task-board,.change-grid{grid-template-columns:1fr}.scoreboard{grid-template-columns:repeat(3,1fr)}.score:nth-child(3){border-right:0}.score:nth-child(-n+3){border-bottom:1px solid #4b554e}}
@media(max-width:560px){.page{margin-top:12px;padding:0 10px}.hero{padding:22px 18px}.hero h1{font-size:23px}.hero:after{right:-100px}.scoreboard{grid-template-columns:repeat(2,1fr)}.score{border-bottom:1px solid #4b554e}.score:nth-child(3){border-right:1px solid #4b554e}.score:nth-child(even){border-right:0}.panel{padding:15px}}
@media print{body{background:#fff}.page{max-width:none;margin:0}.hero,.panel{box-shadow:none;break-inside:avoid}.task-item,.change-item,tr{break-inside:avoid}}
</style>
</head>
<body><main class="page">
<header class="hero">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">数据截止 ${escapeHtml(facts.period.cutoff_at.slice(0, 10))}</div>
  <div class="scoreboard">
    <div class="score"><b>${metrics.active_members}</b><span>群成员</span></div>
    <div class="score"><b>${percent}%</b><span>站会提交率</span></div>
    <div class="score"><b>${metrics.new_tasks}</b><span>本周新增任务</span></div>
    <div class="score"><b>${metrics.completed_tasks}</b><span>本周完成任务</span></div>
    <div class="score"><b>${metrics.overdue_tasks}</b><span>近期超期任务</span></div>
  </div>
</header>
${degradedNotice}
<section class="panel">
  <div class="section-head"><h2>成员周度统计</h2></div>
  <div class="table-wrap"><table>
    <thead><tr><th>成员 / 站会</th><th>本周完成与产出</th><th>近期目标</th><th>任务统计</th><th>阻塞 / 风险</th></tr></thead>
    <tbody>${memberRows}</tbody>
  </table></div>
</section>
<section class="panel">
  <div class="section-head"><h2>任务概览</h2></div>
  <div class="task-board">
    ${taskColumn("本周新增任务", facts.new_tasks, "new")}
    ${taskColumn("本周完成任务", facts.completed_tasks, "done")}
    ${taskColumn("近期超期任务", recentOverdue, "overdue")}
  </div>
</section>
<section class="panel">
  <div class="section-head"><h2>本周任务变更</h2><p class="section-note">${facts.tapd_status_history_available ? "状态流转直接来自 TAPD 变更历史" : "状态历史暂不可用；仅展示已留存的同步变更"}</p></div>
  ${renderTaskChanges(facts.task_changes)}
</section>
</main></body></html>`;
}

export function writeWeeklyReportHtml(dataPath: string, filename: string, html: string): string {
    const reportDir = path.resolve(dataPath, "weekly-reports");
    fs.mkdirSync(reportDir, { recursive: true });
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputPath = path.join(reportDir, safeFilename);
    fs.writeFileSync(outputPath, html, "utf8");
    return outputPath;
}

export function isWeeklyReportPathAllowed(dataPath: string, candidate: string): boolean {
    const reportDir = path.resolve(dataPath, "weekly-reports");
    const resolved = path.resolve(candidate);
    return resolved.startsWith(`${reportDir}${path.sep}`) && path.extname(resolved).toLowerCase() === ".html";
}
