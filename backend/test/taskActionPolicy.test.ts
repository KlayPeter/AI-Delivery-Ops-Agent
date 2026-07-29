import { describe, expect, test } from 'bun:test';
import {
    isDevelopmentCompletedTaskAction,
    isImplementedTaskAction,
    isTransferTestTaskAction,
} from '@/domains/task/actionPolicy';

describe('task action policy', () => {
    test('classifies generic completion by the current workflow phase', () => {
        const developmentTask: any = { status: 'in_progress', trace: { workflow: { phase: 'development' } } };
        const implementedTask: any = { status: 'owner_marked_done' };

        expect(isDevelopmentCompletedTaskAction('已经完成', developmentTask)).toBe(true);
        expect(isImplementedTaskAction('已经完成', developmentTask)).toBe(false);
        expect(isImplementedTaskAction('已经完成', implementedTask)).toBe(true);
    });

    test('keeps explicit lifecycle actions unambiguous', () => {
        const task: any = { status: 'in_progress', trace: { workflow: { phase: 'development' } } };

        expect(isDevelopmentCompletedTaskAction('开发完毕', task)).toBe(true);
        expect(isImplementedTaskAction('验收通过', task)).toBe(true);
        expect(isTransferTestTaskAction('现在提测')).toBe(true);
    });

    test('does not classify negated completion as a state transition', () => {
        const task: any = { status: 'in_progress', trace: { workflow: { phase: 'development' } } };

        expect(isDevelopmentCompletedTaskAction('还没有完成', task)).toBe(false);
        expect(isImplementedTaskAction('还没有完成', task)).toBe(false);
    });
});
