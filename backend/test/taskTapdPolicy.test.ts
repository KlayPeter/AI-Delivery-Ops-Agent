import { describe, expect, test } from 'bun:test';
import { canonicalTapdPriority, canonicalTapdStatus, canonicalTapdStatusForExisting } from '@/domains/task/tapdPolicy';
import { TaskService } from '@/services/taskService';

describe('task TAPD policy', () => {
    test('maps TAPD workflow statuses to canonical task statuses', () => {
        expect(canonicalTapdStatus('status_2')).toBe('requirement');
        expect(canonicalTapdStatus('status_14')).toBe('in_progress');
        expect(canonicalTapdStatus('status_21')).toBe('development_completed');
        expect(canonicalTapdStatus('status_3')).toBe('owner_marked_done');
        expect(canonicalTapdStatus('status_6')).toBe('testing');
        expect(canonicalTapdStatus('status_5')).toBe('accepted');
        expect(canonicalTapdStatus('unknown')).toBe('pending_confirmation');
    });

    test('does not regress a more precise local workflow phase', () => {
        expect(canonicalTapdStatusForExisting('status_14', {
            trace: { workflow: { phase: 'development_completed' } },
        } as any)).toBe('development_completed');
        expect(canonicalTapdStatusForExisting('status_3', {
            trace: { workflow: { phase: 'testing' } },
        } as any)).toBe('testing');
    });

    test('normalizes TAPD priority labels and preserves a fallback', () => {
        expect(canonicalTapdPriority({ priority_label: 'High' })).toBe('P0');
        expect(canonicalTapdPriority({ priority: 'Middle' })).toBe('P1');
        expect(canonicalTapdPriority({}, 'P3')).toBe('P3');
    });

    test('syncs a manually created TAPD testing task without falling back to pending confirmation', async () => {
        const saved: any[] = [];
        const result = await TaskService.syncProjectScope({
            config: { groups: [{ members: [{ open_id: 'ou_owner', name: '孙工程' }] }] },
            tapd: {
                listStories: async () => ({
                    ok: true,
                    raw: { data: [{ Story: { id: '1112345678001001319', name: '手工创建的测试任务', owner: '孙工程', status: 'status_6' } }] },
                }),
                storyUrl: (id: string) => `https://tapd.test/story/${id}`,
            },
            store: {
                listTasks: async (): Promise<any[]> => [],
                saveTask: async (task: any): Promise<void> => { saved.push(task); },
            },
        }, { pageSize: 200 });

        expect(result).toMatchObject({ ok: true, created: 1 });
        expect(saved[0]).toMatchObject({
            tapd_story_id: '1112345678001001319',
            primary_owner_name: '孙工程',
            status: 'testing',
            trace: { tapd: { status: 'status_6' } },
        });
    });

    test('clears stale Feishu ids that are no longer in the active directory', async () => {
        const existing: any = {
            id: 'tapd-1',
            tapd_story_id: '1',
            title: '负责人已离群',
            creator_open_id: 'ou_stale_creator',
            creator_name: '创建人',
            primary_owner_open_id: 'ou_stale_owner',
            primary_owner_name: '旧负责人',
            assignee_open_ids: ['ou_stale_owner'],
            assignee_names: ['旧负责人'],
            status: 'in_progress',
            priority: 'P1',
            source_message_id: '',
            source_group_id: '',
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:00Z',
        };
        const saved: any[] = [];
        const result = await TaskService.syncProjectScope({
            config: { groups: [{ members: [{ open_id: 'ou_active', name: '现有成员', is_active: true }] }] },
            tapd: {
                listStories: async () => ({
                    ok: true,
                    raw: { data: [{ Story: { id: '1', name: '负责人已离群', owner: '旧负责人', creator: '创建人', status: 'status_14' } }] },
                }),
            },
            store: {
                listTasks: async (): Promise<any[]> => [existing],
                saveTask: async (task: any) => { saved.push(task); },
                saveTaskUpdate: async () => {},
            },
        });

        expect(result).toMatchObject({ ok: true, updated: 1 });
        expect(saved[0]).toMatchObject({
            primary_owner_open_id: '',
            assignee_open_ids: [''],
            creator_open_id: '',
        });
    });
});
