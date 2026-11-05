import { useState } from 'react';
import useSWR from 'swr';
import { Alert, App as AntdApp, Button, Empty, Space, Table, Tag } from 'antd';
import { EyeOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import type { TableColumnsType } from 'antd';
import { api } from '@/api';

type Summary = { id: string; created_at: string; group_name: string; theme: string; summary_file: string; timeline_file: string; email_sent: boolean };
type Archive = { summaries: Summary[]; total: number; email: { ready: boolean; recipients: string[] } };

export default function MeetingSummariesPage() {
  const { modal, message } = AntdApp.useApp();
  const [params] = useSearchParams();
  const [page, setPage] = useState(1), [sending, setSending] = useState<string>();
  const groupId = params.get('groupId') || undefined;
  const { data, error, isLoading, isValidating, mutate } = useSWR<Archive>(['meeting-summary-archive', groupId, page], () => api.fetchMeetingSummaries(groupId, (page - 1) * 15, 15));
  const sendEmail = (record: Summary) => modal.confirm({
    title: '发送会议纪要', content: `将“${record.theme || '未命名会议'}”的归档附件发送到：${data?.email.recipients.join('、') || '未配置收件人'}。`, okText: '确认发送', cancelText: '取消',
    onOk: async () => {
      setSending(record.id);
      try {
        const result = await api.sendMeetingSummaryEmail(record.id);
        message.success(result.alreadySent ? '这份纪要已有发送标记' : '已提交邮件服务');
        await mutate();
      } catch (reason) { message.error(reason instanceof Error ? reason.message : '邮件操作失败'); }
      finally { setSending(undefined); }
    },
  });
  const view = (filename: string, label: string) => filename ? <Button type="link" icon={<EyeOutlined aria-hidden />} href={api.getMeetingSummaryFileUrl(filename)} target="_blank" rel="noopener noreferrer">{label}</Button> : <span className="muted">暂无附件</span>;
  const columns: TableColumnsType<Summary> = [
    { title: '主题', dataIndex: 'theme', render: value => value || '未命名会议', width: 200 },
    { title: '团队', dataIndex: 'group_name', width: 160 },
    { title: '归档时间', dataIndex: 'created_at', render: value => new Date(value).toLocaleString(), width: 190 },
    { title: '归档附件', key: 'files', render: (_, record) => <Space wrap>{view(record.summary_file, '会议总结')}{view(record.timeline_file, '时间线')}</Space>, width: 260 },
    { title: '邮件', key: 'email', render: (_, record) => record.email_sent ? <Tag>已标记发送</Tag> : <Button icon={<SendOutlined aria-hidden />} loading={sending === record.id} disabled={!data?.email.ready || !!sending} onClick={() => sendEmail(record)}>发送邮件</Button>, width: 150 },
  ];
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>会议纪要归档</h1><p>查看历史纪要及附件。会议自动生成暂未开放。</p></div><Button icon={<ReloadOutlined aria-hidden />} loading={isValidating} onClick={() => mutate()}>刷新</Button></div>
    {error && <Alert type="error" title="纪要加载失败" description={error.message} action={<Button onClick={() => mutate()}>重试</Button>} />}
    {data && !data.email.ready && <Alert type="info" title="邮件发送不可用" description="发件邮箱或收件人未配置，或当前使用模拟模式。" />}
    <div className="runs-section"><Table<Summary> columns={columns} dataSource={data?.summaries || []} rowKey="id" loading={isLoading} scroll={{ x: 960 }} pagination={{ current: page, pageSize: 15, total: data?.total || 0, showSizeChanger: false, onChange: setPage }} locale={{ emptyText: <Empty description="暂无归档纪要" /> }} /></div>
  </div>;
}
