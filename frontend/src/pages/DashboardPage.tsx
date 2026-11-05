import useSWR from 'swr';
import { useState } from 'react';
import { Alert, Button, DatePicker, Drawer, Empty, Menu, Select, Skeleton } from 'antd';
import { HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/api';
import { dashboardFilenameFromPath, dashboardMatchesGroup, parseDashboardFilename, sortDashboardFiles } from '@/dashboardFiles';

export default function DashboardPage() {
  const { data, error, isLoading, isValidating, mutate } = useSWR('dashboard-history', async () => {
    const [files, config] = await Promise.all([api.fetchDashboards(), api.fetchConfig()]);
    return { files: sortDashboardFiles(files), groups: config.groups || [] };
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const files = data?.files || [], groups = data?.groups || [];
  const filename = dashboardFilenameFromPath(pathname), dashboardId = params.get('dashboardId');
  const requested = filename ? files.find(file => file === filename) : dashboardId ? files.find(file => file.includes(dashboardId)) : undefined;
  const groupId = params.get('groupId') || 'all';
  const group = groups.find((item: any) => item.chat_id === groupId);
  const month = params.get('month') ?? (requested ? parseDashboardFilename(requested).date.slice(0, 7) : dayjs().format('YYYY-MM'));
  const filtered = files.filter(file => (groupId === 'all' || !!group && dashboardMatchesGroup(file, group)) && (!month || parseDashboardFilename(file).date.startsWith(month)));
  const selected = filename || dashboardId ? requested : filtered[0];
  const updateFilters = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.delete('dashboardId');
    for (const [key, value] of Object.entries(values)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    navigate({ pathname: '/dashboard', search: next.toString() }, { replace: true });
  };

  return <div className="workspace-page artifact-page">
    <div className="page-heading"><div><h1>项目看板</h1><p>查看已保存的项目快照，按团队和月份筛选。</p></div>
      <div className="section-actions"><Button icon={<ReloadOutlined aria-hidden />} loading={isValidating} onClick={() => mutate()}>刷新</Button><Button icon={<HistoryOutlined aria-hidden />} onClick={() => setHistoryOpen(true)}>历史记录</Button></div>
    </div>
    {error ? <Alert type="error" showIcon title="看板加载失败" description={error.message} action={<Button onClick={() => mutate()}>重试</Button>} />
      : isLoading ? <Skeleton active />
      : selected ? <div className="artifact-frame"><iframe src={api.getDashboardUrl(selected)} title={`项目快照 ${parseDashboardFilename(selected).date || selected}`} sandbox="allow-scripts allow-popups" /></div>
      : <div className="artifact-empty"><Empty description={<><strong>{filename || dashboardId ? '未找到这份快照' : '暂无项目快照'}</strong><p>{filename || dashboardId ? '快照可能已被移走，可以从历史记录选择其他版本。' : '运行项目看板任务后，快照会保存在这里。也可以调整历史记录中的筛选条件。'}</p></>}><Link className="primary-link" to="/debug">打开业务任务</Link></Empty></div>}
    <Drawer title="历史快照" size={340} open={historyOpen} onClose={() => setHistoryOpen(false)}>
      <div className="history-filters">
        <label htmlFor="dashboard-group">团队</label><Select id="dashboard-group" value={groupId} onChange={value => updateFilters({ groupId: value === 'all' ? null : value })} options={[{ label: '全部团队', value: 'all' }, ...groups.map((item: any) => ({ label: item.name || item.chat_id, value: item.chat_id }))]} />
        <label htmlFor="dashboard-month">月份</label><DatePicker id="dashboard-month" picker="month" value={month && dayjs(month).isValid() ? dayjs(month) : null} onChange={value => updateFilters({ month: value ? value.format('YYYY-MM') : '' })} allowClear />
      </div>
      <Menu aria-label="历史快照" mode="inline" selectedKeys={selected ? [selected] : []} onClick={({ key }) => { updateFilters({ dashboardId: key }); setHistoryOpen(false); }} items={filtered.map(file => {
        const meta = parseDashboardFilename(file), owner = groups.find((item: any) => dashboardMatchesGroup(file, item));
        return { key: file, label: [owner?.name, meta.date || file, meta.time].filter(Boolean).join(' ') };
      })} />
      {!filtered.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选没有快照" />}
    </Drawer>
  </div>;
}
