import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Alert, Empty, Drawer, Select, DatePicker, Typography, Button } from 'antd';
import { MenuOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/api';
import { dashboardMatchesGroup, parseDashboardFilename, sortDashboardFiles } from '@/dashboardFiles';

const { Content } = Layout;

const DashboardPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dashboards, setDashboards] = useState<string[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [selectedMonth, setSelectedMonth] = useState(dayjs().format('YYYY-MM'));
  const [selectedDashboard, setSelectedDashboard] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [drawerVisible, setDrawerVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const [dashboardsData, configData] = await Promise.all([
          api.fetchDashboards(),
          api.fetchConfig().catch(() => ({ groups: [] }))
        ]);
        if (cancelled) return;
        const sortedDashboards = sortDashboardFiles(dashboardsData);
        const configuredGroups = configData.groups || [];
        const requestedGroupId = new URLSearchParams(window.location.search).get('groupId');
        const requestedDashboardId = new URLSearchParams(window.location.search).get('dashboardId');
        const requestedDashboard = requestedDashboardId
          ? sortedDashboards.find((filename) => filename.includes(requestedDashboardId)) || null
          : null;
        const requestedDashboardMeta = requestedDashboard ? parseDashboardFilename(requestedDashboard) : null;
        const initialMonth = requestedDashboardMeta?.date ? requestedDashboardMeta.date.slice(0, 7) : selectedMonth;
        const initialGroup = configuredGroups.some((group: any) => group.chat_id === requestedGroupId)
          ? requestedGroupId!
          : configuredGroups[0]?.chat_id || 'all';
        const initialGroupConfig = configuredGroups.find((group: any) => group.chat_id === initialGroup);
        const matchesInitialGroup = (filename: string) => initialGroup === 'all' || !!initialGroupConfig && dashboardMatchesGroup(filename, initialGroupConfig);
        const initialGroupDashboards = sortedDashboards.filter(matchesInitialGroup);
        const currentMonthDashboards = initialGroupDashboards.filter(filename => parseDashboardFilename(filename).date.startsWith(initialMonth));
        setDashboards(sortedDashboards);
        setGroups(configuredGroups);
        setSelectedGroup(initialGroup);
        setSelectedMonth(initialMonth);
        setSelectedDashboard(requestedDashboard || currentMonthDashboards[0] || initialGroupDashboards[0] || sortedDashboards[0] || null);

      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || '加载看板失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDashboards = async () => {
    setRefreshing(true);
    setError('');
    try {
      const latest = sortDashboardFiles(await api.fetchDashboards());
      setDashboards(latest);
      setSelectedDashboard(current => current && latest.includes(current) ? current : latest[0] || null);
    } catch (e: any) {
      setError(e.message || '刷新历史看板失败');
    } finally {
      setRefreshing(false);
    }
  };

  const selectedGroupConfig = groups.find((group: any) => group.chat_id === selectedGroup);
  const filteredDashboards = dashboards.filter((filename: string) => {
    const meta = parseDashboardFilename(filename);
    const groupMatch = selectedGroup === 'all' || (selectedGroupConfig && dashboardMatchesGroup(filename, selectedGroupConfig));
    const monthMatch = selectedMonth ? meta.date.startsWith(selectedMonth) : true;
    return groupMatch && monthMatch;
  });

  const handleGroupChange = (groupId: string) => {
    setSelectedGroup(groupId);
    const nextParams = new URLSearchParams(searchParams);
    if (groupId === 'all') nextParams.delete('groupId');
    else nextParams.set('groupId', groupId);
    setSearchParams(nextParams, { replace: true });

    const groupConfig = groups.find((group: any) => group.chat_id === groupId);
    const groupDashboards = dashboards.filter((filename: string) =>
      groupId === 'all' || !!groupConfig && dashboardMatchesGroup(filename, groupConfig)
    );
    const monthDashboards = groupDashboards.filter((filename: string) => parseDashboardFilename(filename).date.startsWith(selectedMonth));
    setSelectedDashboard(monthDashboards[0] || groupDashboards[0] || null);
  };

  const openHistory = () => {
    setDrawerVisible(true);
    void refreshDashboards();
  };

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  }

  return (
    <Layout style={{ flex: 1, height: '100%', background: '#f5f5f5', position: 'relative' }}>
      <Drawer
        title="历史看板"
        extra={<Button type="text" icon={<ReloadOutlined />} loading={refreshing} onClick={refreshDashboards}>刷新</Button>}
        placement="left"
        closable={true}
        onClose={() => setDrawerVisible(false)}
        open={drawerVisible}
        getContainer={false}
        style={{ position: 'absolute' }}
        width={280}
        styles={{ body: { padding: 0 } }}
      >
        <div style={{ padding: '16px', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, color: '#888', fontSize: 12 }}>所属群组</div>
            <Select
              value={selectedGroup}
              onChange={handleGroupChange}
              style={{ width: '100%' }}
              placeholder="请选择群聊"
              options={[
                { label: '全部', value: 'all' },
                ...groups.map((g: any) => ({ label: g.name || g.chat_id, value: g.chat_id }))
              ]}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, color: '#888', fontSize: 12 }}>所属月份</div>
            <DatePicker
              picker="month"
              value={selectedMonth ? dayjs(selectedMonth, 'YYYY-MM') : null}
              onChange={(d) => setSelectedMonth(d ? d.format('YYYY-MM') : '')}
              style={{ width: '100%' }}
              placeholder="选择月份"
              allowClear={true}
            />
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedDashboard ? [selectedDashboard] : []}
          onClick={(e) => {
            setSelectedDashboard(e.key);
            setDrawerVisible(false);
          }}
          items={filteredDashboards
            .map((d: string) => {
              const meta = parseDashboardFilename(d);
              let label = [meta.date || d, meta.time].filter(Boolean).join(' ');
              const group = groups.find((g: any) => dashboardMatchesGroup(d, g));
              if (group) {
                label = `${group.name || group.chat_id} ${label}`;
              }
              return { key: d, label: label };
            })}
          style={{ borderRight: 0 }}
        />
        {filteredDashboards.length === 0 && <Empty description="暂无看板数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />}
      </Drawer>

      <Content style={{ padding: '24px', overflow: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 16 }}>
          <Typography.Title level={3} style={{ margin: 0, marginBottom: 8 }}>进度看板</Typography.Title>
          <Typography.Text type="secondary" style={{ display: 'block' }}>实时查看 TAPD 项目故事流转进度及各类维度的数据统计报表</Typography.Text>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {error ? (
            <Alert message="看板加载失败" description={error} type="error" showIcon />
          ) : selectedDashboard ? (
            <div style={{ flex: 1, border: '1px solid #d9d9d9', borderRadius: '8px', overflow: 'hidden', minHeight: '400px', position: 'relative', background: '#101418' }}>
              <iframe
                src={api.getDashboardUrl(selectedDashboard)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="Dashboard"
              />
            </div>
          ) : (
            <Alert message="请在左侧边栏选择要查看的看板" type="info" showIcon />
          )}
        </div>
      </Content>

      <div
        role="button"
        aria-label="打开历史看板"
        tabIndex={0}
        style={{
          position: 'absolute',
          top: '120px',
          left: '-1px',
          zIndex: 1,
          background: '#fff',
          border: '1px solid #d9d9d9',
          borderLeft: 'none',
          padding: '8px 12px',
          borderRadius: '0 8px 8px 0',
          cursor: 'pointer',
          boxShadow: '2px 0 8px rgba(0,0,0,0.05)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          color: '#333',
        }}
        onClick={openHistory}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            openHistory();
          }
        }}
      >
        <MenuOutlined style={{ fontSize: '14px', color: '#555' }} />
        <span style={{ fontSize: '14px' }}>历史看板</span>
      </div>
    </Layout>
  );
};

export default DashboardPage;
