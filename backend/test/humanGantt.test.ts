import { describe, expect, test } from 'bun:test';
import { HumanGanttService } from '@/domains/task/humanGantt';
import { TaskService } from '@/services/taskService';

const config: any = {
    groups: [
        { chat_id: 'oc_demo_product', name: 'Demo 产品设计组', members: [{ open_id: 'ou_product', name: '林产品', is_active: true }] },
        { chat_id: 'oc_demo_dev', name: 'Demo 研发组', members: [{ open_id: 'ou_dev', name: '陈开发', is_active: true }] },
    ],
};

function developmentTask(): any {
    return {
        id: 'task-payment',
        title: '支付流程优化迭代',
        status: 'in_progress',
        priority: 'P1',
        tapd_story_id: '1112345678001003001',
        tapd_url: 'https://tapd.test/1112345678001003001',
        creator_open_id: 'ou_product',
        creator_name: '林产品',
        primary_owner_open_id: 'ou_dev',
        primary_owner_name: '陈开发',
        assignee_open_ids: ['ou_product', 'ou_dev'],
        assignee_names: ['林产品', '陈开发'],
        source_message_id: 'om_1',
        source_group_id: 'oc_demo_product',
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-08T09:00:00Z',
        trace: {
            tapd: { status: 'status_14', begin_date: '2026-07-05' },
            workflow: {
                phase: 'development',
                substate: null,
                blocked: false,
                resume_phase: null,
                resume_status: null,
                pending_role: null,
                pending_acceptances: [],
                accepted_open_ids: [],
                roles: {
                    creator: { open_id: 'ou_product', name: '林产品' },
                    product: { open_id: 'ou_product', name: '林产品' },
                    developer: { open_id: 'ou_dev', name: '陈开发' },
                    tester: null,
                },
                history: [
                    { type: 'created', at: '2026-07-01T09:00:00Z', phase: 'draft' },
                    { type: 'product_accepted', at: '2026-07-01T10:00:00Z', phase: 'requirement', actor_open_id: 'ou_product' },
                    { type: 'requirement_completed', at: '2026-07-04T16:00:00Z', phase: 'requirement', actor_open_id: 'ou_product' },
                    { type: 'developer_accepted', at: '2026-07-05T09:00:00Z', phase: 'development', actor_open_id: 'ou_dev' },
                ],
            },
        },
    };
}

function ganttStore(tasks: any[]) {
    return {
        listTasks: async () => tasks,
        listCompanyMembers: async () => [
            { open_id: 'ou_product', name: '林产品', department: '产品部', is_active: true },
            { open_id: 'ou_dev', name: '陈开发', department: '研发部', is_active: true },
        ],
    };
}

describe('HumanGanttService', () => {
    test('keeps the global development status on both product and developer rows while using personal segments', async () => {
        const task = developmentTask();
        const store = ganttStore([task]);
        const data = await HumanGanttService.build(store, config, { from: '2026-07-01', to: '2026-07-31' });
        const productRow = data.rows.find(row => row.employee.open_id === 'ou_product');
        const developerRow = data.rows.find(row => row.employee.open_id === 'ou_dev');

        expect(productRow?.task.status_label).toBe('开发进行中');
        expect(developerRow?.task.status_label).toBe('开发进行中');
        expect(productRow?.employee.department_label).toBe('产品部');
        expect(developerRow?.employee.department_label).toBe('研发部');
        expect(productRow?.segments).toContainEqual(expect.objectContaining({ role: 'product_requirement', state: 'completed', editable: false }));
        expect(developerRow?.segments).toContainEqual(expect.objectContaining({ role: 'development', state: 'active', editable: false }));
        expect(data.summary).toMatchObject({ people: 2, tasks: 1, active: 1 });
    });

    test('hides implemented tasks by default and can include them explicitly', async () => {
        const task = developmentTask();
        task.status = 'accepted';
        task.trace.workflow.phase = 'implemented';
        const store = ganttStore([task]);
        const hidden = await HumanGanttService.build(store, config, { from: '2026-07-01', to: '2026-07-31' });
        const visible = await HumanGanttService.build(store, config, { from: '2026-07-01', to: '2026-07-31', includeImplemented: true });
        expect(hidden.rows.filter(row => row.task.id === task.id)).toHaveLength(0);
        expect(hidden.rows.every(row => row.task.status === 'idle')).toBe(true);
        expect(visible.rows.find(row => row.task.id === task.id)?.task.status_label).toBe('已实现');
    });

    test('shows development completed as a separate phase and closes the development segment', async () => {
        const task = developmentTask();
        task.status = 'development_completed';
        task.updated_at = '2026-07-08T16:00:00Z';
        task.trace.workflow.phase = 'development_completed';
        task.trace.workflow.history.push({
            type: 'development_completed',
            at: '2026-07-08T16:00:00Z',
            phase: 'development_completed',
            actor_open_id: 'ou_dev',
        });
        const store = ganttStore([task]);
        const data = await HumanGanttService.build(store, config, { from: '2026-07-01', to: '2026-07-31' });
        const developerRow = data.rows.find(row => row.employee.open_id === 'ou_dev');

        expect(developerRow?.task).toMatchObject({ phase: 'development_completed', status_label: '开发完成' });
        expect(developerRow?.segments).toContainEqual(expect.objectContaining({ role: 'development', state: 'completed' }));
        expect(data.summary.active).toBe(1);
    });

    test('maps TAPD status_21 to development completed before building gantt rows', async () => {
        const tasks: any[] = [];
        const store = {
            listTasks: async () => tasks,
            saveTask: async (task: any) => {
                const index = tasks.findIndex(item => item.id === task.id);
                if (index >= 0) tasks[index] = task;
                else tasks.push(task);
            },
            listCompanyMembers: async () => [
                { open_id: 'ou_product', name: '林产品', department: '产品部', is_active: true },
                { open_id: 'ou_dev', name: '陈开发', department: '研发部', is_active: true },
            ],
        };
        const tapd = {
            listStories: async () => ({
                ok: true,
                raw: {
                    data: [{
                        Story: {
                            id: '1112345678001001033',
                            name: '界面开发',
                            status: 'status_21',
                            owner: '陈开发',
                            creator: '林产品',
                            created: '2026-07-01T09:00:00Z',
                            modified: '2026-07-14T10:00:00Z',
                            due: '2026-07-31',
                        },
                    }],
                },
            }),
            storyUrl: (storyId: string) => `https://tapd.test/${storyId}`,
        };

        await TaskService.syncProjectScope({ store, tapd, config });
        const data = await HumanGanttService.build(store, config, { from: '2026-07-01', to: '2026-07-31' });
        const row = data.rows.find(item => item.task.title === '界面开发');

        expect(tasks[0].status).toBe('development_completed');
        expect(row?.task).toMatchObject({ phase: 'development_completed', status_label: '开发完成' });
    });

    test('maps TAPD name-only assignees to active directory members and keeps parent STORY workitems visible', async () => {
        const tasks: any[] = [];
        const store = {
            listTasks: async () => tasks,
            saveTask: async (task: any) => {
                const index = tasks.findIndex(item => item.id === task.id);
                if (index >= 0) tasks[index] = task;
                else tasks.push(task);
            },
            listCompanyMembers: async () => [
                { open_id: 'ou_product', name: '林产品', department: '产品部', is_active: true },
                { open_id: 'ou_he', name: '设计同学', department: '产品设计部', is_active: true },
            ],
        };
        const tapd = {
            listStories: async () => ({
                ok: true,
                raw: {
                    data: [{
                        Story: {
                            id: 'parent-story',
                            name: '三方牌谱文件上传',
                            status: 'status_2',
                            workitem_type: 'STORY',
                            owner: '设计同学',
                            creator: '林产品',
                            created: '2026-07-01T09:00:00Z',
                            modified: '2026-07-14T10:00:00Z',
                            due: '2026-07-31',
                        },
                    }],
                },
            }),
            storyUrl: (storyId: string) => `https://tapd.test/${storyId}`,
        };

        await TaskService.syncProjectScope({ store, tapd, config });
        tasks.push({
            ...developmentTask(),
            id: 'child-develop',
            tapd_story_id: 'child-develop',
            parent_id: 'parent-story',
        });
        const data = await HumanGanttService.build(store, config, { from: '2026-07-01', to: '2026-07-31' });
        const parentRow = data.rows.find(row => row.task.id === 'tapd-parent-story' && row.employee.open_id === 'ou_he');

        expect(tasks.find(task => task.id === 'tapd-parent-story')?.assignee_open_ids).toEqual(['ou_he']);
        expect(parentRow?.task).toMatchObject({ title: '三方牌谱文件上传', workitem_type: 'STORY' });
        expect(parentRow?.roles).toContain('product_requirement');
    });

    test('exposes parent ids for the employee task tree', async () => {
        const parent = {
            ...developmentTask(),
            id: 'parent-task',
            tapd_story_id: 'parent-story',
        };
        const child = {
            ...developmentTask(),
            id: 'child-task',
            tapd_story_id: 'child-story',
            parent_id: 'parent-story',
            title: '支付流程子任务',
        };
        const data = await HumanGanttService.build(ganttStore([child, parent]), config, {
            from: '2026-07-01',
            to: '2026-07-31',
        });

        expect(data.rows.find(row => row.task.id === 'parent-task')?.task.parent_id).toBeNull();
        expect(data.rows.find(row => row.task.id === 'child-task')?.task.parent_id).toBe('parent-story');
    });

    test('persists editable plans only for task participants using half-day tokens', async () => {
        const task = developmentTask();
        let savedTask: any = null;
        const audits: any[] = [];
        const store = {
            findTask: async () => task,
            saveTask: async (value: any) => { savedTask = value; },
            appendAuditLog: async (type: string, payload: any) => { audits.push({ type, payload }); },
        };
        const plan = await HumanGanttService.savePlan(store, task.id, {
            employee_open_id: 'ou_dev',
            role: 'development',
            start: '2026-07-06-AM',
            end: '2026-07-10-PM',
        });
        expect(plan).toMatchObject({ id: 'ou_dev:development', start: '2026-07-06-AM', end: '2026-07-10-PM' });
        expect(savedTask.trace.gantt_plans).toContainEqual(expect.objectContaining({ id: 'ou_dev:development' }));
        expect(audits[0].type).toBe('task_gantt_plan_updated');
        await expect(HumanGanttService.savePlan(store, task.id, {
            employee_open_id: 'ou_outsider',
            role: 'development',
            start: '2026-07-06-AM',
            end: '2026-07-10-PM',
        })).rejects.toThrow('不是任务参与人');
    });

    test('deletes an editable plan and records the task-domain audit event', async () => {
        const task = developmentTask();
        task.trace.gantt_plans = [{
            id: 'ou_dev:development',
            employee_open_id: 'ou_dev',
            role: 'development',
            start: '2026-07-06-AM',
            end: '2026-07-10-PM',
        }];
        const audits: any[] = [];
        const store = {
            findTask: async () => task,
            saveTask: async (): Promise<void> => undefined,
            appendAuditLog: async (type: string, payload: any) => { audits.push({ type, payload }); },
        };

        const deleted = await HumanGanttService.deletePlan(store, task.id, {
            employee_open_id: 'ou_dev',
            role: 'development',
        });

        expect(deleted.id).toBe('ou_dev:development');
        expect(task.trace.gantt_plans).toHaveLength(0);
        expect(audits[0]).toMatchObject({
            type: 'task_gantt_plan_deleted',
            payload: { task_id: task.id, id: 'ou_dev:development' },
        });
        await expect(HumanGanttService.deletePlan(store, task.id, {
            employee_open_id: 'ou_dev',
            role: 'development',
        })).rejects.toThrow('计划不存在');
    });
});
