import { useEffect, useState } from 'react';
import { Form, Button, Spin, message, Row, Col, Alert, Typography, Tabs, Card } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';

import { GroupConfigList } from '@/components/config/GroupConfigList';
import { CompanyDirectoryTree } from '../components/config/CompanyDirectoryTree';

const JOBS = [
  { id: 'standup_push', name: '普通站会首次提醒' },
  { id: 'standup_second_remind', name: '站会再次提醒' },
  { id: 'standup_mark_missing', name: '记录未交站会' },
  { id: 'standup_summary', name: '生成站会汇总' },
  { id: 'overdue_scan', name: '超期任务扫描' },
  { id: 'daily_summary', name: '群聊日报归纳' },
  { id: 'weekly_report', name: '周报生成与发送' },
  { id: 'dashboard', name: '看板生成与上传' },
];

const buildDynamicConfigPayload = (config: any) => ({
  runtime: {
    public_base_url: config.runtime?.public_base_url,
    public_missing_standups: config.runtime?.public_missing_standups,
    public_overdue_owners: config.runtime?.public_overdue_owners,
    daily_summary_period: config.runtime?.daily_summary_period,
    daily_summary_fetch_history: config.runtime?.daily_summary_fetch_history,
    daily_summary_fetch_page_size: config.runtime?.daily_summary_fetch_page_size,
  },
  schedule: config.schedule || {},
  groups: config.groups || [],
});

const ConfigPage = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [originalConfig, setOriginalConfig] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('1');

  useEffect(() => {
    let cancelled = false;

    // Fetch groups
    setGroupsLoading(true);
    api.fetchGroups().then((data: any) => {
      if (!cancelled) setGroups(data);
    }).catch((err: any) => {
      console.error('Failed to fetch groups:', err);
    }).finally(() => {
      if (!cancelled) setGroupsLoading(false);
    });

    api.fetchConfig().then(data => {
      if (cancelled) return;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('配置格式不正确');
      }
      // Ensure missing enabled flags default to true for UI display
      const config = { ...data, schedule: { ...(data.schedule || {}) }, runtime: { ...(data.runtime || {}) } };
      if (config.runtime.daily_summary_period) {
        const [start, end] = config.runtime.daily_summary_period.split('-');
        config.runtime.daily_summary_period_start = dayjs(start, 'HH:mm');
        config.runtime.daily_summary_period_end = dayjs(end, 'HH:mm');
      } else {
        config.runtime.daily_summary_period_start = dayjs('00:00', 'HH:mm');
        config.runtime.daily_summary_period_end = dayjs('23:59', 'HH:mm');
      }
      if (config.groups && Array.isArray(config.groups)) {
        config.groups = config.groups.map((group: any) => {
          const gSchedule: any = { ...(group.schedule || {}) };
          const fallback = config.schedule || {};

          JOBS.forEach(job => {
            if (gSchedule[`${job.id}_enabled`] === undefined) {
              gSchedule[`${job.id}_enabled`] = fallback[`${job.id}_enabled`] !== undefined ? fallback[`${job.id}_enabled`] : false;
            }
          });

          const overdueEnd = gSchedule.overdue_scan_end || fallback.overdue_scan_end || '18:30';
          gSchedule.overdue_scan_end = typeof overdueEnd === 'string' ? dayjs(overdueEnd, 'HH:mm') : overdueEnd;
          gSchedule.overdue_scan_interval_minutes = gSchedule.overdue_scan_interval_minutes || fallback.overdue_scan_interval_minutes || 30;
          gSchedule.overdue_scan_timezone = gSchedule.overdue_scan_timezone || fallback.overdue_scan_timezone || 'Asia/Shanghai';
          gSchedule.weekly_report_timezone = gSchedule.weekly_report_timezone || fallback.weekly_report_timezone || 'Asia/Shanghai';

          ['module_standup_enabled', 'module_daily_summary_enabled', 'module_weekly_report_enabled', 'module_dashboard_enabled'].forEach(mod => {
            if (gSchedule[mod] === undefined) {
              gSchedule[mod] = fallback[mod] !== undefined ? fallback[mod] : false;
            }
          });
          if (gSchedule.task_standup_enabled === undefined) {
            gSchedule.task_standup_enabled = fallback.task_standup_enabled ?? false;
          }
          const taskTemplateTime = gSchedule.task_standup_template || fallback.task_standup_template || '09:00';
          gSchedule.task_standup_template = typeof taskTemplateTime === 'string'
            ? dayjs(taskTemplateTime, 'HH:mm')
            : taskTemplateTime;

          JOBS.forEach(job => {
            let timeVal = gSchedule[job.id] || fallback[job.id];

            // specific defaults
            if (!timeVal) {
              if (job.id === 'standup_second_remind') timeVal = gSchedule.standup_remind || fallback.standup_remind || '09:30';
              if (job.id === 'standup_mark_missing') timeVal = '11:00';
            }

            if (timeVal && typeof timeVal === 'string') {
              gSchedule[job.id] = dayjs(timeVal, 'HH:mm');
            } else if (dayjs.isDayjs(timeVal)) {
              gSchedule[job.id] = timeVal;
            } else {
              gSchedule[job.id] = null;
            }
          });

          let dsPeriodStart = dayjs('00:00', 'HH:mm');
          let dsPeriodEnd = dayjs('23:59', 'HH:mm');
          if (group.daily_summary_period) {
            const [start, end] = group.daily_summary_period.split('-');
            dsPeriodStart = dayjs(start, 'HH:mm');
            dsPeriodEnd = dayjs(end, 'HH:mm');
          } else if (config.runtime.daily_summary_period) {
            const [start, end] = config.runtime.daily_summary_period.split('-');
            dsPeriodStart = dayjs(start, 'HH:mm');
            dsPeriodEnd = dayjs(end, 'HH:mm');
          }

          return {
            ...group,
            schedule: gSchedule,
            daily_summary_period_start: dsPeriodStart,
            daily_summary_period_end: dsPeriodEnd
          };
        });
      }

      setOriginalConfig(config);
      form.setFieldsValue(config);
      setLoading(false);
    }).catch((err: any) => {
      if (cancelled) return;
      setLoadError(err.message || '请求失败');
      message.error('加载配置失败：' + (err.message || '请求失败'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [form]);


  const getDefaultGroupData = () => {
    const fallback: any = originalConfig?.schedule || {};
    const s: any = {
      module_standup_enabled: fallback.module_standup_enabled !== undefined ? fallback.module_standup_enabled : false,
      module_daily_summary_enabled: fallback.module_daily_summary_enabled !== undefined ? fallback.module_daily_summary_enabled : false,
      module_weekly_report_enabled: fallback.module_weekly_report_enabled !== undefined ? fallback.module_weekly_report_enabled : false,
      module_dashboard_enabled: fallback.module_dashboard_enabled !== undefined ? fallback.module_dashboard_enabled : false,
      task_standup_enabled: fallback.task_standup_enabled !== undefined ? fallback.task_standup_enabled : false,
      task_standup_template: dayjs(fallback.task_standup_template || '09:00', 'HH:mm'),
    };
    JOBS.forEach((job: any) => {
      s[`${job.id}_enabled`] = fallback[`${job.id}_enabled`] !== undefined ? fallback[`${job.id}_enabled`] : false;
      let timeVal = fallback[job.id];
      if (!timeVal) {
        if (job.id === 'standup_second_remind') timeVal = fallback.standup_remind || '09:30';
        if (job.id === 'standup_mark_missing') timeVal = '11:00';
      }
      s[job.id] = timeVal ? dayjs(timeVal, 'HH:mm') : null;
    });
    s.overdue_scan_end = dayjs(fallback.overdue_scan_end || '18:30', 'HH:mm');
    s.overdue_scan_interval_minutes = fallback.overdue_scan_interval_minutes || 30;
    s.overdue_scan_timezone = fallback.overdue_scan_timezone || 'Asia/Shanghai';
    s.weekly_report_timezone = fallback.weekly_report_timezone || 'Asia/Shanghai';
    return {
      members: [],
      schedule: s,
      daily_summary_period_start: dayjs('00:00', 'HH:mm'),
      daily_summary_period_end: dayjs('23:59', 'HH:mm')
    };
  };

  const onFinish = async () => {
    const values = form.getFieldsValue(true);
    setSaving(true);
    try {
      const mergedConfig = {
        ...originalConfig,
        ...values,
        runtime: {
          ...originalConfig.runtime,
          ...values.runtime,
        },
        feishu: {
          ...originalConfig.feishu,
          ...values.feishu,
        },
        tapd: {
          ...originalConfig.tapd,
          ...values.tapd,
        },
        ai: {
          ...originalConfig.ai,
          ...values.ai,
        },
      };
      if (mergedConfig.runtime && mergedConfig.runtime.daily_summary_period_start && mergedConfig.runtime.daily_summary_period_end) {
        const start = mergedConfig.runtime.daily_summary_period_start;
        const end = mergedConfig.runtime.daily_summary_period_end;
        mergedConfig.runtime.daily_summary_period = `${start.format('HH:mm')}-${end.format('HH:mm')}`;
        delete mergedConfig.runtime.daily_summary_period_start;
        delete mergedConfig.runtime.daily_summary_period_end;
      }
      if (mergedConfig.groups && Array.isArray(mergedConfig.groups)) {
        mergedConfig.groups = mergedConfig.groups.filter((g: any) => g && g.chat_id).map((group: any) => {
          const gSchedule: any = { ...(group.schedule || {}) };
          JOBS.forEach(job => {
            if (gSchedule[job.id] && dayjs.isDayjs(gSchedule[job.id])) {
              gSchedule[job.id] = gSchedule[job.id].format('HH:mm');
            }
          });
          if (gSchedule.task_standup_template && dayjs.isDayjs(gSchedule.task_standup_template)) {
            gSchedule.task_standup_template = gSchedule.task_standup_template.format('HH:mm');
          }
          if (gSchedule.overdue_scan_end && dayjs.isDayjs(gSchedule.overdue_scan_end)) {
            gSchedule.overdue_scan_end = gSchedule.overdue_scan_end.format('HH:mm');
          }

          let daily_summary_period = group.daily_summary_period;
          if (group.daily_summary_period_start && group.daily_summary_period_end) {
            daily_summary_period = `${group.daily_summary_period_start.format('HH:mm')}-${group.daily_summary_period_end.format('HH:mm')}`;
          }
          const groupInfo = groups.find((g: any) => g.chat_id === group.chat_id);
          const name = groupInfo ? groupInfo.name : (group.name || group.chat_id);
          const cleanedGroup = { ...group, name, schedule: gSchedule, daily_summary_period };
          delete cleanedGroup.daily_summary_period_start;
          delete cleanedGroup.daily_summary_period_end;

          return cleanedGroup;
        });
      }
      const saved = await api.saveConfig(buildDynamicConfigPayload(mergedConfig));
      const persistedGroups = new Map<string, any>((saved?.config?.groups || []).map((group: any) => [group.chat_id, group]));
      const moduleMismatches = (mergedConfig.groups || []).filter((group: any) => {
        const persisted = persistedGroups.get(group.chat_id);
        if (!persisted) return false;
        return Boolean(group.schedule?.module_daily_summary_enabled) !== Boolean(persisted.schedule?.module_daily_summary_enabled)
          || Boolean(group.schedule?.daily_summary_enabled) !== Boolean(persisted.schedule?.daily_summary_enabled)
          || Boolean(group.schedule?.module_weekly_report_enabled) !== Boolean(persisted.schedule?.module_weekly_report_enabled)
          || Boolean(group.schedule?.weekly_report_enabled) !== Boolean(persisted.schedule?.weekly_report_enabled)
          || Boolean(group.schedule?.task_standup_enabled) !== Boolean(persisted.schedule?.task_standup_enabled);
      });
      if (moduleMismatches.length > 0) {
        message.error(`配置已提交，但后端确认的站会/日报/周报开关与页面不一致：${moduleMismatches.map((group: any) => group.name || group.chat_id).join('、')}。请刷新页面后重试。`);
        return;
      }
      message.success('配置保存成功，定时器会在 30 秒内读取新配置');
      setOriginalConfig(mergedConfig);
    } catch (err: any) {
      message.error('保存配置失败：' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '50px auto' }} />;
  }

  return (
    <div style={{ padding: "24px", flex: 1, overflow: "auto", backgroundColor: "#f5f5f5" }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0, marginBottom: 8 }}>系统配置</Typography.Title>
          <Typography.Text type="secondary" style={{ display: 'block' }}>管理群组绑定、业务配置和定时任务开关</Typography.Text>
        </div>
      </div>

      {loadError && (
        <Alert
          message="配置加载失败"
          description={loadError}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        tabBarExtraContent={
          activeTab === '1' ? (
            <Button
              type="primary"
              onClick={() => form.submit()}
              loading={saving}
              disabled={!originalConfig}
            >
              保存配置
            </Button>
          ) : null
        }
        items={[
          {
            key: '1',
            label: '群组与系统配置',
            children: (
              <Form form={form} layout="vertical" onFinish={onFinish}>
                <Row gutter={24}>
                  <Col span={24}>
                    <GroupConfigList
                      form={form}
                      groups={groups}
                      groupsLoading={groupsLoading}
                      originalConfig={originalConfig}
                      getDefaultGroupData={getDefaultGroupData}
                      refreshGroups={async () => {
                        setGroupsLoading(true);
                        try {
                          const data = await api.fetchGroups();
                          setGroups(data);
                          message.success("已刷新飞书群聊列表");
                        } catch (e: any) {
                          message.error("刷新群聊列表失败: " + e.message);
                        } finally {
                          setGroupsLoading(false);
                        }
                      }}
                    />
                  </Col>
                </Row>
              </Form>
            )
          },
          {
            key: '2',
            label: '公司通讯录',
            children: <CompanyDirectoryTree />
          }
        ]}
      />
      </div>
    </div>
  );
};

export default ConfigPage;
