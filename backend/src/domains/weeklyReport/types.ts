import type { Task } from "@/models/types";

export type WeeklyPeriodKind = "current_week" | "last_week";

export interface WeeklyPeriod {
    kind: WeeklyPeriodKind;
    start: string;
    end: string;
    cutoff_at: string;
    time_zone: string;
    business_days: string[];
    is_partial: boolean;
}

export interface WeeklyStandupDay {
    date: string;
    submitted: number;
    expected: number;
    missing_names: string[];
    blockers: Array<{ member: string; text: string }>;
    risks: Array<{ member: string; text: string }>;
    decisions: Array<{ member: string; text: string }>;
}

export interface WeeklyTaskChange {
    task_id: string;
    title: string;
    at: string;
    summary: string;
    changes: Record<string, { from: unknown; to: unknown }>;
}

export interface WeeklyTapdStatusChange {
    story_id: string;
    at: string;
    from: unknown;
    to: unknown;
}

export interface WeeklyMemberFacts {
    open_id: string;
    name: string;
    standup_submitted: number;
    standup_expected: number;
    yesterday_done: string[];
    today_plan: string[];
    blockers: string[];
    risks: string[];
    decisions_needed: string[];
    active_tasks: Task[];
    new_tasks: Task[];
    completed_tasks: Task[];
}

export interface WeeklyReportFacts {
    schema_version: 1;
    group: { id: string; name: string };
    period: WeeklyPeriod;
    generated_at: string;
    tapd_synced_at: string;
    metrics: {
        active_members: number;
        standup_expected: number;
        standup_submitted: number;
        standup_rate: number;
        new_tasks: number;
        completed_tasks: number;
        active_tasks: number;
        blocked_tasks: number;
        overdue_tasks: number;
    };
    standup_days: WeeklyStandupDay[];
    members: WeeklyMemberFacts[];
    new_tasks: Task[];
    completed_tasks: Task[];
    active_tasks: Task[];
    blocked_tasks: Task[];
    overdue_tasks: Task[];
    task_changes: WeeklyTaskChange[];
    tapd_status_history_available: boolean;
    warnings: string[];
}

export interface WeeklyNarrative {
    executive_summary: string;
    highlights: string[];
    risks: string[];
    decisions_needed: string[];
    next_week_focus: string[];
    source: "llm" | "deterministic";
}

export interface WeeklyReportRequest {
    group_id: string;
    period: WeeklyPeriodKind;
    cutoff_at?: string;
    trigger_type: "manual" | "schedule" | "agent";
    source_message_id?: string | null;
}
