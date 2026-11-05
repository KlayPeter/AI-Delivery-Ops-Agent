import React, { useState, useEffect } from 'react';
import { Typography, Card, Table, Tag, DatePicker, Row, Col, Button, Modal, Spin, message, Select, Space } from 'antd';
import { EyeOutlined, CheckCircleOutlined, ClockCircleOutlined, StopOutlined, WarningOutlined, QuestionCircleOutlined, CloseOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import ReactMarkdown from 'react-markdown';
import { api } from '@/api';

const { Title, Text } = Typography;

export default function StandupsPage() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [selectedDate, setSelectedDate] = useState<any>(dayjs());
  const [category, setCategory] = useState<'normal' | 'task'>('normal');
  const [filterStatus, setFilterStatus] = useState('all');
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedStandup, setSelectedStandup] = useState<any>(null);
  const [remindLoading, setRemindLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryModalVisible, setSummaryModalVisible] = useState(false);
  const [standupSummary, setStandupSummary] = useState('');

  const [groups, setGroups] = useState<any[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');

  const fetchStandups = async (dateStr: string, groupId: string, type: 'normal' | 'task') => {
    if (!groupId) return; // Wait for group to be selected
    setLoading(true);
    try {
      const json = await api.fetchStandups(dateStr, groupId, type);
      setData(json);
    } catch (err: any) {
      console.error(err);
      message.error(err.message || "获取站会数据失败");
    } finally {
      setLoading(false);
    }
  };

  const handleRemind = async () => {
    if (!selectedGroup || category !== 'normal') return;
    setRemindLoading(true);
    try {
      await api.triggerJob("standup-remind", selectedGroup, false);
      message.success("已成功触发未交提醒！");
    } catch (err: any) {
      console.error(err);
      message.error(err.message || "触发提醒失败");
    } finally {
      setRemindLoading(false);
    }
  };

  const handleViewSummary = async () => {
    if (!selectedGroup) return;
    setSummaryLoading(true);
    try {
      const summary = await api.fetchStandupSummary(selectedDate.format('YYYY-MM-DD'), selectedGroup);
      if (summary) {
        setStandupSummary(summary);
        setSummaryModalVisible(true);
      } else {
        message.info("暂未生成当天的站会汇总");
      }
    } catch (err: any) {
      message.error(err.message || "获取汇总失败");
    } finally {
      setSummaryLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const config = await api.fetchConfig();
        const configGroups = (config.groups || []).filter((g: any) =>
          g.schedule?.module_standup_enabled !== false
          && (g.schedule?.standup_push_enabled !== false || g.schedule?.task_standup_enabled === true)
        );
        setGroups(configGroups);
        if (configGroups.length > 0) {
          setSelectedGroup(configGroups[0].chat_id);
        } else {
          setData(null);
        }
      } catch (e) {
        console.error("Failed to fetch config", e);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (selectedGroup) {
      fetchStandups(selectedDate.format('YYYY-MM-DD'), selectedGroup, category);
    }
  }, [selectedDate, selectedGroup, category]);

  const columns: TableColumnsType<any> = [
    {
      title: '成员名称',
      dataIndex: 'name',
      key: 'name',
      align: 'center',
    },
    {
      title: '提交状态',
      key: 'submitted',
      align: 'center',
      render: (_: any, record: any) => (
        <Tag color={record.submitted ? 'success' : 'error'}>
          {record.submitted ? '已提交' : '未提交'}
        </Tag>
      ),
    },
    {
      title: '提交时间',
      key: 'time',
      align: 'center',
      render: (_: any, record: any) => {
        if (!record.submitted || !record.standup_content) return '-';
        const dateStr = record.standup_content.submitted_at;
        return dateStr ? new Date(dateStr).toLocaleTimeString() : '-';
      }
    },
    {
      title: '操作',
      key: 'action',
      align: 'center',
      render: (_: any, record: any) => (
        record.submitted ? (
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => {
              setSelectedStandup(record.standup_content);
              setModalVisible(true);
            }}
          >
            查看详情
          </Button>
        ) : null
      ),
    },
  ];

  const taskColumns: TableColumnsType<any> = [
    {
      title: '任务',
      dataIndex: 'title',
      key: 'title',
    },
    {
      title: '负责人',
      dataIndex: 'owner_name',
      key: 'owner_name',
      align: 'center',
    },
    {
      title: '交付时间',
      dataIndex: 'due_at',
      key: 'due_at',
      align: 'center',
      render: (value: string | null) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      align: 'center',
      render: (value: string, record: any) => (
        <Tag color={value === 'completed' ? 'success' : record.reported ? 'processing' : 'error'}>
          {record.status_label}
        </Tag>
      ),
    },
    {
      title: '最新回复',
      dataIndex: 'content',
      key: 'content',
      render: (value: string) => value || <Text type="secondary">暂无回复</Text>,
    },
  ];

  return (
    <div style={{ padding: "24px", flex: 1, overflow: "auto", backgroundColor: "#f5f5f5" }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0, marginBottom: 8 }}>站会统计</Title>
          <Typography.Text type="secondary" style={{ display: 'block' }}>查看和管理团队每日站会提交情况与工作内容记录</Typography.Text>
        </div>
        <Space>
          <Select
            value={selectedGroup}
            onChange={setSelectedGroup}
            style={{ width: 180 }}
            placeholder="请选择所属群组"
            options={groups.map((g: any) => ({ label: g.name || g.chat_id, value: g.chat_id }))}
          />
          <Select
            value={category}
            onChange={(value: 'normal' | 'task') => { setCategory(value); setFilterStatus('all'); }}
            style={{ width: 140 }}
            options={[{ label: '普通站会', value: 'normal' }, { label: '任务型站会', value: 'task' }]}
          />
          <Select value={filterStatus} onChange={setFilterStatus} style={{ width: 120 }}>
            <Select.Option value="all">全部状态</Select.Option>
            {category === 'normal' ? <>
              <Select.Option value="submitted">已提交</Select.Option>
              <Select.Option value="missing">未提交</Select.Option>
            </> : <>
              <Select.Option value="reported">已回复</Select.Option>
              <Select.Option value="unreported">未回复</Select.Option>
            </>}
          </Select>
          <DatePicker
            value={selectedDate}
            onChange={(val: any) => val && setSelectedDate(val)}
            allowClear={false}
          />
          <Button onClick={handleViewSummary} loading={summaryLoading} disabled={category === 'task'}>查看站会汇总</Button>
          <Button type="primary" onClick={handleRemind} loading={remindLoading} disabled={category === 'task'}>一键提醒未交</Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        {data && (
          <>
            {category === 'normal' ? <>
              <Row gutter={16} style={{ marginBottom: 24 }}>
                <Col span={8}>
                  <Card>
                    <div style={{ color: '#8c8c8c' }}>团队总人数</div>
                    <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{data.stats.total}</div>
                  </Card>
                </Col>
                <Col span={8}>
                  <Card>
                    <div style={{ color: '#8c8c8c' }}>已提交</div>
                    <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#52c41a' }}>{data.stats.submitted}</div>
                  </Card>
                </Col>
                <Col span={8}>
                  <Card>
                    <div style={{ color: '#8c8c8c' }}>未提交</div>
                    <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#f5222d' }}>{data.stats.missing}</div>
                  </Card>
                </Col>
              </Row>

              <Table
                dataSource={data.members.filter((m: any) =>
                  filterStatus === 'all' ? true :
                  filterStatus === 'submitted' ? m.submitted : !m.submitted
                )}
                columns={columns}
                rowKey="open_id"
                pagination={false}
              />
            </> : <>
              <Row gutter={16} style={{ marginBottom: 24 }}>
                <Col span={6}><Card><div style={{ color: '#8c8c8c' }}>任务总数</div><div style={{ fontSize: '24px', fontWeight: 'bold' }}>{data.stats.total}</div></Card></Col>
                <Col span={6}><Card><div style={{ color: '#8c8c8c' }}>已回复</div><div style={{ fontSize: '24px', fontWeight: 'bold', color: '#52c41a' }}>{data.stats.reported}</div></Card></Col>
                <Col span={6}><Card><div style={{ color: '#8c8c8c' }}>未回复</div><div style={{ fontSize: '24px', fontWeight: 'bold', color: '#f5222d' }}>{data.stats.unreported}</div></Card></Col>
                <Col span={6}><Card><div style={{ color: '#8c8c8c' }}>已完成</div><div style={{ fontSize: '24px', fontWeight: 'bold', color: '#1677ff' }}>{data.stats.completed}</div></Card></Col>
              </Row>
              <Table
                dataSource={(data.tasks || []).filter((task: any) =>
                  filterStatus === 'all' ? true : filterStatus === 'reported' ? task.reported : !task.reported
                )}
                columns={taskColumns}
                rowKey="id"
                pagination={false}
              />
            </>}
          </>
        )}
      </Spin>

      <Modal
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, borderBottom: '1px solid #f0f0f0', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 4, height: 18, background: '#1677ff', borderRadius: 2 }}></div>
              <span style={{ fontSize: 18, fontWeight: 600 }}>站会详情 - {selectedStandup?.user_name || ''}</span>
            </div>
            <Button type="text" icon={<CloseOutlined />} onClick={() => setModalVisible(false)} />
          </div>
        }
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={650}
        closeIcon={false}
        styles={{ header: { marginBottom: 0 }, body: { padding: '8px 0' } }}
      >
        {selectedStandup && (
          <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '16px', background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 16 }}><CheckCircleOutlined style={{color: '#1677ff'}}/></span>
              <span style={{ fontWeight: 600, color: '#262626' }}>原始站会记录</span>
            </div>
            <div style={{ whiteSpace: 'pre-wrap', color: '#595959', lineHeight: 1.6, paddingLeft: 24 }}>
              {selectedStandup.raw_text || '暂无内容'}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        title="站会汇总"
        open={summaryModalVisible}
        onCancel={() => setSummaryModalVisible(false)}
        footer={null}
        width={800}
      >
        <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: '8px' }}>
          <ReactMarkdown>{standupSummary}</ReactMarkdown>
        </div>
      </Modal>
      </div>
    </div>
  );
}

const StandupSection = ({ icon, title, items }: any) => (
  <div style={{ background: '#fafafa', borderRadius: 8, padding: '16px', border: '1px solid #f0f0f0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontWeight: 600, color: '#262626' }}>{title}</span>
    </div>
    {items?.length > 0 ? (
      <ul style={{ margin: 0, paddingLeft: 24, color: '#595959', lineHeight: 1.6 }}>
        {items.map((item: any, i: number) => <li key={i}>{item}</li>)}
      </ul>
    ) : (
      <Text type="secondary" style={{ paddingLeft: 24 }}>无</Text>
    )}
  </div>
);
