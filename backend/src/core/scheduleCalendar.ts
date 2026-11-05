import { isWorkday } from 'chinese-days';

export interface ScheduleCalendar {
    mode: 'legacy' | 'workdays' | 'every_day' | 'selected_dates';
    dates: Record<string, boolean>;
}

export function normalizeScheduleCalendar(value: unknown): ScheduleCalendar {
    const raw = value as Partial<ScheduleCalendar> | null;
    const mode = raw && ['legacy', 'workdays', 'every_day', 'selected_dates'].includes(raw.mode || '')
        ? raw.mode! : 'legacy';
    const dates: Record<string, boolean> = {};
    if (raw?.dates && typeof raw.dates === 'object' && !Array.isArray(raw.dates)) {
        for (const [date, enabled] of Object.entries(raw.dates)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof enabled === 'boolean') {
                const parsed = new Date(`${date}T12:00:00Z`);
                if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) dates[date] = enabled;
            }
        }
    }
    return { mode, dates };
}

/** Calendar exceptions affect eligibility, never task enablement or scheduled time. */
export function isScheduleDateEnabled(date: string, schedule: Record<string, any>, legacyExempt = false): boolean {
    const calendar = normalizeScheduleCalendar(schedule.calendar);
    if (Object.hasOwn(calendar.dates, date)) return calendar.dates[date]!;
    if (calendar.mode === 'selected_dates') return false;
    if (calendar.mode === 'every_day') return true;
    if (calendar.mode === 'legacy' && (legacyExempt || schedule.workdays_only === false)) return true;
    return isWorkday(date);
}
