export interface Group {
  chat_id: string;
  name: string;
  description?: string;
  [key: string]: any;
}

export interface Member {
  open_id: string;
  name: string;
  job_title?: string | null;
  [key: string]: any;
}

export interface Config {
  groups: Group[];
  members: Member[];
  bot_name?: string;
  [key: string]: any;
}

export interface Log {
  timestamp: string;
  details?: any;
  payload?: any;
  action?: string;
  event_type?: string;
  [key: string]: any;
}

export interface ContextItem {
  message_id: string;
  created_at: string;
  context_type: string;
  task_title?: string;
  task_id?: string;
  is_group?: boolean;
  chat_name?: string;
  chat_id?: string;
  target_open_id?: string;
  target_name?: string;
  [key: string]: any;
}

export interface Standup {
  submitted_at: string;
  user_name: string;
  yesterday_done?: string[];
  today_plan?: string[];
  blockers?: string[];
  risks?: string[];
  decisions_needed?: string[];
  [key: string]: any;
}

export interface StandupMember {
  open_id: string;
  name: string;
  submitted: boolean;
  standup_content?: Standup;
  [key: string]: any;
}

export interface FilterState {
  startDate?: string | null;
  endDate?: string | null;
  eventType?: string;
  contextType?: string;
  chatType?: string;
  targetOpenId?: string;
  groupId?: string;
  [key: string]: any;
}

export type GanttRole = 'product_requirement' | 'development' | 'testing' | 'product_acceptance' | 'creator';

export interface HumanGanttSegment {
  id: string;
  role: GanttRole;
  kind: 'actual' | 'plan' | 'blocked';
  start: string;
  end: string;
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
    workitem_type: 'STORY' | 'DEVELOP' | 'ARTS' | null;
  };
  roles: GanttRole[];
  segments: HumanGanttSegment[];
}

export interface HumanGanttData {
  generated_at: string;
  range: { from: string; to: string };
  departments: Array<{ id: string; name: string; member_count: number }>;
  members: Array<{ open_id: string; name: string; department: string; department_label: string }>;
  rows: HumanGanttRow[];
  summary: { people: number; tasks: number; active: number; blocked: number };
  sync?: { ok: boolean; fetched?: number; updated?: number; error?: string } | null;
}
