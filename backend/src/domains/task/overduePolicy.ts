import dayjs from 'dayjs';
import { parseClockTime, zonedClock } from '@/core/scheduleTime';

export type OverdueTier = "overdue_day1" | "overdue_day3" | "overdue_day5";
export type DueReminderScenario = "due_tomorrow" | "due_today" | OverdueTier;

export interface OverduePolicy {
    daysOverdue: number;
    tier: OverdueTier;
    label: string;
}

export interface DueReminderSchedule {
    startTime: string;
    endTime: string;
    timeZone: string;
}

const REMINDER_TIMES: Record<DueReminderScenario, string[]> = {
    due_tomorrow: ["10:00"],
    due_today: ["10:00"],
    overdue_day1: ["10:00"],
    overdue_day3: ["10:00", "16:00"],
    overdue_day5: Array.from({ length: 10 }, (_, index) => `${String(index + 9).padStart(2, "0")}:00`),
};

export function overduePolicy(dueDate: unknown, referenceDate: Date | string = new Date()): OverduePolicy | null {
    const due = dayjs(String(dueDate || "")).startOf('day');
    const reference = dayjs(referenceDate).startOf('day');
    if (!due.isValid() || !reference.isValid()) return null;

    const daysOverdue = reference.diff(due, 'day');
    if (daysOverdue < 1) return null;

    if (daysOverdue >= 5) {
        return { daysOverdue, tier: "overdue_day5", label: "超期 5 天以上" };
    }
    if (daysOverdue >= 3) {
        return { daysOverdue, tier: "overdue_day3", label: "超期 3–4 天" };
    }
    return { daysOverdue, tier: "overdue_day1", label: "超期 1–2 天" };
}

export function dueReminderSlot(
    scenario: DueReminderScenario,
    referenceDate: Date,
    schedule: DueReminderSchedule,
): string | null {
    const clock = zonedClock(referenceDate, schedule.timeZone);
    const start = parseClockTime(schedule.startTime);
    const end = parseClockTime(schedule.endTime);
    if (!clock || start === null || end === null || clock.minuteOfDay < start || clock.minuteOfDay > end) {
        return null;
    }

    const latest = REMINDER_TIMES[scenario]
        .filter(time => {
            const minute = parseClockTime(time);
            return minute !== null && minute >= start && minute <= end && minute <= clock.minuteOfDay;
        })
        .at(-1);
    return latest ? `${clock.date}:${latest}` : null;
}
