import { describe, expect, test } from 'bun:test';
import { TaskService } from '@/services/taskService';

function task(id: string, status: string, parentId?: string): any {
    return {
        id: `tapd-${id}`,
        tapd_story_id: id,
        parent_id: parentId || null,
        title: id,
        status,
        creator_open_id: '',
        creator_name: '',
        primary_owner_open_id: '',
        primary_owner_name: '',
        assignee_open_ids: [],
        assignee_names: [],
        priority: 'P2',
        source_message_id: '',
        source_group_id: '',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
    };
}

describe('TAPD task hierarchy projection', () => {
    test('treats development completed and implemented as completed', () => {
        const developmentCompleted = task('1', 'development_completed');
        const implemented = { ...task('2', 'overdue'), trace: { tapd: { status: 'status_5' } } };
        const projection = TaskService.projectHierarchy([developmentCompleted, implemented]);

        expect(projection.get(developmentCompleted).is_completed).toBe(true);
        expect(projection.get(implemented).is_completed).toBe(true);
        expect(projection.isActionableLeaf(developmentCompleted)).toBe(false);
        expect(projection.isActionableLeaf(implemented)).toBe(false);
    });

    test('inherits parent completion through the full subtree', () => {
        const parent = task('10', 'development_completed');
        const child = task('11', 'in_progress', '10');
        const grandchild = task('12', 'testing', '11');
        const projection = TaskService.projectHierarchy([parent, child, grandchild]);

        expect(projection.get(child)).toMatchObject({ is_completed: true, completed_by_ancestor: true, completion_source_id: parent.id });
        expect(projection.get(grandchild)).toMatchObject({ is_completed: true, completed_by_ancestor: true, completion_source_id: parent.id });
        expect(projection.isActionableLeaf(grandchild)).toBe(false);
    });

    test('projects a parent transfer to test onto unfinished descendants without changing their TAPD status', () => {
        const parent = task('30', 'owner_marked_done');
        const child = task('31', 'overdue', '30');
        const grandchild = task('32', 'in_progress', '31');
        const projection = TaskService.projectHierarchy([parent, child, grandchild]);

        expect(projection.get(child)).toMatchObject({
            inherited_phase: 'transfer_test',
            inherited_phase_source_id: parent.id,
        });
        expect(projection.get(grandchild)).toMatchObject({
            inherited_phase: 'transfer_test',
            inherited_phase_source_id: parent.id,
        });
        expect(child.status).toBe('overdue');
        expect(grandchild.status).toBe('in_progress');
    });

    test('projects a parent testing state as testing for unfinished descendants', () => {
        const parent = task('40', 'testing');
        const child = task('41', 'in_progress', '40');
        const projection = TaskService.projectHierarchy([parent, child]);

        expect(projection.get(child)).toMatchObject({
            inherited_phase: 'testing',
            inherited_phase_source_id: parent.id,
        });
    });

    test('does not downgrade a child that is already further along than its parent projection', () => {
        const parent = task('50', 'owner_marked_done');
        const child = task('51', 'testing', '50');
        const projection = TaskService.projectHierarchy([parent, child]);

        expect(projection.get(child).inherited_phase).toBeNull();
    });

    test('counts only active unfinished leaf tasks as actionable', () => {
        const parent = task('20', 'in_progress');
        const activeChild = task('21', 'in_progress', '20');
        const deletedChild = { ...task('22', 'deleted', '20') };
        const projection = TaskService.projectHierarchy([parent, activeChild, deletedChild]);

        expect(projection.get(parent).is_leaf).toBe(false);
        expect(projection.isActionableLeaf(parent)).toBe(false);
        expect(projection.isActionableLeaf(activeChild)).toBe(true);
        expect(projection.isActionableLeaf(deletedChild)).toBe(false);
    });
});
