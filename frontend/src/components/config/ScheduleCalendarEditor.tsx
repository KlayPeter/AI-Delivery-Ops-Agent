import { Alert, Button, DatePicker, Select, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import type { Dayjs } from 'dayjs';

type CalendarValue = {
  mode: 'legacy' | 'workdays' | 'every_day' | 'selected_dates';
  dates: Record<string, boolean>;
};

export function ScheduleCalendarEditor({ value, onChange, workdaysOnly = true }: {
  value?: CalendarValue;
  onChange?: (value: CalendarValue) => void;
  workdaysOnly?: boolean;
}) {
  const calendar = value || { mode: 'legacy', dates: {} };
  const [date, setDate] = useState<Dayjs | null>(null);
  const [enabled, setEnabled] = useState(true);
  const dates = calendar.dates || {};
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <Select
        aria-label="节假日触发策略"
        value={calendar.mode}
        style={{ width: '100%' }}
        onChange={mode => onChange?.({ ...calendar, mode })}
        options={[
          { value: 'legacy', label: `沿用原规则（${workdaysOnly ? '中国工作日' : '每天'}；周报、到期提醒不受限）` },
          { value: 'workdays', label: '中国工作日触发（跳过周末和法定假期，包含调休上班日）' },
          { value: 'every_day', label: '每天触发（不使用节假日限制）' },
          { value: 'selected_dates', label: '仅在指定日期触发' },
        ]}
      />
      <Alert type="info" showIcon title="指定日期优先于上方规则" description="适用于本群站会、日报、周报、看板及自动催办。指定触发仍需开启对应任务，并按原定时刻执行；周报仍只在周五执行。跨午夜的站会补充汇总按被汇总日期判断。保存配置后约 30 秒生效。" />
      <Space wrap>
        <DatePicker style={{ width: 210 }} value={date} onChange={setDate} placeholder="在日历中选择日期" aria-label="选择例外日期" />
        <Select value={enabled ? 'run' : 'skip'} onChange={value => setEnabled(value === 'run')} aria-label="日期执行方式" style={{ width: 130 }} options={[
          { value: 'run', label: '指定触发' }, { value: 'skip', label: '暂停触发' },
        ]} />
        <Button disabled={!date} onClick={() => {
          if (date) onChange?.({ ...calendar, dates: { ...dates, [date.format('YYYY-MM-DD')]: enabled } });
          setDate(null);
        }}>添加 / 更新日期</Button>
      </Space>
      <div aria-label="已设置日期">
        {Object.entries(dates).sort(([a], [b]) => a.localeCompare(b)).map(([day, run]) => (
          <Tag key={day} color={run ? 'green' : 'red'} closable onClose={() => {
            const next = { ...dates };
            delete next[day];
            onChange?.({ ...calendar, dates: next });
          }}>{day} · {run ? '指定触发' : '暂停触发'}</Tag>
        ))}
        {!Object.keys(dates).length && <Typography.Text type="secondary">尚未设置例外日期</Typography.Text>}
      </div>
    </Space>
  );
}
