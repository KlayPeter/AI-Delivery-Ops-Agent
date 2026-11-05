import dayjs from 'dayjs';
import { isScheduleDateEnabled } from '@/core/scheduleCalendar';
import type { GroupScheduleContext, SchedulePlan } from './registry';

export function calendarPlan(context: GroupScheduleContext, date: string, time: string, day = context.now, legacyExempt = false): SchedulePlan | null {
    const workdaysOnly = context.group.schedule.workdays_only ?? context.ctx.config.schedule.workdays_only;
    return isScheduleDateEnabled(date, { ...context.group.schedule, workdays_only: workdaysOnly }, legacyExempt)
        ? { day, date, time } : null;
}

export function localTimePlan(context: GroupScheduleContext, time: unknown, day = context.now): SchedulePlan | null {
    if (typeof time !== 'string') return null;
    const [hour, minute] = time.split(':', 2);
    if (parseInt(hour!, 10) !== context.now.getHours() || parseInt(minute!, 10) !== context.now.getMinutes()) return null;
    return calendarPlan(context, dayjs(day).format('YYYY-MM-DD'), time, day);
}
