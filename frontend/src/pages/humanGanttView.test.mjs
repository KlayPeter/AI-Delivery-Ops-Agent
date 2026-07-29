import { describe, expect, test } from 'bun:test';
import {
  buildEmployeeTaskTree,
  employeeTaskCount,
  ganttPhaseStepState,
  toggleCollapsedEmployee,
} from './humanGanttView.ts';

describe('human gantt view helpers', () => {
  test('marks completed, current, and upcoming workflow steps', () => {
    expect(ganttPhaseStepState('requirement', 'development')).toBe('complete');
    expect(ganttPhaseStepState('development', 'development')).toBe('current');
    expect(ganttPhaseStepState('testing', 'development')).toBe('upcoming');
    expect(ganttPhaseStepState('draft', 'idle')).toBe('upcoming');
  });

  test('counts real employee tasks and excludes idle placeholder rows', () => {
    const rows = [
      { task: { id: 'task-1' } },
      { task: { id: 'task-1' } },
      { task: { id: 'dummy-task-ou_idle' } },
    ];
    expect(employeeTaskCount(rows)).toBe(1);
  });

  test('orders visible employee tasks as a parent-child tree', () => {
    const rows = [
      { id: 'employee:child', task: { id: 'child', tapd_story_id: 'tapd-child', parent_id: 'tapd-parent' } },
      { id: 'employee:root', task: { id: 'root', tapd_story_id: 'tapd-root', parent_id: null } },
      { id: 'employee:parent', task: { id: 'parent', tapd_story_id: 'tapd-parent', parent_id: null } },
    ];

    expect(buildEmployeeTaskTree(rows).map(item => ({
      id: item.row.task.id,
      depth: item.depth,
      hasChildren: item.hasChildren,
    }))).toEqual([
      { id: 'root', depth: 0, hasChildren: false },
      { id: 'parent', depth: 0, hasChildren: true },
      { id: 'child', depth: 1, hasChildren: false },
    ]);
  });

  test('toggles one employee without mutating the previous set', () => {
    const current = new Set(['ou_existing']);
    const collapsed = toggleCollapsedEmployee(current, 'ou_new');
    const expanded = toggleCollapsedEmployee(collapsed, 'ou_new');

    expect([...current]).toEqual(['ou_existing']);
    expect(collapsed.has('ou_new')).toBe(true);
    expect(expanded.has('ou_new')).toBe(false);
  });
});
