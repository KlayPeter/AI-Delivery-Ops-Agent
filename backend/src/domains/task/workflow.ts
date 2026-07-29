import type { AppConfig } from '@/core/config';
import type { Mention, Task } from '@/models/types';

export type TaskWorkflowPhase =
    | 'draft'
    | 'requirement'
    | 'development'
    | 'development_completed'
    | 'transfer_test'
    | 'testing'
    | 'implemented';

export type TaskParticipantRole = 'creator' | 'product' | 'developer' | 'tester';

export interface WorkflowPerson {
    open_id: string;
    name: string;
}

export interface TaskWorkflowEvent {
    type: string;
    at: string;
    actor_open_id?: string;
    actor_name?: string;
    phase: TaskWorkflowPhase;
    detail?: string;
}

export interface TaskWorkflowSnapshot {
    phase: TaskWorkflowPhase;
    substate: string | null;
    blocked: boolean;
    resume_phase: TaskWorkflowPhase | null;
    resume_status: string | null;
    pending_role: 'product' | 'developer' | null;
    pending_acceptances: string[];
    accepted_open_ids: string[];
    roles: Record<TaskParticipantRole, WorkflowPerson | null>;
    history: TaskWorkflowEvent[];
}

export function person(open_id?: string, name?: string): WorkflowPerson | null {
    if (!open_id && !name) return null;
    return { open_id: open_id || '', name: name || '' };
}

function groupDiscipline(name: string): 'product' | 'development' | 'content' | 'unknown' {
    const normalized = name.toLowerCase();
    if (/(产品|设计|product|design)/.test(normalized)) return 'product';
    if (/(研发|开发|development|\bdev\b)/.test(normalized)) return 'development';
    if (/(内容|content)/.test(normalized)) return 'content';
    return 'unknown';
}

function positionDiscipline(value: string): 'product' | 'development' | 'content' | 'unknown' {
    const normalized = value.toLowerCase().trim();
    if (!normalized) return 'unknown';
    if (/(产品|product|产品经理|需求分析|业务分析|商业分析|用户研究|设计|design|交互|\bpm\b|\bba\b|\bui\b|\bux\b)/.test(normalized)) return 'product';
    if (/(研发|开发|前端|后端|客户端|服务端|全栈|工程师|工程|程序员|程序|技术|架构|算法|数据|安全|测试|测开|自动化|运维|技术支持|实施|硬件|嵌入式|机器学习|\brd\b|\br&d\b|\bdev\b|\bqa\b|\bqe\b|\bsre\b|\bdba\b|devops|ios|android|java|golang|python|web)/.test(normalized)) return 'development';
    if (/(内容|编辑|编导|文案|策划|运营|市场|品牌|媒介|content|editor|operation|marketing)/.test(normalized)) return 'content';
    return 'unknown';
}

export function memberDiscipline(config: AppConfig | undefined, openId: string): 'product' | 'development' | 'content' | 'unknown' {
    if (!openId) return 'unknown';
    const memberships = (config?.groups || [])
        .map(group => ({ group, member: (group.members || []).find(item => item.open_id === openId) }))
        .filter(item => item.member);
    for (const { member } of memberships) {
        const discipline = positionDiscipline(String(member?.role || ''));
        if (discipline !== 'unknown') return discipline;
    }
    for (const { member } of memberships) {
        const discipline = positionDiscipline(String(member?.job_title || ''));
        if (discipline !== 'unknown') return discipline;
    }
    for (const { group } of memberships) {
        const discipline = groupDiscipline(group.name || '');
        if (discipline !== 'unknown') return discipline;
    }
    return 'unknown';
}

function phaseFromLegacyStatus(status: string): TaskWorkflowPhase {
    if (['accepted', 'status_5', 'implemented', 'done', 'completed'].includes(status)) return 'implemented';
    if (status === 'testing') return 'testing';
    if (['owner_marked_done', 'status_3'].includes(status)) return 'transfer_test';
    if (status === 'development_completed') return 'development_completed';
    if (['confirmed', 'in_progress', 'status_14', 'blocked', 'overdue'].includes(status)) return 'development';
    if (['requirement', 'status_2'].includes(status)) return 'requirement';
    return 'draft';
}

export function ensureWorkflow(task: Task, config?: AppConfig): TaskWorkflowSnapshot {
    task.trace = task.trace && typeof task.trace === 'object' ? task.trace : {};
    const existing = task.trace.workflow as Partial<TaskWorkflowSnapshot> | undefined;
    const legacyRoles = task.trace.roles || {};
    const inferredPhase = existing?.phase || phaseFromLegacyStatus(task.status);
    const primaryDiscipline = memberDiscipline(config, task.primary_owner_open_id);
    const creatorDiscipline = memberDiscipline(config, task.creator_open_id);
    const creator = existing?.roles?.creator || legacyRoles.creator || person(task.creator_open_id, task.creator_name);
    const developer = existing?.roles?.developer || legacyRoles.developer || (
        primaryDiscipline === 'product' || inferredPhase === 'requirement' ? null : person(task.primary_owner_open_id, task.primary_owner_name)
    );
    const tester = existing?.roles?.tester || legacyRoles.tester || null;
    const product = existing?.roles?.product || legacyRoles.product || (
        primaryDiscipline === 'product' || inferredPhase === 'requirement'
            ? person(task.primary_owner_open_id, task.primary_owner_name)
            : creatorDiscipline === 'product' ? person(task.creator_open_id, task.creator_name) : null
    );
    const pendingRole = existing?.pending_role ?? (
        phaseFromLegacyStatus(task.status) === 'draft'
            ? memberDiscipline(config, task.primary_owner_open_id) === 'product' ? 'product' : 'developer'
            : null
    );

    const workflow: TaskWorkflowSnapshot = {
        phase: inferredPhase,
        substate: existing?.substate ?? null,
        blocked: existing?.blocked ?? task.status === 'blocked',
        resume_phase: existing?.resume_phase ?? null,
        resume_status: existing?.resume_status ?? null,
        pending_role: pendingRole,
        pending_acceptances: [...(existing?.pending_acceptances || [])],
        accepted_open_ids: [...(existing?.accepted_open_ids || [])],
        roles: { creator, product, developer, tester },
        history: [...(existing?.history || [])],
    };
    task.trace.workflow = workflow;
    task.trace.roles = workflow.roles;
    return workflow;
}

export function initializeWorkflow(task: Task, config: AppConfig | undefined, createdAt: string): TaskWorkflowSnapshot {
    const workflow = ensureWorkflow(task, config);
    workflow.phase = 'draft';
    workflow.substate = 'waiting_acceptance';
    workflow.blocked = false;
    workflow.pending_role = memberDiscipline(config, task.primary_owner_open_id) === 'product' ? 'product' : 'developer';
    workflow.pending_acceptances = [...new Set((task.assignee_open_ids || []).filter(Boolean))];
    workflow.accepted_open_ids = [];
    if (workflow.pending_role === 'product') {
        workflow.roles.product = person(task.primary_owner_open_id, task.primary_owner_name);
        workflow.roles.developer = null;
    } else {
        workflow.roles.developer = person(task.primary_owner_open_id, task.primary_owner_name);
    }
    workflow.history = [{ type: 'created', at: createdAt, phase: 'draft', actor_open_id: task.creator_open_id, actor_name: task.creator_name }];
    task.trace.roles = workflow.roles;
    return workflow;
}

export function recordWorkflowEvent(
    workflow: TaskWorkflowSnapshot,
    event: Omit<TaskWorkflowEvent, 'phase'> & { phase?: TaskWorkflowPhase },
): void {
    workflow.history.push({ ...event, phase: event.phase || workflow.phase });
}

export function setWorkflowPhase(
    workflow: TaskWorkflowSnapshot,
    phase: TaskWorkflowPhase,
    event: Omit<TaskWorkflowEvent, 'phase'>,
    substate: string | null = null,
): void {
    workflow.phase = phase;
    workflow.substate = substate;
    workflow.pending_role = null;
    workflow.accepted_open_ids = [];
    recordWorkflowEvent(workflow, { ...event, phase });
}

export function mentionedPeople(mentions: Mention[] | undefined, botOpenId?: string, senderOpenId?: string): WorkflowPerson[] {
    const byId = new Map<string, WorkflowPerson>();
    for (const mention of mentions || []) {
        if (!mention.open_id || mention.open_id === botOpenId || mention.open_id === senderOpenId) continue;
        byId.set(mention.open_id, { open_id: mention.open_id, name: mention.name || mention.open_id });
    }
    return [...byId.values()];
}

export function workflowRoleForOpenId(workflow: TaskWorkflowSnapshot, openId: string): TaskParticipantRole | null {
    for (const role of ['product', 'developer', 'tester', 'creator'] as TaskParticipantRole[]) {
        if (workflow.roles[role]?.open_id === openId) return role;
    }
    return null;
}

export function legacyStatusForPhase(phase: TaskWorkflowPhase): string {
    if (phase === 'draft') return 'pending_confirmation';
    if (phase === 'requirement') return 'requirement';
    if (phase === 'development') return 'in_progress';
    if (phase === 'development_completed') return 'development_completed';
    if (phase === 'transfer_test') return 'owner_marked_done';
    if (phase === 'testing') return 'testing';
    return 'accepted';
}

export function workflowPhaseLabel(workflow: TaskWorkflowSnapshot): string {
    const labels: Record<TaskWorkflowPhase, string> = {
        draft: '草案',
        requirement: '需求',
        development: '开发进行中',
        development_completed: '开发完成',
        transfer_test: '转测试',
        testing: workflow.substate === 'pending_product_acceptance' ? '测试进行中 · 待产品验收' : '测试进行中',
        implemented: '已实现',
    };
    return `${labels[workflow.phase]}${workflow.blocked ? ' · 已挂起' : ''}`;
}
