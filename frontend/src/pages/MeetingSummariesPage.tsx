import React, { useEffect, useState } from 'react';
import { Table, Button, Card, Typography, Space, Tag, message, Modal } from 'antd';
import { LinkOutlined, FileTextOutlined, CalendarOutlined, CheckCircleOutlined, SendOutlined, EyeOutlined } from '@ant-design/icons';
import { api } from '@/api';
import type { TableColumnsType } from 'antd';

const { Title, Text } = Typography;

const MeetingSummariesPage: React.FC = () => {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const fetchSummaries = async () => {
    setLoading(true);
    try {
      const summaries = await api.fetchMeetingSummaries();
      setData(summaries);
    } catch (e: any) {
      message.error("获取会议纪要列表失败: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummaries();
  }, []);

  const handleView = (filepath: string) => {
    const url = api.getMeetingSummaryFileUrl(filepath);
    window.open(url, '_blank');
  };

  const handleSendEmail = (id: string) => {
    Modal.confirm({
      title: '确认发送',
      content: '确定要将此会议纪要发送到邮箱吗？',
      onOk: async () => {
        setSendingId(id);
        try {
          await api.sendMeetingSummaryEmail(id);
          message.success("发送成功！");
          fetchSummaries(); // Refresh the list to update status
        } catch (e: any) {
          message.error("发送失败: " + e.message);
        } finally {
          setSendingId(null);
        }
      }
    });
  };

  const columns: TableColumnsType<any> = [
    {
      title: '生成时间',
      dataIndex: 'created_at',
      key: 'created_at',
      align: 'center',
      render: (text: string) => (
        <Space>
          <CalendarOutlined style={{ color: '#8c8c8c' }} />
          <span>{new Date(text).toLocaleString()}</span>
        </Space>
      ),
      width: 200,
    },
    {
      title: '所属群聊',
      dataIndex: 'group_name',
      key: 'group_name',
      align: 'center',
      render: (text: string) => <Text strong>{text || '未知群聊'}</Text>,
    },
    {
      title: '邮件分发',
      dataIndex: 'email_sent',
      key: 'email_sent',
      align: 'center',
      render: (sent: boolean, record: any) => (
        sent
          ? <Tag icon={<CheckCircleOutlined />} color="success">已发送</Tag>
          : <Button
              size="small"
              type="primary"
              ghost
              icon={<SendOutlined />}
              loading={sendingId === record.id}
              onClick={() => handleSendEmail(record.id)}
            >
              发送邮件
            </Button>
      ),
      width: 120,
    },
    {
      title: '会议主题',
      dataIndex: 'theme',
      key: 'theme',
      render: (theme: string) => theme ? <Text strong>{theme}</Text> : <Text type="secondary">无主题</Text>,
    },
    {
      title: '会议总结',
      dataIndex: 'summary_file',
      key: 'summary_file',
      align: 'center',
      render: (filename: string) => filename ? (
        <Button type="link" icon={<EyeOutlined />} onClick={() => handleView(filename)}>
          查看会议总结
        </Button>
      ) : (
        <Text type="secondary">无</Text>
      ),
    },
    {
      title: '时间线与洞察',
      dataIndex: 'timeline_file',
      key: 'timeline_file',
      align: 'center',
      render: (filename: string) => filename ? (
        <Button type="link" icon={<EyeOutlined />} onClick={() => handleView(filename)}>
          查看时间线
        </Button>
      ) : (
        <Text type="secondary">无</Text>
      ),
    },
  ];

  return (
    <div style={{ padding: "24px", flex: 1, overflow: "auto", backgroundColor: "#f5f5f5" }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <Space align="center" style={{ marginBottom: 8 }}>
            <FileTextOutlined style={{ fontSize: '24px', color: '#1890ff' }} />
            <Title level={3} style={{ margin: 0 }}>会议纪要</Title>
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block' }}>自动归档和管理来自群聊的各类会议纪要与总结报告</Typography.Text>
        </div>
        <Button type="primary" onClick={fetchSummaries} loading={loading}>
          刷新列表
        </Button>
      </div>

      <Card bordered={false} style={{ borderRadius: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 15 }}
        />
      </Card>
      </div>
    </div>
  );
};

export default MeetingSummariesPage;
