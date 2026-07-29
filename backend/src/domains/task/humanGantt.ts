import dayjs from 'dayjs';
import type { AppConfig } from '@/core/config';
import type { Task, TaskUpdate } from '@/models/types';
import {
    ensureWorkflow,
    memberDiscipline,
    workflowPhaseLabel,
    type TaskParticipantRole,
    type TaskWorkflowEvent,
} from './workflow';

export type GanttRole = 'product_requirement' | 'development' | 'testing' | 'product_acceptance' | 'creator';
export type HalfDayToken = `${string}-${'AM' | 'PM'}`;
export type WorkitemType = 'STORY' | 'DEVELOP' | 'ARTS';

export interface GanttSegment {
    id: string;
    role: GanttRole;
    kind: 'actual' | 'plan' | 'blocked';
    start: HalfDayToken;
    end: HalfDayToken;
    state: 'planned' | 'active' | 'completed' | 'blocked';
    editable: boolean;
    label: string;
}

export interface HumanGanttRow {
    id: string;
    employee: { open_id: string; name: string; department: string; department_label: string };
    task: {
        id: string;
        title: string;
        tapd_story_id: string | null;
        tapd_url: string | null;
        parent_id: string | null;
        status: string;
        status_label: string;
        phase: string;
        substate: string | null;
        priority: string;
        due_date: string | null;
        workitem_type: WorkitemType | null;
    };
    roles: GanttRole[];
    segments: GanttSegment[];
}

export interface HumanGanttData {
    generated_at: string;
    range: { from: string; to: string };
    departments: Array<{ id: string; name: string; member_count: number }>;
    members: Array<{ open_id: string; name: string; department: string; department_label: string }>;
    rows: HumanGanttRow[];
    summary: { people: number; tasks: number; active: number; blocked: number };
}

const roleLabels: Record<GanttRole, string> = {
    product_requirement: '需求撰写',
    development: '开发实现',
    testing: '测试验证',
    product_acceptance: '产品验收',
    creator: '任务发起',
};

const departmentLabels: Record<string, string> = {
    product: '产品部',
    development: '研发部',
    content: '内容部',
    unknown: '其他',
};

function halfDay(value: string | null | undefined, end = false): HalfDayToken | null {
    if (!value) return null;
    const parsed = dayjs(value);
    if (!parsed.isValid()) return null;
    const suffix = value.length <= 10 ? (end ? 'PM' : 'AM') : parsed.hour() < 12 ? 'AM' : 'PM';
    return `${parsed.format('YYYY-MM-DD')}-${suffix}` as HalfDayToken;
}

function tokenIndex(token: HalfDayToken): number {
    const date = token.slice(0, 10);
    const period = token.endsWith('-PM') ? 1 : 0;
    return dayjs(date).diff(dayjs('1970-01-01'), 'day') * 2 + period;
}

function validToken(value: string): value is HalfDayToken {
    if (!/^\d{4}-\d{2}-\d{2}-(AM|PM)$/.test(value)) return false;
    return dayjs(value.slice(0, 10), 'YYYY-MM-DD', true).isValid();
}

export async function employeeDirectory(config: AppConfig, store: any): Promise<Map<string, { open_id: string; name: string; department: string; department_label: string; is_active?: boolean }>> {
    const result = new Map<string, { open_id: string; name: string; department: string; department_label: string; is_active?: boolean }>();
    const companyMemberIds = new Set<string>();

    // First, populate from global CompanyMember table
    try {
        const companyMembers = await store.listCompanyMembers();
        for (const member of companyMembers) {
            if (member.open_id) companyMemberIds.add(member.open_id);
            if (!member.open_id || member.is_active === false) continue;
            let configGroupName = '';
            for (const group of config.groups || []) {
                if (group.name.includes('群')) continue; // 排除群聊名称作为部门
                if ((group.members || []).some(m => m.open_id === member.open_id)) {
                    configGroupName = group.name;
                    break;
                }
            }
            const fallbackDiscipline = memberDiscipline(config, member.open_id);
            const deptSource = member.department || configGroupName || fallbackDiscipline;
            const department = departmentLabels[deptSource] || deptSource;

            result.set(member.open_id, {
                open_id: member.open_id,
                name: member.name || member.open_id,
                department,
                department_label: department,
                is_active: member.is_active,
            });
        }
    } catch (e) {
        console.warn("Failed to load company members", e);
    }

    // Then, fallback to config.groups for any missing members (just in case)
    for (const group of config.groups || []) {
        if (group.name.includes('群')) continue;
        for (const member of group.members || []) {
            if (!member.open_id || member.is_active === false || companyMemberIds.has(member.open_id) || result.has(member.open_id)) continue;
            const rawRole = String(member.role || '').trim();
            const fallbackDiscipline = memberDiscipline(config, member.open_id);
            const deptSource = group.name || rawRole || fallbackDiscipline;
            const department = departmentLabels[deptSource] || deptSource;

            result.set(member.open_id, {
                open_id: member.open_id,
                name: member.name || member.open_id,
                department,
                department_label: department,
            });
        }
    }
    return result;
}

function roleForParticipant(role: TaskParticipantRole): GanttRole {
    if (role === 'product') return 'product_requirement';
    if (role === 'developer') return 'development';
    if (role === 'tester') return 'testing';
    return 'creator';
}

function normalizedName(value: unknown): string {
    return String(value || '').trim().replace(/\s+/g, '');
}

function workitemType(task: Task): WorkitemType | null {
    const key = String(task.trace?.tapd?.workitem_type_key || task.trace?.tapd?.workitem_type || '').trim().toUpperCase();
    return key === 'STORY' || key === 'DEVELOP' || key === 'ARTS' ? key : null;
}

function participantRoles(
    task: Task,
    config: AppConfig,
    directory: Map<string, { open_id: string; name: string; department: string; department_label: string; is_active?: boolean }>,
): Map<string, Set<GanttRole>> {
    const workflow = ensureWorkflow(task, config);
    const result = new Map<string, Set<GanttRole>>();
    const employeeIdByName = new Map<string, string>();
    for (const employee of directory.values()) {
        const name = normalizedName(employee.name);
        if (name && !employeeIdByName.has(name)) employeeIdByName.set(name, employee.open_id);
    }
    const resolveEmployeeId = (openId?: string, name?: string) => {
        if (openId && directory.has(openId)) return openId;
        return employeeIdByName.get(normalizedName(name)) || '';
    };
    const add = (openId: string | undefined, role: GanttRole) => {
        if (!openId) return;
        if (!result.has(openId)) result.set(openId, new Set());
        result.get(openId)!.add(role);
    };
    const assignees = new Set<string>();
    const assigneeNames = task.assignee_names || [];
    for (let index = 0; index < Math.max(task.assignee_open_ids?.length || 0, assigneeNames.length); index++) {
        const employeeId = resolveEmployeeId(task.assignee_open_ids?.[index], assigneeNames[index]);
        if (employeeId) assignees.add(employeeId);
    }
    for (const role of ['product', 'developer', 'tester'] as TaskParticipantRole[]) {
        const person = workflow.roles[role];
        const openId = resolveEmployeeId(person?.open_id, person?.name);
        if (openId && assignees.has(openId)) {
            add(openId, roleForParticipant(role));
        }
    }
    const productId = resolveEmployeeId(workflow.roles.product?.open_id, workflow.roles.product?.name);
    if (productId && assignees.has(productId)) {
        add(productId, 'product_acceptance');
    }
    const type = workitemType(task);
    assignees.forEach(openId => {
        if (!result.has(openId)) {
            const role = type === 'STORY' || workflow.phase === 'requirement' || memberDiscipline(config, openId) === 'product'
                ? 'product_requirement'
                : 'development';
            add(openId, role);
        }
    });
    return result;
}

function pairSegments(events: TaskWorkflowEvent[], startTypes: string[], endTypes: string[], role: GanttRole, now: string): GanttSegment[] {
    const result: GanttSegment[] = [];
    let opened: TaskWorkflowEvent | null = null;
    for (const event of events) {
        if (startTypes.includes(event.type)) {
            if (opened) {
                const start = halfDay(opened.at);
                const end = halfDay(event.at, true);
                if (start && end) result.push(actualSegment(role, start, end, 'completed', result.length));
            }
            opened = event;
            continue;
        }
        if (opened && endTypes.includes(event.type)) {
            const start = halfDay(opened.at);
            const end = halfDay(event.at, true);
            if (start && end) result.push(actualSegment(role, start, end, 'completed', result.length));
            opened = null;
        }
    }
    if (opened) {
        const start = halfDay(opened.at);
        const end = halfDay(now, true);
        if (start && end) result.push(actualSegment(role, start, end, 'active', result.length));
    }
    return result;
}

function actualSegment(role: GanttRole, start: HalfDayToken, end: HalfDayToken, state: 'active' | 'completed', index: number): GanttSegment {
    return { id: `actual-${role}-${index}`, role, kind: 'actual', start, end, state, editable: false, label: roleLabels[role] };
}

function historySegments(task: Task, role: GanttRole, now: string): GanttSegment[] {
    const events = [...(task.trace?.workflow?.history || [])].sort((a: TaskWorkflowEvent, b: TaskWorkflowEvent) => a.at.localeCompare(b.at));
    if (events.length === 0) return [];
    if (role === 'product_requirement') return pairSegments(events, ['product_accepted'], ['requirement_completed'], role, now);
    if (role === 'development') return pairSegments(events, ['developer_accepted', 'reopened'], ['development_completed'], role, now);
    if (role === 'testing') return pairSegments(events, ['testing_started'], ['test_passed', 'reopened'], role, now);
    if (role === 'product_acceptance') return pairSegments(events, ['test_passed'], ['product_accepted', 'reopened'], role, now);
    return [];
}

function legacySegment(task: Task, role: GanttRole, now: string): GanttSegment[] {
    const workflow = task.trace?.workflow;
    const begin = halfDay(task.trace?.tapd?.begin_date || task.created_at);
    if (!begin) return [];
    const completed = halfDay(task.trace?.tapd?.completed_at || task.updated_at, true) || halfDay(now, true)!;
    const currentPhase = workflow?.phase || 'development';
    if (role === 'product_requirement') {
        const end = halfDay(task.trace?.tapd?.begin_date || task.updated_at, true) || completed;
        return [actualSegment(role, begin, end, currentPhase === 'draft' || currentPhase === 'requirement' ? 'active' : 'completed', 0)];
    }
    if (role === 'development' && ['development', 'development_completed', 'transfer_test', 'testing', 'implemented'].includes(currentPhase)) {
        const start = halfDay(task.trace?.tapd?.begin_date || task.created_at) || begin;
        const state = currentPhase === 'development' ? 'active' : 'completed';
        return [actualSegment(role, start, state === 'active' ? halfDay(now, true)! : completed, state, 0)];
    }
    if (role === 'testing' && ['transfer_test', 'testing', 'implemented'].includes(currentPhase)) {
        return [actualSegment(role, halfDay(task.updated_at) || begin, currentPhase === 'testing' ? halfDay(now, true)! : completed, currentPhase === 'testing' ? 'active' : 'completed', 0)];
    }
    return [];
}

function blockedSegments(task: Task, employeeId: string, now: string): GanttSegment[] {
    const events = [...(task.trace?.workflow?.history || [])].sort((a: TaskWorkflowEvent, b: TaskWorkflowEvent) => a.at.localeCompare(b.at));
    const result: GanttSegment[] = [];
    let opened: TaskWorkflowEvent | null = null;
    for (const event of events) {
        if (event.type === 'blocked' && event.actor_open_id === employeeId) opened = event;
        if (event.type === 'unblocked' && opened) {
            const start = halfDay(opened.at);
            const end = halfDay(event.at, true);
            if (start && end) result.push({ id: `blocked-${result.length}`, role: 'development', kind: 'blocked', start, end, state: 'blocked', editable: false, label: '挂起' });
            opened = null;
        }
    }
    if (opened) {
        const start = halfDay(opened.at);
        const end = halfDay(now, true);
        if (start && end) result.push({ id: `blocked-${result.length}`, role: 'development', kind: 'blocked', start, end, state: 'blocked', editable: false, label: '挂起' });
    }
    return result;
}

function plannedSegments(task: Task, employeeId: string): GanttSegment[] {
    const plans = Array.isArray(task.trace?.gantt_plans) ? task.trace.gantt_plans : [];
    return plans
        .filter((plan: any) => plan.employee_open_id === employeeId && validToken(plan.start) && validToken(plan.end))
        .map((plan: any) => ({
            id: plan.id,
            role: plan.role as GanttRole,
            kind: 'plan' as const,
            start: plan.start as HalfDayToken,
            end: plan.end as HalfDayToken,
            state: 'planned' as const,
            editable: true,
            label: `${roleLabels[plan.role as GanttRole] || '计划'}计划`,
        }));
}

function withinRange(segment: GanttSegment, from: string, to: string): boolean {
    const rangeStart = tokenIndex(`${from}-AM` as HalfDayToken);
    const rangeEnd = tokenIndex(`${to}-PM` as HalfDayToken);
    return tokenIndex(segment.end) >= rangeStart && tokenIndex(segment.start) <= rangeEnd;
}

export class HumanGanttService {
    static async build(store: any, config: AppConfig, options: { from?: string; to?: string; includeImplemented?: boolean } = {}): Promise<HumanGanttData> {
        const now = dayjs().toISOString();
        const from = dayjs(options.from || dayjs().startOf('month')).format('YYYY-MM-DD');
        const to = dayjs(options.to || dayjs().endOf('month')).format('YYYY-MM-DD');
        const directory = await employeeDirectory(config, store);
        const tasks: Task[] = await store.listTasks();
        const rows: HumanGanttRow[] = [];

        const threeMonthsAgo = dayjs(now).subtract(3, 'month').format('YYYY-MM-DD');
        for (const task of tasks) {
            if (["deleted", "cancelled", "status_20", "已删除", "已取消"].includes(task.status)) continue;
            if (!task.tapd_story_id) continue;

            const d1 = dayjs(task.due_date || '1970-01-01').format('YYYY-MM-DD');
            const d2 = dayjs(task.trace?.tapd?.modified || task.trace?.tapd?.completed_at || '1970-01-01').format('YYYY-MM-DD');
            const d3 = dayjs(task.created_at || '1970-01-01').format('YYYY-MM-DD');
            const latestTime = [d1, d2, d3].sort().reverse()[0];
            if (latestTime !== '1970-01-01' && latestTime < threeMonthsAgo) continue;

            const workflow = ensureWorkflow(task, config);
            if (!options.includeImplemented && workflow.phase === 'implemented') continue;
            const rolesByEmployee = participantRoles(task, config, directory);
            for (const [employeeId, roles] of rolesByEmployee) {
                const configured = directory.get(employeeId);
                const nameIndex = (task.assignee_open_ids || []).indexOf(employeeId);
                const name = configured?.name || (employeeId === task.creator_open_id ? task.creator_name : task.assignee_names?.[nameIndex]) || employeeId;
                let configGroupName = '';
                for (const group of config.groups || []) {
                    if ((group.members || []).some(m => m.open_id === employeeId)) {
                        configGroupName = group.name;
                        break;
                    }
                }
                const fallback = memberDiscipline(config, employeeId);
                const department = configured?.department || configGroupName || fallback;
                const employee = configured || { open_id: employeeId, name, department, department_label: configGroupName || departmentLabels[fallback] || department };
                const segments: GanttSegment[] = [];
                for (const role of roles) {
                    const actual = historySegments(task, role, now);
                    segments.push(...(actual.length ? actual : legacySegment(task, role, now)));
                }
                segments.push(...plannedSegments(task, employeeId), ...blockedSegments(task, employeeId, now));
                const visibleSegments = segments.filter(segment => withinRange(segment, from, to));
                if (visibleSegments.length === 0 && workflow.phase === 'implemented') continue;
                rows.push({
                    id: `${employeeId}:${task.id}`,
                    employee,
                    task: {
                        id: task.id,
                        title: task.title,
                        tapd_story_id: task.tapd_story_id || null,
                        tapd_url: task.tapd_url || null,
                        parent_id: task.parent_id || null,
                        status: task.status,
                        status_label: workflowPhaseLabel(workflow),
                        phase: workflow.phase,
                        substate: workflow.substate,
                        priority: task.priority,
                        due_date: task.due_date || null,
                        workitem_type: workitemType(task),
                    },
                    roles: [...roles],
                    segments: visibleSegments,
                });
            }
        }

        const employeesWithTasks = new Set(rows.map(r => r.employee.open_id));
        for (const member of directory.values()) {
            if (!employeesWithTasks.has(member.open_id)) {
                rows.push({
                    id: `dummy-${member.open_id}`,
                    employee: member,
                    task: {
                        id: `dummy-task-${member.open_id}`,
                        title: '暂无任务',
                        tapd_story_id: null,
                        tapd_url: null,
                        parent_id: null,
                        status: 'idle',
                        status_label: '空闲',
                        phase: 'idle',
                        substate: null,
                        priority: '--',
                        due_date: null,
                        workitem_type: null,
                    },
                    roles: [],
                    segments: [],
                });
            }
        }

        rows.sort((a, b) => a.employee.department.localeCompare(b.employee.department) || a.employee.name.localeCompare(b.employee.name) || a.task.title.localeCompare(b.task.title));

        // Return ALL members from the directory so the dropdowns match the company structure
        const members = [...directory.values()];
        const departments = [...new Set(members.map(member => member.department))].map(id => ({
            id,
            name: members.find(m => m.department === id)?.department_label || departmentLabels[id] || id,
            member_count: members.filter(member => member.department === id).length,
        }));
        return {
            generated_at: now,
            range: { from, to },
            departments,
            members,
            rows,
            summary: {
                people: new Set(rows.map(row => row.employee.open_id)).size,
                tasks: new Set(rows.filter(row => !row.task.id.startsWith('dummy-')).map(row => row.task.id)).size,
                active: new Set(rows.filter(row => ['development', 'development_completed', 'transfer_test', 'testing'].includes(row.task.phase)).map(row => row.task.id)).size,
                blocked: new Set(rows.filter(row => row.segments.some(segment => segment.state === 'blocked')).map(row => row.task.id)).size,
            },
        };
    }

    static async savePlan(store: any, taskId: string, input: { employee_open_id: string; role: GanttRole; start: string; end: string }): Promise<any> {
        if (!input.employee_open_id || !validToken(input.start) || !validToken(input.end) || tokenIndex(input.end) < tokenIndex(input.start)) {
            throw new Error('计划时间必须使用有效的半天范围');
        }
        if (!Object.prototype.hasOwnProperty.call(roleLabels, input.role)) throw new Error('无效的参与角色');
        const task = await store.findTask(taskId);
        if (!task) throw new Error('任务不存在');
        const participants = new Set([task.creator_open_id, ...(task.assignee_open_ids || []), ...Object.values(task.trace?.workflow?.roles || {}).map((item: any) => item?.open_id)].filter(Boolean));
        if (!participants.has(input.employee_open_id)) throw new Error('该员工不是任务参与人');
        task.trace = task.trace && typeof task.trace === 'object' ? task.trace : {};
        const plans = Array.isArray(task.trace.gantt_plans) ? [...task.trace.gantt_plans] : [];
        const id = `${input.employee_open_id}:${input.role}`;
        const next = { id, ...input, updated_at: new Date().toISOString() };
        const index = plans.findIndex((plan: any) => plan.id === id);
        if (index >= 0) plans[index] = next;
        else plans.push(next);
        task.trace.gantt_plans = plans;
        task.updated_at = new Date().toISOString();
        await store.saveTask(task);
        await store.appendAuditLog('task_gantt_plan_updated', { task_id: task.id, ...next });
        return next;
    }

    static async deletePlan(store: any, taskId: string, input: { employee_open_id: string; role: GanttRole }): Promise<any> {
        if (!input.employee_open_id || !Object.prototype.hasOwnProperty.call(roleLabels, input.role)) {
            throw new Error('无效的人员计划');
        }
        const task = await store.findTask(taskId);
        if (!task) throw new Error('任务不存在');
        const plans = Array.isArray(task.trace?.gantt_plans) ? [...task.trace.gantt_plans] : [];
        const id = `${input.employee_open_id}:${input.role}`;
        const plan = plans.find((item: any) => item.id === id);
        if (!plan) throw new Error('计划不存在');
        task.trace.gantt_plans = plans.filter((item: any) => item.id !== id);
        task.updated_at = new Date().toISOString();
        await store.saveTask(task);
        await store.appendAuditLog('task_gantt_plan_deleted', { task_id: task.id, ...plan });
        return plan;
    }
}
