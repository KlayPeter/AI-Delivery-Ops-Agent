import { teamSchedules } from './helpers/schedules';
import { pluginJobs } from '@/agents/plugins/jobs';
import { ScheduleRegistry } from '@/platform/scheduling/registry';
import { describe, expect, test } from 'bun:test';
import { buildConfig } from '@/core/config';
import { isScheduleDateEnabled, normalizeScheduleCalendar } from '@/core/scheduleCalendar';
import { InProcessScheduler } from '@/core/scheduler';

describe('automatic task calendar', () => {
    test('recognizes holidays, weekends and make-up working days', () => {
        const schedule = { calendar: { mode: 'workdays' } };
        for (const [date, enabled] of [['2026-10-01', false], ['2026-07-12', false], ['2026-10-10', true], ['2026-07-13', true]] as const) {
            expect(isScheduleDateEnabled(date, schedule)).toBe(enabled);
        }
    });
    test('date overrides take priority over all policies and legacy exemptions', () => {
        for (const mode of ['legacy', 'workdays', 'every_day', 'selected_dates']) {
            const schedule = { calendar: { mode, dates: { '2026-10-01': true, '2026-07-13': false } } };
            expect(isScheduleDateEnabled('2026-10-01', schedule)).toBe(true);
            expect(isScheduleDateEnabled('2026-07-13', schedule, true)).toBe(false);
        }
        expect(isScheduleDateEnabled('2026-10-01', { calendar: { mode: 'every_day' } })).toBe(true);
        expect(isScheduleDateEnabled('2026-07-13', { calendar: { mode: 'selected_dates' } })).toBe(false);
        expect(isScheduleDateEnabled('2026-10-01', { workdays_only: true })).toBe(false);
        expect(isScheduleDateEnabled('2026-10-01', { workdays_only: false })).toBe(true);
        expect(isScheduleDateEnabled('2026-10-01', { workdays_only: true }, true)).toBe(true);
        expect(isScheduleDateEnabled('2026-10-01', { calendar: { mode: 'workdays' } }, true)).toBe(false);
    });
    test('configuration discards impossible dates and non-boolean overrides', () => {
        expect(normalizeScheduleCalendar({ mode: 'invalid', dates: {
            '2026-02-30': true, '2026-02-28': false, '2026-10-01': 'true', bad: true,
        } })).toEqual({ mode: 'legacy', dates: { '2026-02-28': false } });
        const calendar = { mode: 'workdays', dates: { '2026-10-01': true } };
        expect(buildConfig({ groups: [{ chat_id: 'g', schedule: { calendar } }] }).groups[0]!.schedule.calendar).toEqual(calendar);
    });
    function harness(schedule: Record<string, any>) {
        const raw = { groups: [{ chat_id: 'g', schedule: {
            module_standup_enabled: true, standup_push_enabled: true, standup_push: '09:00',
            standup_second_remind_enabled: false, standup_summary_enabled: false,
            overdue_scan_enabled: false, module_weekly_report_enabled: true,
            weekly_report_enabled: true, weekly_report: '09:00', weekly_report_timezone: 'Asia/Shanghai', ...schedule,
        } }] };
        const calls: string[] = [], claims: string[] = [];
        const ctx: any = { schedules: teamSchedules(), store: {
            getDynamicConfig: async () => raw, appendAuditLog: async () => {},
            claimIdempotencyKey: async (key: string) => { claims.push(key); return true; }, setIdempotencyKey: async () => {},
        } };
        const scheduler = new InProcessScheduler(() => ({ ctx }) as any, 30, 0);
        const poll = ctx.schedules.get('task-standup-remind');
        const original = poll.run;
        ctx.schedules = new ScheduleRegistry();
        for (const entry of teamSchedules().list()) {
            ctx.schedules.register(entry.id !== poll.id ? entry : {
                ...entry,
                run: async (context: any) => {
                    context.resources.set(pluginJobs, { taskStandupRemindDue: async () => {
                        calls.push('commitment'); return { sent: 0, failed: 0 };
                    } });
                    return original(context);
                },
            });
        }
        (scheduler as any).runJob = async (_handler: unknown, name: string) => { calls.push(name); return {}; };
        return { scheduler, calls, claims };
    }
    test('holiday stops weekly reports and due reminders before claiming jobs', async () => {
        const h = harness({ calendar: { mode: 'workdays' } });
        await h.scheduler.tick(new Date('2026-10-02T09:00:00+08:00'));
        expect(h.calls).toEqual([]); expect(h.claims).toEqual([]);
    });
    test('holiday override respects time and task switches', async () => {
        const h = harness({
            standup_push: new Date('2026-10-02T09:00:00+08:00').toTimeString().slice(0, 5),
            calendar: { mode: 'workdays', dates: { '2026-10-02': true } },
        });
        await h.scheduler.tick(new Date('2026-10-02T09:00:00+08:00'));
        expect(h.calls).toContain('standup-push'); expect(h.calls).toContain('weekly-report');
        expect(h.calls).toContain('commitment'); expect(h.calls).not.toContain('overdue-scan');
        h.calls.length = 0;
        await h.scheduler.tick(new Date('2026-10-02T08:59:00+08:00'));
        expect(h.calls).toEqual(['commitment']);
    });
    test('weekly calendar uses the configured timezone date', async () => {
        const h = harness({ weekly_report: '00:30', calendar: { mode: 'every_day', dates: { '2026-10-02': false } } });
        await h.scheduler.tick(new Date('2026-10-01T16:30:00Z'));
        expect(h.calls).not.toContain('weekly-report');
    });
});
