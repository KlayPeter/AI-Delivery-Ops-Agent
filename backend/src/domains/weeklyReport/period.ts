import dayjs from "dayjs";
import { zonedClock } from "@/core/scheduleTime";
import type { WeeklyPeriod, WeeklyPeriodKind } from "./types";

function mondayOf(dateText: string): dayjs.Dayjs {
    const date = dayjs(dateText);
    const weekday = date.day();
    return date.subtract(weekday === 0 ? 6 : weekday - 1, "day");
}

function weekdays(start: dayjs.Dayjs, end: dayjs.Dayjs): string[] {
    const result: string[] = [];
    for (let current = start; !current.isAfter(end, "day"); current = current.add(1, "day")) {
        if (current.day() >= 1 && current.day() <= 5) result.push(current.format("YYYY-MM-DD"));
    }
    return result;
}

export function resolveWeeklyPeriod(
    kind: WeeklyPeriodKind,
    cutoffAt = new Date().toISOString(),
    timeZone = "Asia/Shanghai",
): WeeklyPeriod {
    const clock = zonedClock(cutoffAt, timeZone);
    if (!clock) throw new Error(`无效的周报截止时间或时区：${cutoffAt} / ${timeZone}`);

    const currentMonday = mondayOf(clock.date);
    const start = kind === "last_week" ? currentMonday.subtract(7, "day") : currentMonday;
    const friday = start.add(4, "day");
    const cutoffDate = dayjs(clock.date);
    const end = kind === "current_week" && cutoffDate.isBefore(friday, "day") ? cutoffDate : friday;
    const businessDays = weekdays(start, end);

    return {
        kind,
        start: start.format("YYYY-MM-DD"),
        end: end.format("YYYY-MM-DD"),
        cutoff_at: cutoffAt,
        time_zone: timeZone,
        business_days: businessDays,
        is_partial: kind === "current_week" && end.isBefore(friday, "day"),
    };
}
