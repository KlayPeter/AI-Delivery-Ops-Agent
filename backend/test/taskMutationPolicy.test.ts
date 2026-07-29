import { describe, expect, test } from 'bun:test';
import { applyTaskDueDate, applyTaskSupplement } from '@/domains/task/mutationPolicy';

describe('task mutation policy', () => {
    test('updates the due date and modification time together', () => {
        const task: any = { due_date: '2026-07-10', updated_at: '2026-07-01T00:00:00Z' };

        applyTaskDueDate(task, '2026-07-20', '2026-07-14T02:00:00Z');

        expect(task).toMatchObject({ due_date: '2026-07-20', updated_at: '2026-07-14T02:00:00Z' });
    });

    test('deduplicates acceptance criteria while preserving their order', () => {
        const task: any = {
            due_date: '2026-07-10',
            acceptance_criteria: ['接口返回 200'],
            updated_at: '2026-07-01T00:00:00Z',
        };

        const result = applyTaskSupplement(task, {
            dueDate: '2026-07-20',
            criteria: ['接口返回 200', '错误可追踪'],
        }, '2026-07-14T02:00:00Z');

        expect(result).toEqual({
            updated: true,
            messages: ['截止时间更新为：2026-07-20', '验收标准补充为：接口返回 200；错误可追踪'],
        });
        expect(task.acceptance_criteria).toEqual(['接口返回 200', '错误可追踪']);
        expect(task.updated_at).toBe('2026-07-14T02:00:00Z');
    });

    test('does not change the modification time when the supplement is empty', () => {
        const task: any = { due_date: '2026-07-10', updated_at: '2026-07-01T00:00:00Z' };

        const result = applyTaskSupplement(task, { dueDate: null, criteria: [] }, '2026-07-14T02:00:00Z');

        expect(result).toEqual({ updated: false, messages: [] });
        expect(task.updated_at).toBe('2026-07-01T00:00:00Z');
    });
});
