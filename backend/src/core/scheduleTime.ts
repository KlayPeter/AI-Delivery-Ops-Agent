export interface ZonedClock {
    date: string;
    time: string;
    minuteOfDay: number;
}

export function parseClockTime(value: unknown): number | null {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

export function zonedClock(value: Date | string, timeZone: string): ZonedClock | null {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    try {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).formatToParts(date);
        const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
        const year = get("year");
        const month = get("month");
        const day = get("day");
        const hour = get("hour");
        const minute = get("minute");
        const minuteOfDay = parseClockTime(`${hour}:${minute}`);
        if (!year || !month || !day || minuteOfDay === null) return null;
        return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}`, minuteOfDay };
    } catch {
        return null;
    }
}

export function isRecurringTimeDue(
    value: Date,
    startTime: unknown,
    endTime: unknown,
    intervalMinutes: unknown,
    timeZone: string,
): boolean {
    const clock = zonedClock(value, timeZone);
    const start = parseClockTime(startTime);
    const end = parseClockTime(endTime);
    const interval = Number(intervalMinutes);
    if (!clock || start === null || end === null || start > end) return false;
    if (!Number.isInteger(interval) || interval < 1) return false;
    if (clock.minuteOfDay < start || clock.minuteOfDay > end) return false;
    return (clock.minuteOfDay - start) % interval === 0;
}
