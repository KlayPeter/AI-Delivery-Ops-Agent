import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import dayjs, { type Dayjs } from 'dayjs';
import {
  Alert,
  App as AntdApp,
  Drawer,
  Empty,
  Select,
  Skeleton,
  Tag,
  Tooltip,
  TreeSelect,
} from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CaretDownOutlined,
  LinkOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api } from '@/api';
import type { GanttRole, HumanGanttData, HumanGanttRow, HumanGanttSegment } from '@/types';
import {
  buildEmployeeTaskTree,
  employeeTaskCount,
  GANTT_PHASE_ORDER,
  ganttPhaseStepState,
  toggleCollapsedEmployee,
} from './humanGanttView';
import './HumanGanttPage.css';

const roleLabels: Record<GanttRole, string> = {
  product_requirement: '需求撰写',
  development: '开发实现',
  testing: '测试验证',
  product_acceptance: '产品验收',
  creator: '任务发起',
};
type GanttStatusFilter = 'all' | 'draft' | 'requirement' | 'development' | 'development_completed' | 'transfer_test' | 'testing' | 'implemented';
type GanttTimeScale = 'week' | 'month';
type DepartmentTreeNode = {
  title: string;
  value: string;
  key: string;
  children: DepartmentTreeNode[];
};
type PlanDragMode = 'move' | 'resize-start' | 'resize-end';
type PlanDragSession = {
  pointerId: number;
  element: HTMLButtonElement;
  row: HumanGanttRow;
  segment: HumanGanttSegment;
  mode: PlanDragMode;
  gridLeft: number;
  pointerStart: number;
  originalStart: number;
  originalEnd: number;
  nextStart: number;
  nextEnd: number;
  frame: number | null;
};

const statusFilters: Array<{ value: GanttStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草案' },
  { value: 'requirement', label: '需求' },
  { value: 'development', label: '开发进行中' },
  { value: 'development_completed', label: '开发完成' },
  { value: 'transfer_test', label: '转测试' },
  { value: 'testing', label: '测试中' },
  { value: 'implemented', label: '已实现' },
];

const phaseLabels: Record<string, string> = {
  draft: '草案', requirement: '需求', development: '开发进行中', development_completed: '开发完成', transfer_test: '转测试', testing: '测试进行中', implemented: '已实现',
};

function tokenIndex(token: string): number {
  const date = token.slice(0, 10);
  return dayjs(date).diff(dayjs('1970-01-01'), 'day') * 2 + (token.endsWith('-PM') ? 1 : 0);
}

function tokenFromIndex(index: number): string {
  const dateIndex = Math.floor(index / 2);
  const date = dayjs('1970-01-01').add(dateIndex, 'day').format('YYYY-MM-DD');
  return `${date}-${index % 2 === 0 ? 'AM' : 'PM'}`;
}

function displayToken(token: string): string {
  return `${token.slice(5, 10).replace('-', '/')} ${token.endsWith('-AM') ? '上午' : '下午'}`;
}

function preferredPlanRole(row: HumanGanttRow): GanttRole {
  if (row.task.phase === 'testing' && row.roles.includes('product_acceptance')) return 'product_acceptance';
  if (row.task.phase === 'testing' && row.roles.includes('testing')) return 'testing';
  if (['development', 'development_completed'].includes(row.task.phase) && row.roles.includes('development')) return 'development';
  if (row.roles.includes('product_requirement')) return 'product_requirement';
  return row.roles[0] || 'creator';
}

function segmentIndexStyle(startIndex: number, endIndex: number, rangeStart: number, rangeEnd: number, halfDayWidth: number) {
  const start = Math.max(rangeStart, startIndex);
  const end = Math.min(rangeEnd, endIndex);
  return {
    left: (start - rangeStart) * halfDayWidth + 3,
    width: Math.max(18, (end - start + 1) * halfDayWidth - 6),
  };
}

function segmentStyle(segment: HumanGanttSegment, rangeStart: number, rangeEnd: number, halfDayWidth: number) {
  return segmentIndexStyle(tokenIndex(segment.start), tokenIndex(segment.end), rangeStart, rangeEnd, halfDayWidth);
}

function planSegment(employeeOpenId: string, role: GanttRole, start: string, end: string): HumanGanttSegment {
  return {
    id: `${employeeOpenId}:${role}`,
    role,
    kind: 'plan',
    start,
    end,
    state: 'planned',
    editable: true,
    label: `${roleLabels[role] || '计划'}计划`,
  };
}

function updatePlanInData(
  current: HumanGanttData | undefined,
  taskId: string,
  employeeOpenId: string,
  segmentId: string,
  segment: HumanGanttSegment | null,
): HumanGanttData | undefined {
  if (!current) return current;
  return {
    ...current,
    rows: current.rows.map(row => {
      if (row.task.id !== taskId || row.employee.open_id !== employeeOpenId) return row;
      const segments = row.segments.filter(item => item.id !== segmentId || item.kind !== 'plan');
      return { ...row, segments: segment ? [...segments, segment] : segments };
    }),
  };
}

const HumanGanttPage = () => {
  const { message: messageApi } = AntdApp.useApp();
  const [anchor, setAnchor] = useState<Dayjs>(dayjs());
  const [department, setDepartment] = useState('all');
  const [status, setStatus] = useState<GanttStatusFilter>('all');
  const [timeScale, setTimeScale] = useState<GanttTimeScale>('month');
  const [selectedRow, setSelectedRow] = useState<HumanGanttRow | null>(null);
  const [draft, setDraft] = useState<{ rowId: string; startIndex: number } | null>(null);
  const [collapsedEmployees, setCollapsedEmployees] = useState<Set<string>>(() => new Set());
  const dragRef = useRef<PlanDragSession | null>(null);

  const weekStart = anchor.startOf('day').subtract((anchor.day() + 6) % 7, 'day');
  const rangeStartDate = timeScale === 'month' ? anchor.startOf('month') : weekStart;
  const rangeEndDate = timeScale === 'month' ? anchor.endOf('month') : weekStart.add(6, 'day');
  const from = rangeStartDate.format('YYYY-MM-DD');
  const to = rangeEndDate.format('YYYY-MM-DD');
  const swrKey = `human-gantt:${from}:${to}:all`;
  const { data, error, isLoading, isValidating, mutate } = useSWR<HumanGanttData>(
    swrKey,
    () => api.fetchHumanGantt({ from, to, includeImplemented: true, sync: true }),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

  const days = Array.from(
    { length: rangeEndDate.diff(rangeStartDate, 'day') + 1 },
    (_, index) => rangeStartDate.add(index, 'day'),
  );
  const halfDayWidth = timeScale === 'month' ? 20 : 72;
  const rangeStart = tokenIndex(`${from}-AM`);
  const rangeEnd = tokenIndex(`${to}-PM`);
  const timelineWidth = days.length * 2 * halfDayWidth;
  const periodLabel = timeScale === 'month'
    ? anchor.format('YYYY年M月')
    : `${rangeStartDate.format('M月D日')} — ${rangeEndDate.format('M月D日')}`;
  const todayIndex = dayjs().startOf('day').diff(rangeStartDate, 'day');

  useEffect(() => () => {
    const frame = dragRef.current?.frame;
    if (frame != null) cancelAnimationFrame(frame);
  }, []);

  const filteredRows = useMemo(() => {
    return (data?.rows || []).filter(row => {
      if (department !== 'all' && row.employee.department !== department && !row.employee.department.startsWith(department + '/')) return false;
      if (status !== 'all' && row.task.phase !== status) return false;
      return true;
    });
  }, [data?.rows, department, status]);

  const rowsByEmployee = useMemo(() => {
    const people = new Map<string, HumanGanttRow[]>();
    for (const row of filteredRows) {
      if (!people.has(row.employee.open_id)) people.set(row.employee.open_id, []);
      people.get(row.employee.open_id)!.push(row);
    }
    return [...people.values()];
  }, [filteredRows]);

  const movePeriod = (direction: -1 | 1) => {
    setAnchor(value => value.add(direction, timeScale));
    setDraft(null);
  };

  const toggleEmployee = (employeeOpenId: string) => {
    setCollapsedEmployees(current => toggleCollapsedEmployee(current, employeeOpenId));
    setDraft(null);
  };

  const savePlan = async (row: HumanGanttRow, startIndex: number, endIndex: number, role = preferredPlanRole(row)) => {
    const start = tokenFromIndex(Math.min(startIndex, endIndex));
    const end = tokenFromIndex(Math.max(startIndex, endIndex));
    const segmentId = `${row.employee.open_id}:${role}`;
    const previous = row.segments.find(segment => segment.kind === 'plan' && segment.id === segmentId) || null;
    setDraft(null);
    await mutate(
      current => updatePlanInData(
        current,
        row.task.id,
        row.employee.open_id,
        segmentId,
        planSegment(row.employee.open_id, role, start, end),
      ),
      { revalidate: false },
    );
    try {
      await api.saveHumanGanttPlan(row.task.id, {
        employee_open_id: row.employee.open_id,
        role,
        start,
        end,
      });
      messageApi.success('人员计划已保存');
      return true;
    } catch (saveError: unknown) {
      await mutate(
        current => updatePlanInData(current, row.task.id, row.employee.open_id, segmentId, previous),
        { revalidate: false },
      );
      messageApi.error(saveError instanceof Error ? saveError.message : '计划保存失败');
      return false;
    }
  };

  const deletePlan = async (row: HumanGanttRow, segment: HumanGanttSegment) => {
    await mutate(
      current => updatePlanInData(current, row.task.id, row.employee.open_id, segment.id, null),
      { revalidate: false },
    );
    try {
      await api.deleteHumanGanttPlan(row.task.id, {
        employee_open_id: row.employee.open_id,
        role: segment.role,
      });
      messageApi.success('未开始计划已删除');
    } catch (deleteError: unknown) {
      await mutate(
        current => updatePlanInData(current, row.task.id, row.employee.open_id, segment.id, segment),
        { revalidate: false },
      );
      messageApi.error(deleteError instanceof Error ? deleteError.message : '计划删除失败');
    }
  };

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>, row: HumanGanttRow) => {
    if ((event.target as HTMLElement).closest('.hg-bar')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = Math.max(0, Math.min(timelineWidth - 1, event.clientX - rect.left));
    const clickedIndex = rangeStart + Math.floor(offset / halfDayWidth);
    if (!draft || draft.rowId !== row.id) {
      setDraft({ rowId: row.id, startIndex: clickedIndex });
      return;
    }
    void savePlan(row, draft.startIndex, clickedIndex);
  };

  const pointerIndex = (clientX: number, gridLeft: number) => {
    const offset = Math.max(0, Math.min(timelineWidth - 1, clientX - gridLeft));
    return rangeStart + Math.floor(offset / halfDayWidth);
  };

  const paintDragSession = (session: PlanDragSession) => {
    const style = segmentIndexStyle(session.nextStart, session.nextEnd, rangeStart, rangeEnd, halfDayWidth);
    session.element.style.left = `${style.left}px`;
    session.element.style.width = `${style.width}px`;
  };

  const resetDragSessionStyle = (session: PlanDragSession) => {
    const style = segmentIndexStyle(session.originalStart, session.originalEnd, rangeStart, rangeEnd, halfDayWidth);
    session.element.style.left = `${style.left}px`;
    session.element.style.width = `${style.width}px`;
  };

  const handlePlanPointerDown = (
    event: React.PointerEvent<HTMLElement>,
    row: HumanGanttRow,
    segment: HumanGanttSegment,
    mode: PlanDragMode = 'move',
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget.closest('.hg-bar-plan');
    const grid = event.currentTarget.closest('.hg-timeline-grid');
    if (!(element instanceof HTMLButtonElement) || !(grid instanceof HTMLElement)) return;
    element.focus({ preventScroll: true });
    const originalStart = tokenIndex(segment.start);
    const originalEnd = tokenIndex(segment.end);
    const gridLeft = grid.getBoundingClientRect().left;
    element.setPointerCapture(event.pointerId);
    element.classList.add('is-dragging');
    document.body.classList.add(`is-dragging-plan-${mode}`);
    dragRef.current = {
      pointerId: event.pointerId,
      element,
      row,
      segment,
      mode,
      gridLeft,
      pointerStart: pointerIndex(event.clientX, gridLeft),
      originalStart,
      originalEnd,
      nextStart: originalStart,
      nextEnd: originalEnd,
      frame: null,
    };
  };

  const handlePlanPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const current = pointerIndex(event.clientX, session.gridLeft);
    if (session.mode === 'resize-start') {
      session.nextStart = Math.max(rangeStart, Math.min(session.originalEnd, current));
      session.nextEnd = session.originalEnd;
    } else if (session.mode === 'resize-end') {
      session.nextStart = session.originalStart;
      session.nextEnd = Math.min(rangeEnd, Math.max(session.originalStart, current));
    } else {
      const duration = session.originalEnd - session.originalStart;
      const maxStart = rangeEnd - duration;
      const nextStart = duration > rangeEnd - rangeStart
        ? session.originalStart
        : Math.max(rangeStart, Math.min(maxStart, session.originalStart + current - session.pointerStart));
      session.nextStart = nextStart;
      session.nextEnd = nextStart + duration;
    }
    if (session.frame === null) {
      session.frame = requestAnimationFrame(() => {
        session.frame = null;
        paintDragSession(session);
      });
    }
  };

  const handlePlanPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    paintDragSession(session);
    session.element.classList.remove('is-dragging');
    document.body.classList.remove(`is-dragging-plan-${session.mode}`);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (session.nextStart === session.originalStart && session.nextEnd === session.originalEnd) return;
    void savePlan(session.row, session.nextStart, session.nextEnd, session.segment.role).then(saved => {
      if (!saved) resetDragSessionStyle(session);
    });
  };

  const handlePlanPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    resetDragSessionStyle(session);
    session.element.classList.remove('is-dragging');
    document.body.classList.remove(`is-dragging-plan-${session.mode}`);
    dragRef.current = null;
  };

  const handlePlanKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    row: HumanGanttRow,
    segment: HumanGanttSegment,
  ) => {
    if (!['Delete', 'Backspace'].includes(event.key) || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    void deletePlan(row, segment);
  };

  return (
    <div className="hg-page">
      <div className="page-heading"><div><h1>人力甘特图</h1><p>按人员查看任务阶段与时间安排，拖拽计划条调整个人排期。</p></div></div>
      <section className="hg-control-panel">
        <div className="hg-control-group hg-view-control">
          <span className="hg-control-label">视角切换</span>
          <div className="hg-segmented">
            <button type="button" className="is-active">人力视角</button>
            <button type="button" disabled title="需求视角暂未开放">需求视角</button>
          </div>
        </div>

        <div className="hg-control-group hg-department-control">
          <span className="hg-control-label">部门筛选</span>
          <TreeSelect
            className="hg-department-select"
            value={department}
            onChange={setDepartment}
            treeDefaultExpandAll
            popupMatchSelectWidth={false}
            popupClassName="hg-dark-popup"
            style={{ width: 230 }}
            dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
            treeData={[
              { value: 'all', title: '全部部门' },
              ...(() => {
                if (!data?.departments) return [];
                const rootNodes: DepartmentTreeNode[] = [];
                const treeMap: Record<string, DepartmentTreeNode> = {};

                data.departments.forEach(dept => {
                  const parts = (dept.id || '未分组').split('/').filter(Boolean);
                  let currentPath = '';
                  let parentNode: DepartmentTreeNode | null = null;
                  parts.forEach((part, index) => {
                    const isLast = index === parts.length - 1;
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    if (!treeMap[currentPath]) {
                      const node = { title: part, value: currentPath, key: currentPath, children: [] };
                      treeMap[currentPath] = node;
                      if (parentNode) parentNode.children.push(node);
                      else rootNodes.push(node);
                    }
                    if (isLast) treeMap[currentPath].title = part;
                    parentNode = treeMap[currentPath];
                  });
                });
                return rootNodes;
              })()
            ]}
          />
        </div>

        <div className="hg-control-group hg-status-control">
          <span className="hg-control-label">状态</span>
          <Select
            value={status}
            onChange={(val) => setStatus(val as GanttStatusFilter)}
            style={{ width: 120 }}
            popupClassName="hg-dark-popup"
            options={statusFilters}
          />
        </div>

        <div className="hg-control-group hg-scale-control">
          <span className="hg-control-label">时间尺度</span>
          <div className="hg-segmented">
            <button type="button" className={timeScale === 'week' ? 'is-active' : ''} onClick={() => { setTimeScale('week'); setDraft(null); }}>周</button>
            <button type="button" className={timeScale === 'month' ? 'is-active' : ''} onClick={() => { setTimeScale('month'); setDraft(null); }}>月</button>
          </div>
        </div>
      </section>

      <section className="hg-board">
        {error ? <Alert type="error" showIcon message="人力甘特图加载失败" description={error.message} /> : null}
        {isLoading && !data ? <div className="hg-loading"><Skeleton active paragraph={{ rows: 8 }} /></div> : null}
        {!isLoading && filteredRows.length === 0 ? <Empty className="hg-empty" description="当前筛选范围内没有任务" /> : null}

        {filteredRows.length > 0 ? (
          <div className="hg-table-scroll">
            <table className="hg-table" style={{ width: 610 + timelineWidth }}>
              <colgroup><col style={{ width: 120 }} /><col style={{ width: 280 }} /><col style={{ width: 120 }} /><col style={{ width: 90 }} /><col style={{ width: timelineWidth }} /></colgroup>
              <thead>
                <tr>
                  <th className="hg-fixed hg-employee-col" rowSpan={2}>员工</th>
                  <th className="hg-fixed hg-task-col" rowSpan={2}>任务名称</th>
                  <th className="hg-fixed hg-role-col" rowSpan={2}>任务状态</th>
                  <th className="hg-fixed hg-status-col" rowSpan={2}>TAPD链接</th>
                  <th className="hg-month-head">
                    <div className="hg-period-bar">
                      <div className="hg-period-nav">
                        <button type="button" onClick={() => movePeriod(-1)} aria-label="上一时间段"><ArrowLeftOutlined /></button>
                        <strong>{periodLabel}</strong>
                        <button type="button" onClick={() => movePeriod(1)} aria-label="下一时间段"><ArrowRightOutlined /></button>
                      </div>
                      <div className="hg-legend" aria-label="状态说明">
                        <span>状态说明</span>
                        <span><i />未开始</span>
                        <span><i className="is-progress" />进行中</span>
                        <span><i className="is-completed" />已完成</span>
                      </div>
                    </div>
                  </th>
                </tr>
                <tr><th className="hg-days-head"><div style={{ width: timelineWidth }}>{days.map(item => <span key={item.format('YYYY-MM-DD')} className={item.day() === 0 || item.day() === 6 ? 'weekend' : ''} style={{ width: halfDayWidth * 2 }}>{item.date()}</span>)}</div></th></tr>
              </thead>
              <tbody>
                {rowsByEmployee.flatMap(rows => {
                  const employee = rows[0].employee;
                  const taskCount = employeeTaskCount(rows);
                  const taskTree = buildEmployeeTaskTree(rows);
                  const isCollapsed = taskCount > 0 && collapsedEmployees.has(employee.open_id);
                  const personCell = (
                    <td className="hg-fixed hg-employee-col hg-person-cell" rowSpan={isCollapsed ? 1 : taskTree.length}>
                      <button
                        type="button"
                        className={`hg-person-toggle ${isCollapsed ? 'is-collapsed' : ''}`}
                        onClick={() => taskCount > 0 && toggleEmployee(employee.open_id)}
                        disabled={taskCount === 0}
                        aria-expanded={taskCount > 0 ? !isCollapsed : undefined}
                        title={taskCount > 0 ? `${isCollapsed ? '展开' : '收起'} ${employee.name}的 ${taskCount} 项任务` : `${employee.name}暂无任务`}
                      >
                        <CaretDownOutlined className="hg-person-toggle-icon" aria-hidden="true" />
                        <span className="hg-person-mark" aria-hidden="true" />
                        <strong>{employee.name}</strong>
                      </button>
                    </td>
                  );
                  if (isCollapsed) {
                    return [(
                      <tr key={`collapsed-${employee.open_id}`} className="hg-collapsed-row">
                        {personCell}
                        <td className="hg-fixed hg-task-col hg-collapsed-task"><span>已折叠 {taskCount} 项任务</span></td>
                        <td className="hg-fixed hg-role-col"><span className="hg-collapsed-badge">已收起</span></td>
                        <td className="hg-fixed hg-status-col"><span className="hg-no-link">—</span></td>
                        <td className="hg-timeline-cell"><div className="hg-collapsed-timeline">点击员工姓名展开任务</div></td>
                      </tr>
                    )];
                  }
                  return taskTree.map(({ row, depth, hasChildren }, rowIndex) => {
                    const draftStart = draft?.rowId === row.id ? draft.startIndex : null;
                    const treeDepth = Math.min(depth, 4);
                    return (
                    <tr key={row.id} className={hasChildren ? 'hg-task-tree-parent-row' : ''}>
                      {rowIndex === 0 ? personCell : null}
                      <td className="hg-fixed hg-task-col">
                        <div className="hg-task-cell" style={{ '--hg-tree-depth': treeDepth } as React.CSSProperties}>
                          {depth > 0 ? <span className="hg-task-tree-branch" aria-hidden="true">└</span> : hasChildren ? <span className="hg-task-tree-root" aria-hidden="true">▾</span> : null}
                          {row.task.workitem_type ? <span className={`hg-workitem-tag hg-workitem-${row.task.workitem_type.toLowerCase()}`}>{row.task.workitem_type}</span> : null}
                          <button className="hg-task-button" onClick={() => setSelectedRow(row)}>{row.task.title}</button>
                        </div>
                      </td>
                      <td className="hg-fixed hg-role-col"><span className={`hg-status hg-status-${row.task.phase}`}>{row.task.status_label}</span></td>
                      <td className="hg-fixed hg-status-col">{row.task.tapd_url ? <a className="hg-tapd-link" href={row.task.tapd_url} target="_blank" rel="noreferrer">查看</a> : <span className="hg-no-link">—</span>}</td>
                      <td className="hg-timeline-cell">
                        <div className="hg-timeline-grid" style={{ width: timelineWidth, backgroundSize: `${halfDayWidth}px 100%, ${halfDayWidth * 2}px 100%` }} onClick={event => handleTimelineClick(event, row)}>
                          {days.map((item, index) => item.day() === 0 || item.day() === 6 ? <span className="hg-weekend-band" key={item.format('YYYY-MM-DD')} style={{ left: index * halfDayWidth * 2, width: halfDayWidth * 2 }} /> : null)}
                          {todayIndex >= 0 && todayIndex < days.length ? <span className="hg-today-line" style={{ left: (todayIndex * 2 + (dayjs().hour() >= 12 ? 1 : 0)) * halfDayWidth }} /> : null}
                          {draftStart !== null ? <span className="hg-draft-point" style={{ left: (draftStart - rangeStart) * halfDayWidth }}><i /></span> : null}
                          {row.segments.map(segment => {
                            const tooltip = `${segment.label}｜${displayToken(segment.start)} → ${displayToken(segment.end)}${segment.editable ? '｜拖动区间，拖两端调整，Delete 删除' : ''}`;
                            const className = `hg-bar hg-bar-${segment.state} hg-bar-${segment.kind}`;
                            const style = segmentStyle(segment, rangeStart, rangeEnd, halfDayWidth);
                            if (segment.kind === 'plan' && segment.editable) {
                              return (
                                <Tooltip key={`${segment.id}-${segment.kind}`} title={tooltip} mouseEnterDelay={0.35}>
                                  <button
                                    type="button"
                                    aria-label={`${tooltip}，点击选中`}
                                    className={className}
                                    style={style}
                                    onClick={event => event.stopPropagation()}
                                    onKeyDown={event => handlePlanKeyDown(event, row, segment)}
                                    onPointerDown={event => handlePlanPointerDown(event, row, segment)}
                                    onPointerMove={handlePlanPointerMove}
                                    onPointerUp={handlePlanPointerUp}
                                    onPointerCancel={handlePlanPointerCancel}
                                  >
                                    <span
                                      className="hg-bar-handle hg-bar-handle-start"
                                      data-resize="start"
                                      aria-hidden="true"
                                      onPointerDown={event => handlePlanPointerDown(event, row, segment, 'resize-start')}
                                    />
                                    <span
                                      className="hg-bar-handle hg-bar-handle-end"
                                      data-resize="end"
                                      aria-hidden="true"
                                      onPointerDown={event => handlePlanPointerDown(event, row, segment, 'resize-end')}
                                    />
                                  </button>
                                </Tooltip>
                              );
                            }
                            return <Tooltip key={`${segment.id}-${segment.kind}`} title={tooltip}><span className={className} style={style} /></Tooltip>;
                          })}
                        </div>
                      </td>
                    </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <footer className="hg-footer">
          <span className={data?.sync?.ok === false ? 'is-error' : ''}>{data?.sync?.ok === false ? 'TAPD 同步异常' : ''}</span>
          <button type="button" className="hg-refresh" onClick={() => mutate()} disabled={isValidating}>
            <span>数据更新：{data?.generated_at ? dayjs(data.generated_at).format('YYYY-MM-DD HH:mm') : '—'}</span>
            <ReloadOutlined spin={isValidating} />
          </button>
        </footer>
      </section>

      <Drawer className="hg-drawer" size={460} title={null} open={!!selectedRow} onClose={() => setSelectedRow(null)}>
        {selectedRow ? <>
          <div className="hg-drawer-kicker">任务详情</div>
          <h2>{selectedRow.task.title}</h2>
          <div className="hg-drawer-status">{selectedRow.task.workitem_type ? <span className={`hg-workitem-tag hg-workitem-${selectedRow.task.workitem_type.toLowerCase()}`}>{selectedRow.task.workitem_type}</span> : null}<span className={`hg-status hg-status-${selectedRow.task.phase}`}>{selectedRow.task.status_label}</span><Tag>{selectedRow.task.priority}</Tag>{selectedRow.task.tapd_url ? <a href={selectedRow.task.tapd_url} target="_blank" rel="noreferrer"><LinkOutlined /> 打开TAPD</a> : null}</div>
          <div className="hg-detail-person"><div><strong>{selectedRow.employee.name}</strong><span>{selectedRow.employee.department_label} · {selectedRow.roles.map(role => roleLabels[role]).join(' / ')}</span></div></div>
          <h3>任务流转</h3>
          <div className="hg-phase-line">{GANTT_PHASE_ORDER.map(item => {
            const stepState = ganttPhaseStepState(item, selectedRow.task.phase);
            return <div key={item} className={`is-${stepState}`} aria-current={stepState === 'current' ? 'step' : undefined}><i /><span>{phaseLabels[item]}</span></div>;
          })}</div>
          <h3>人员时间段</h3>
          <div className="hg-segment-list">{selectedRow.segments.length ? selectedRow.segments.map(segment => <div key={`${segment.id}-${segment.kind}`}><i className={segment.state} /><div><strong>{segment.label}</strong><span>{displayToken(segment.start)} → {displayToken(segment.end)}</span></div><em>{segment.kind === 'plan' ? '计划' : segment.kind === 'blocked' ? '挂起' : '实际'}</em></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无时间记录" />}</div>
        </> : null}
      </Drawer>
    </div>
  );
};

export default HumanGanttPage;
