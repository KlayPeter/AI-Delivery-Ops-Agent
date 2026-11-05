import { Form, Button, Card, Row, Col, Select, Space, TimePicker, Input, InputNumber, Switch, message, FormInstance, Typography, Modal, Table, Popconfirm, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { api } from '@/api';
import { ScheduleCalendarEditor } from './ScheduleCalendarEditor';

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

interface GroupConfigListProps {
  form: FormInstance;
  groups: any[];
  groupsLoading: boolean;
  originalConfig: any;
  getDefaultGroupData: () => any;
  refreshGroups: () => void;
}

const mergeFetchedMembers = (currentMembers: any[] = [], fetchedMembers: any[] = []) => {
  const currentByOpenId = new Map(
    currentMembers
      .filter((member: any) => member?.open_id)
      .map((member: any) => [member.open_id, member])
  );
  const seen = new Set<string>();

  return fetchedMembers
    .map((member: any) => {
      const openId = String(member?.open_id || member?.member_id || member?.user_id || '').trim();
      if (!openId || seen.has(openId)) return null;
      seen.add(openId);

      const previous = currentByOpenId.get(openId);
      return {
        name: String(member?.name || member?.user_name || member?.en_name || previous?.name || openId).trim(),
        open_id: openId,
        role: previous?.role,
        job_title: member?.job_title ?? previous?.job_title,
        is_active: true,
      };
    })
    .filter(Boolean);
};

export const GroupConfigList = ({ form, groups, groupsLoading, originalConfig, getDefaultGroupData, refreshGroups }: GroupConfigListProps) => {
  const [editingGroupKey, setEditingGroupKey] = useState<number | null>(null);

  const refreshGroupMembers = async (groupName: number, chatId: string, successText: string) => {
    const hide = message.loading('获取群成员中...', 0);
    try {
      const members: any[] = await api.fetchGroupMembers(chatId);
      if (members.length === 0) {
        hide();
        message.warning('未获取到群成员，请检查机器人是否在群内及接口权限');
        return;
      }

      const currentGroups = form.getFieldValue('groups') || [];
      const currentGroup = currentGroups[groupName] || {};
      const mergedMembers = mergeFetchedMembers(currentGroup.members || [], members);
      if (mergedMembers.length === 0) {
        hide();
        message.warning('未获取到可保存的群成员，请确认飞书接口返回 open_id');
        return;
      }

      const newGroups = [...currentGroups];
      newGroups[groupName] = {
        ...currentGroup,
        members: mergedMembers,
      };
      form.setFieldsValue({ groups: newGroups });
      hide();
      message.success(successText);
    } catch (e: any) {
      hide();
      message.error('获取群成员失败：' + e.message);
    }
  };

  return (
    <Card title="群组配置" extra={
      <Space>
        <Button type="link" onClick={refreshGroups} loading={groupsLoading}>
          刷新飞书群聊
        </Button>
      </Space>
    } style={{ boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)' }} bordered={false}>
      <Form.List name="groups">
        {(groupFields, { add: addGroup, remove: removeGroup }) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Button type="primary" onClick={() => addGroup(getDefaultGroupData())} icon={<PlusOutlined />}>
                添加新群组
              </Button>
            </div>
            <Table
              dataSource={groupFields}
              pagination={false}
              rowKey="key"
              size="small"
              columns={[
                {
                  title: '群组序号',
                  key: 'index',
                  align: 'center',
                  width: 120,
                  render: (_, __, index) => <strong style={{ fontSize: '15px' }}>{`群组 ${index + 1}`}</strong>
                },
                {
                  title: '绑定的飞书群聊',
                  key: 'chat_id',
                  render: (_, { key: groupKey, name: groupName, ...restGroupField }) => (
                    <>
                    <Form.Item
                      {...restGroupField}
                      name={[groupName, 'chat_id']}
                      rules={[{ required: true, message: '请选择或输入群聊ID' }]}
                      style={{ margin: 0, minWidth: 200 }}
                    >
                      <Select
                        showSearch
                        allowClear
                        loading={groupsLoading}
                        placeholder="请选择或输入群聊"
                        optionFilterProp="children"
                        filterOption={(input, option) =>
                          (option?.label ?? '').toLowerCase().includes(input.toLowerCase()) ||
                          (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                        }
                        options={(() => {
                          const selectedChats = form.getFieldValue('groups')?.map((g: any) => g?.chat_id).filter(Boolean) || [];
                          const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);

                          const combinedGroups = [...groups];
                          if (originalConfig && originalConfig.groups) {
                            originalConfig.groups.forEach((og: any) => {
                              if (og.chat_id && !combinedGroups.find((g: any) => g.chat_id === og.chat_id)) {
                                combinedGroups.push({ chat_id: og.chat_id, name: og.name || og.chat_id });
                              }
                            });
                          }

                          return combinedGroups.map((g: any) => ({
                            label: g.name,
                            value: g.chat_id,
                            disabled: selectedChats.includes(g.chat_id) && g.chat_id !== currentChatId
                          }));
                        })()}
                        onChange={async (val) => {
                          if (val) {
                            await refreshGroupMembers(groupName, val, '群成员已自动获取并填入！');
                          }
                        }}
                      />
                    </Form.Item>
                    <Form.Item noStyle dependencies={[['groups', groupName, 'chat_id']]}>
                      {() => {
                    const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);
                    if (!currentChatId) return null;

                    let chatName = '';
                    const foundInGroups = groups.find(g => g.chat_id === currentChatId);
                    if (foundInGroups) chatName = foundInGroups.name;
                    else if (originalConfig?.groups) {
                      const og = originalConfig.groups.find((g: any) => g.chat_id === currentChatId);
                      if (og) chatName = og.name;
                    }
                    const displayTitle = chatName ? `高级配置 - ${chatName}` : `高级配置 - 群组 ${groupName + 1}`;

                    return (
                      <Modal
                        title={displayTitle}
                        open={editingGroupKey === groupKey}
                        onCancel={() => setEditingGroupKey(null)}
                        footer={
                          <div style={{ textAlign: 'right', marginTop: 24 }}>
                            <Button onClick={() => setEditingGroupKey(null)} style={{ marginRight: 8 }}>关闭</Button>
                            <Button type="primary" onClick={() => {
                              setEditingGroupKey(null);
                              form.submit();
                            }}>保存当前配置</Button>
                          </div>
                        }
                        width={800}
                        forceRender
                        styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
                      >

                <Form.Item label="群聊日报统计周期" required style={{ marginBottom: 16 }}>
                  <Space align="baseline">
                    <Form.Item {...restGroupField} name={[groupName, 'daily_summary_period_start']} rules={[{ required: true, message: '请选择起始时间' }]} style={{ marginBottom: 0 }}>
                      <TimePicker format="HH:mm" placeholder="起始时间" />
                    </Form.Item>
                    <span style={{ margin: '0 8px' }}>至</span>
                    <Form.Item {...restGroupField} name={[groupName, 'daily_summary_period_end']} rules={[{ required: true, message: '请选择结束时间' }]} style={{ marginBottom: 0 }}>
                      <TimePicker format="HH:mm" placeholder="结束时间" />
                    </Form.Item>
                  </Space>
                  <div style={{ fontSize: '12px', color: '#888', marginTop: 8 }}>
                    注：若起始时间 ≥ 结束时间，则视为跨天（如 18:00 至 18:00 为昨日18点到今日18点）。
                  </div>
                </Form.Item>

                <Form.Item label={
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ marginRight: 8 }}>群成员列表</span>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={async () => {
                      const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);
                      if (!currentChatId) { message.warning('请先选择群聊'); return; }
                      await refreshGroupMembers(groupName, currentChatId, '群成员已重新获取！');
                    }}>
                      重新拉取群成员
                    </Button>
                  </div>
                } style={{ marginBottom: 0 }}>
                  <Form.List name={[groupName, 'members']}>
                    {(memberFields) => (
                      <>
                        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                          成员与职务由飞书自动同步；角色仅用于人工覆盖自动判断。
                        </Typography.Text>
                        {memberFields.map(({ key: memberKey, name: memberName, ...restMemberField }) => (
                          <Space key={memberKey} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                            <Form.Item
                              {...restMemberField}
                              name={[memberName, 'name']}
                              rules={[{ required: true, message: '请输入姓名' }]}
                              style={{ width: 200 }}
                            >
                              <Input placeholder="姓名" disabled />
                            </Form.Item>
                            <Form.Item
                              {...restMemberField}
                              name={[memberName, 'open_id']}
                              rules={[{ required: true, message: '请输入 open_id' }]}
                              hidden
                            >
                              <Input />
                            </Form.Item>
                            <Form.Item
                              {...restMemberField}
                              name={[memberName, 'job_title']}
                              style={{ width: 220 }}
                            >
                              <Input placeholder="职务" disabled />
                            </Form.Item>
                            <Form.Item
                              {...restMemberField}
                              name={[memberName, 'role']}
                              style={{ width: 200 }}
                            >
                              <Input placeholder="人工角色覆盖（可选）" />
                            </Form.Item>
                            <Form.Item
                              {...restMemberField}
                              name={[memberName, 'is_active']}
                              valuePropName="checked"
                              hidden
                            >
                              <Switch />
                            </Form.Item>
                          </Space>
                        ))}
                      </>
                    )}
                  </Form.List>
                </Form.Item>

                <div style={{ marginTop: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
                    <h4 style={{ margin: 0, marginRight: 12 }}>群组定时任务配置</h4>
                    <span style={{ color: '#888', fontSize: 13 }}>注：后端服务常驻时会按这里的时间自动触发；模块开关可整体开启/关闭功能。</span>
                  </div>

                  <Form.Item name={[groupName, 'schedule', 'calendar']} label="自动任务日期与节假日" style={{ marginBottom: 24 }}>
                    <ScheduleCalendarEditor workdaysOnly={form.getFieldValue(['groups', groupName, 'schedule', 'workdays_only']) !== false} />
                  </Form.Item>

                  {/* 站会收集模块 */}
                  <div style={{ border: '1px solid #91caff', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
                    <Form.Item noStyle dependencies={[['groups', groupName, 'schedule', 'module_standup_enabled']]}>
                      {() => {
                        const isExpanded = form.getFieldValue(['groups', groupName, 'schedule', 'module_standup_enabled']);
                        return (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderBottom: isExpanded ? '1px solid #91caff' : 'none' }}>
                              <strong style={{ color: '#333' }}>站会收集模块</strong>
                              <Form.Item {...restGroupField} name={[groupName, 'schedule', 'module_standup_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                <Switch onChange={(checked) => {
                                  if (!checked) {
                                    form.setFields([
                                      { name: ['groups', groupName, 'schedule', 'standup_push_enabled'], value: false },
                                      { name: ['groups', groupName, 'schedule', 'standup_second_remind_enabled'], value: false },
                                      { name: ['groups', groupName, 'schedule', 'standup_summary_enabled'], value: false },
                                      { name: ['groups', groupName, 'schedule', 'public_missing_standups'], value: false },
                                      { name: ['groups', groupName, 'schedule', 'task_standup_enabled'], value: false },
                                    ]);
                                  }
                                }} />
                              </Form.Item>
                            </div>
                            {isExpanded && (
                              <div style={{ padding: '16px', background: '#fff' }}>
                                <Alert
                                  type="info"
                                  showIcon
                                  message="固定模板站会与任务型站会可以单独开启，也可以同时使用"
                                  description="普通站会和任务型站会分别使用自己的开关与时间；任务型站会在群里发送登记模板，成员引用模板并再次 @机器人回复事项，机器人到具体交付时间在原群 @负责人。负责人需在下班前引用提醒回复，否则日报会标记为未完成（未汇报）。明确要求创建 TAPD 时仍走原任务流程。"
                                  style={{ marginBottom: 16 }}
                                />
                                <Row gutter={[16, 16]}>
                                  <Col span={24}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#f0f5ff', borderRadius: 6, border: '1px solid #adc6ff' }}>
                                      <div>
                                        <div style={{ fontWeight: 600 }}>任务型站会</div>
                                        <Typography.Text type="secondary">开启后按左侧时间独立发送群模板；负责人未引用回复会在日报中记为未完成。</Typography.Text>
                                      </div>
                                      <Space size="middle">
                                        <span style={{ color: '#666', fontSize: 13 }}>模板发送时间</span>
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'task_standup_template']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择时间' }]}>
                                          <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                                        </Form.Item>
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'task_standup_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                          <Switch />
                                        </Form.Item>
                                      </Space>
                                    </div>
                                  </Col>
                                  {[
                                    { id: 'standup_push', name: '站会首次提醒（含任务模板）' },
                                    { id: 'standup_second_remind', name: '站会再次提醒' },
                                    { id: 'standup_summary', name: '生成站会汇总' }
                                  ].map(job => (
                                    <Col span={12} key={job.id}>
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                                        <span style={{ fontWeight: 500 }}>{job.name}</span>
                                        <Space size="middle">
                                          <Form.Item {...restGroupField} name={[groupName, 'schedule', job.id]} style={{ margin: 0 }} rules={[{ required: true, message: '请选择时间' }]}>
                                            <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                                          </Form.Item>
                                          <Form.Item {...restGroupField} name={[groupName, 'schedule', `${job.id}_enabled`]} valuePropName="checked" style={{ margin: 0 }}>
                                            <Switch />
                                          </Form.Item>
                                        </Space>
                                      </div>
                                    </Col>
                                  ))}
                                  <Col span={12}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                                      <span style={{ fontWeight: 500 }}>公开未交站会名单(会@人)</span>
                                      <Form.Item {...restGroupField} name={[groupName, 'schedule', 'public_missing_standups']} valuePropName="checked" style={{ margin: 0 }}>
                                        <Switch />
                                      </Form.Item>
                                    </div>
                                  </Col>
                                </Row>
                              </div>
                            )}
                          </>
                        );
                      }}
                    </Form.Item>
                  </div>

                  {/* 群聊日报模块 */}
                  <div style={{ border: '1px solid #91caff', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
                    <Form.Item noStyle dependencies={[
                      ['groups', groupName, 'schedule', 'module_daily_summary_enabled'],
                      ['groups', groupName, 'schedule', 'daily_summary_enabled'],
                      ['groups', groupName, 'schedule', 'daily_summary'],
                    ]}>
                      {() => {
                        const isExpanded = form.getFieldValue(['groups', groupName, 'schedule', 'module_daily_summary_enabled']);
                        const isDailySummaryEnabled = form.getFieldValue(['groups', groupName, 'schedule', 'daily_summary_enabled']);
                        const dailySummaryTime = form.getFieldValue(['groups', groupName, 'schedule', 'daily_summary']);
                        const dailySummaryTimeText = dailySummaryTime?.format ? dailySummaryTime.format('HH:mm') : dailySummaryTime;
                        return (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderBottom: isExpanded ? '1px solid #91caff' : 'none' }}>
                              <strong style={{ color: '#333' }}>群聊日报模块</strong>
                              <Form.Item {...restGroupField} name={[groupName, 'schedule', 'module_daily_summary_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                <Switch onChange={(checked) => {
                                  if (!checked) {
                                    form.setFields([
                                      { name: ['groups', groupName, 'schedule', 'daily_summary_enabled'], value: false },
                                    ]);
                                  }
                                }} />
                              </Form.Item>
                            </div>
                            {isExpanded && (
                              <div style={{ padding: '16px', background: '#fff' }}>
                                <Alert
                                  type={isDailySummaryEnabled ? 'success' : 'warning'}
                                  showIcon
                                  message={isDailySummaryEnabled
                                    ? `日报已启用，将在每日 ${dailySummaryTimeText || '未设置时间'} 触发`
                                    : '日报模块已打开，但“群聊日报归纳”任务仍未启用'}
                                  description={isDailySummaryEnabled
                                    ? '点击“保存当前配置”后，后端会在 30 秒内读取新配置。'
                                    : '请同时打开下方任务开关；只打开模块不会触发日报。'}
                                  style={{ marginBottom: 16 }}
                                />
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                                      <span style={{ fontWeight: 500 }}>群聊日报归纳</span>
                                      <Space size="middle">
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'daily_summary']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择时间' }]}>
                                          <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                                        </Form.Item>
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'daily_summary_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                          <Switch />
                                        </Form.Item>
                                      </Space>
                                    </div>
                                  </Col>
                                </Row>
                              </div>
                            )}
                          </>
                        );
                      }}
                    </Form.Item>
                  </div>

                  {/* 项目周报模块 */}
                  <div style={{ border: '1px solid #91caff', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
                    <Form.Item noStyle dependencies={[
                      ['groups', groupName, 'schedule', 'module_weekly_report_enabled'],
                      ['groups', groupName, 'schedule', 'weekly_report_enabled'],
                      ['groups', groupName, 'schedule', 'weekly_report'],
                    ]}>
                      {() => {
                        const isExpanded = form.getFieldValue(['groups', groupName, 'schedule', 'module_weekly_report_enabled']);
                        const isEnabled = form.getFieldValue(['groups', groupName, 'schedule', 'weekly_report_enabled']);
                        const reportTime = form.getFieldValue(['groups', groupName, 'schedule', 'weekly_report']);
                        const reportTimeText = reportTime?.format ? reportTime.format('HH:mm') : reportTime;
                        return (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderBottom: isExpanded ? '1px solid #91caff' : 'none' }}>
                              <strong style={{ color: '#333' }}>项目周报模块</strong>
                              <Form.Item {...restGroupField} name={[groupName, 'schedule', 'module_weekly_report_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                <Switch onChange={(checked) => {
                                  if (!checked) {
                                    form.setFields([{ name: ['groups', groupName, 'schedule', 'weekly_report_enabled'], value: false }]);
                                  }
                                }} />
                              </Form.Item>
                            </div>
                            {isExpanded && (
                              <div style={{ padding: '16px', background: '#fff' }}>
                                <Alert
                                  type={isEnabled ? 'success' : 'warning'}
                                  showIcon
                                  message={isEnabled
                                    ? `周报已启用，将在每周五 ${reportTimeText || '未设置时间'} 生成`
                                    : '周报模块已打开，但自动生成任务仍未启用'}
                                  description="用户也可以在群里 @机器人说“生成本周周报”或“生成上周周报”。周报会先同步 TAPD，再发送可视化 HTML 链接。"
                                  style={{ marginBottom: 16 }}
                                />
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                                      <span style={{ fontWeight: 500 }}>周五生成时间</span>
                                      <Space size="middle">
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'weekly_report']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择时间' }]}>
                                          <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                                        </Form.Item>
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'weekly_report_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                          <Switch />
                                        </Form.Item>
                                      </Space>
                                    </div>
                                  </Col>
                                </Row>
                              </div>
                            )}
                          </>
                        );
                      }}
                    </Form.Item>
                  </div>

                  {/* 看板生成模块 */}
                  <div style={{ border: '1px solid #91caff', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
                    <Form.Item noStyle dependencies={[['groups', groupName, 'schedule', 'module_dashboard_enabled']]}>
                      {() => {
                        const isExpanded = form.getFieldValue(['groups', groupName, 'schedule', 'module_dashboard_enabled']);
                        return (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderBottom: isExpanded ? '1px solid #91caff' : 'none' }}>
                              <strong style={{ color: '#333' }}>数据看板模块</strong>
                              <Form.Item {...restGroupField} name={[groupName, 'schedule', 'module_dashboard_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                <Switch onChange={(checked) => {
                                  if (!checked) {
                                    form.setFields([
                                      { name: ['groups', groupName, 'schedule', 'dashboard_enabled'], value: false },
                                    ]);
                                  }
                                }} />
                              </Form.Item>
                            </div>
                            {isExpanded && (
                              <div style={{ padding: '16px', background: '#fff' }}>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                                      <span style={{ fontWeight: 500 }}>看板生成与上传</span>
                                      <Space size="middle">
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'dashboard']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择时间' }]}>
                                          <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                                        </Form.Item>
                                        <Form.Item {...restGroupField} name={[groupName, 'schedule', 'dashboard_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                          <Switch />
                                        </Form.Item>
                                      </Space>
                                    </div>
                                  </Col>
                                </Row>
                              </div>
                            )}
                          </>
                        );
                      }}
                    </Form.Item>
                  </div>

                  {/* 其他基础配置 (默认展开且无总开关) */}
                  <div style={{ border: '1px solid #91caff', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderBottom: '1px solid #91caff' }}>
                      <strong style={{ color: '#333' }}>其他基础配置</strong>
                    </div>
                    <div style={{ padding: '16px', background: '#fff' }}>
                      <Row gutter={[16, 16]}>
                        <Col span={24}>
                          <div style={{ padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                              <span style={{ fontWeight: 500 }}>超期任务扫描</span>
                              <Form.Item {...restGroupField} name={[groupName, 'schedule', 'overdue_scan_enabled']} valuePropName="checked" style={{ margin: 0 }}>
                                <Switch />
                              </Form.Item>
                            </div>
                            <Space wrap align="start">
                              <Form.Item label="开始" {...restGroupField} name={[groupName, 'schedule', 'overdue_scan']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择开始时间' }]}>
                                <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                              </Form.Item>
                              <Form.Item label="结束" {...restGroupField} name={[groupName, 'schedule', 'overdue_scan_end']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择结束时间' }]}>
                                <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                              </Form.Item>
                              <Form.Item label="扫描间隔（分钟）" {...restGroupField} name={[groupName, 'schedule', 'overdue_scan_interval_minutes']} style={{ margin: 0 }} rules={[{ required: true, message: '请输入扫描间隔' }]}>
                                <InputNumber min={1} max={60} precision={0} style={{ width: 130 }} />
                              </Form.Item>
                              <Form.Item label="时区" {...restGroupField} name={[groupName, 'schedule', 'overdue_scan_timezone']} style={{ margin: 0 }} rules={[{ required: true, message: '请选择时区' }]}>
                                <Select style={{ width: 150 }} options={[{ value: 'Asia/Shanghai', label: '北京时间' }]} />
                              </Form.Item>
                            </Space>
                            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
                              默认工作日 09:00–18:30 每 30 分钟扫描；10:00 催明日/今日截止和超期 1–2 天，10:00、16:00 催超期 3–4 天，超期 5 天以上 09:00–18:00 每小时催一次。
                            </Typography.Text>
                          </div>
                        </Col>
                        <Col span={12}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                            <span style={{ fontWeight: 500 }}>公开超期负责人(在面板高亮)</span>
                            <Form.Item {...restGroupField} name={[groupName, 'schedule', 'public_overdue_owners']} valuePropName="checked" style={{ margin: 0 }}>
                              <Switch />
                            </Form.Item>
                          </div>
                        </Col>
                      </Row>
                    </div>
                  </div>
                </div>

                      </Modal>
                    );
                  }}
                  </Form.Item>
                    </>
                  )
                },
                {
                  title: '操作',
                  key: 'action',
                  align: 'center',
                  width: 250,
                  render: (_, { key: groupKey, name: groupName }) => (
                    <Space>
                      <Button type="link" onClick={() => setEditingGroupKey(groupKey)}>高级配置</Button>
                      <Popconfirm title="确定要删除这个群组吗？" okText="确定" cancelText="取消" onConfirm={() => removeGroup(groupName)}>
                        <Button type="link" danger>删除</Button>
                      </Popconfirm>
                    </Space>
                  )
                }
              ]}
            />
          </div>
        )}
      </Form.List>
    </Card>
  );
};
