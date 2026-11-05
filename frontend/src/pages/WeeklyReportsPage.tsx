import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Drawer, Empty, Menu, Select, Skeleton, Tag } from 'antd';
import { ExportOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '@/api';

type WeeklyReportSummary = {
  id: string; group_id: string; group_name: string; period_start: string; period_end: string;
  version: number; generated_at: string;
};

export default function WeeklyReportsPage() {
  const { data: reports = [], error, isLoading, isValidating, mutate } = useSWR<WeeklyReportSummary[]>('weekly-report-history', () => api.fetchWeeklyReports());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const groupId = params.get('groupId') || 'all', requested = params.get('reportId');
  const groups = [...new Map(reports.map(report => [report.group_id, report.group_name])).entries()].map(([value, label]) => ({ value, label }));
  const filtered = reports.filter(report => groupId === 'all' || report.group_id === groupId);
  const selected = requested ? filtered.find(report => report.id === requested) : filtered[0];
  const selectReport = (reportId: string | null, group = groupId) => {
    const next = new URLSearchParams(params);
    if (reportId) next.set('reportId', reportId); else next.delete('reportId');
    if (group === 'all') next.delete('groupId'); else next.set('groupId', group);
    setParams(next, { replace: true });
  };
  return <div className="workspace-page artifact-page">
    <div className="page-heading"><div><h1>周报</h1><p>查看团队每周的交付记录，保留每次生成的历史版本。</p></div>
      <div className="section-actions"><Button icon={<ReloadOutlined aria-hidden />} loading={isValidating} onClick={() => mutate()}>刷新</Button><Button icon={<HistoryOutlined aria-hidden />} onClick={() => setHistoryOpen(true)}>历史记录</Button>{selected && <Button icon={<ExportOutlined aria-hidden />} href={api.getWeeklyReportUrl(selected.id)} target="_blank" rel="noopener noreferrer">新窗口打开</Button>}</div>
    </div>
    {error ? <Alert type="error" title="周报加载失败" description={error.message} action={<Button onClick={() => mutate()}>重试</Button>} />
      : isLoading ? <Skeleton active />
      : selected ? <><div className="run-meta"><strong>{selected.group_name}</strong><span className="muted">{selected.period_start} 至 {selected.period_end}</span><Tag>v{selected.version}</Tag><span className="muted">{dayjs(selected.generated_at).format('YYYY-MM-DD HH:mm')} 生成</span></div><div className="artifact-frame"><iframe src={api.getWeeklyReportUrl(selected.id)} title={`${selected.group_name}周报 ${selected.period_start}`} sandbox="allow-scripts allow-popups" /></div></>
      : <div className="artifact-empty"><Empty description={<><strong>{requested ? '未找到这份周报' : '暂无周报'}</strong><p>{requested ? '报告可能已被移走，可以从历史记录选择其他版本。' : '生成周报后，团队的交付记录和历史版本会出现在这里。'}</p></>}><Link className="primary-link" to="/agents">查看可用 Agent</Link></Empty></div>}
    <Drawer title="周报历史" size={340} open={historyOpen} onClose={() => setHistoryOpen(false)}>
      <div className="history-filters"><label htmlFor="weekly-group">团队</label><Select id="weekly-group" value={groupId} options={[{ value: 'all', label: '全部团队' }, ...groups]} onChange={value => selectReport(null, value)} /></div>
      <Menu aria-label="历史周报" mode="inline" selectedKeys={selected ? [selected.id] : []} items={filtered.map(report => ({ key: report.id, label: `${report.group_name} · ${report.period_start} · v${report.version}` }))} onClick={({ key }) => { selectReport(key); setHistoryOpen(false); }} />
      {!filtered.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前团队没有周报" />}
    </Drawer>
  </div>;
}
