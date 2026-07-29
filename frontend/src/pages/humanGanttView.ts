import type { HumanGanttRow } from '@/types';

export const GANTT_PHASE_ORDER = [
  'draft',
  'requirement',
  'development',
  'development_completed',
  'transfer_test',
  'testing',
  'implemented',
] as const;

export type GanttPhaseStepState = 'complete' | 'current' | 'upcoming';
export type EmployeeTaskTreeRow = {
  row: HumanGanttRow;
  depth: number;
  hasChildren: boolean;
};

export function ganttPhaseStepState(step: string, currentPhase: string): GanttPhaseStepState {
  const stepIndex = GANTT_PHASE_ORDER.indexOf(step as (typeof GANTT_PHASE_ORDER)[number]);
  const currentIndex = GANTT_PHASE_ORDER.indexOf(currentPhase as (typeof GANTT_PHASE_ORDER)[number]);
  if (stepIndex < 0 || currentIndex < 0) return 'upcoming';
  if (stepIndex < currentIndex) return 'complete';
  if (stepIndex === currentIndex) return 'current';
  return 'upcoming';
}

export function employeeTaskCount(rows: HumanGanttRow[]): number {
  return new Set(
    rows
      .map(row => row.task.id)
      .filter(taskId => taskId && !taskId.startsWith('dummy-task-')),
  ).size;
}

export function buildEmployeeTaskTree(rows: HumanGanttRow[]): EmployeeTaskTreeRow[] {
  const rowByAlias = new Map<string, HumanGanttRow>();
  for (const row of rows) {
    for (const alias of [row.task.id, row.task.tapd_story_id].filter(Boolean) as string[]) {
      rowByAlias.set(alias, row);
    }
  }

  const childrenByParentId = new Map<string, HumanGanttRow[]>();
  const roots: HumanGanttRow[] = [];
  for (const row of rows) {
    const parent = row.task.parent_id ? rowByAlias.get(row.task.parent_id) : undefined;
    if (!parent || parent.id === row.id) {
      roots.push(row);
      continue;
    }
    const children = childrenByParentId.get(parent.id) || [];
    children.push(row);
    childrenByParentId.set(parent.id, children);
  }

  const result: EmployeeTaskTreeRow[] = [];
  const visited = new Set<string>();
  const append = (row: HumanGanttRow, depth: number) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    const children = childrenByParentId.get(row.id) || [];
    result.push({ row, depth, hasChildren: children.length > 0 });
    for (const child of children) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  for (const row of rows) append(row, 0);
  return result;
}

export function toggleCollapsedEmployee(current: ReadonlySet<string>, employeeOpenId: string): Set<string> {
  const next = new Set(current);
  if (next.has(employeeOpenId)) next.delete(employeeOpenId);
  else next.add(employeeOpenId);
  return next;
}
