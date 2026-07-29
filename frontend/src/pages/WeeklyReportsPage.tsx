import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Drawer, Empty, Layout, List, Select, Spin, Tag, Typography } from 'antd';
import { ExportOutlined, MenuOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/api';

const { Content } = Layout;

type WeeklyReportSummary = {
  id: string;
  group_id: string;
  group_name: string;
  period_start: string;
  period_end: string;
  cutoff_at: string;
  version: number;
  generated_at: string;
  trigger_type: string;
};

const formatPeriod = (report: WeeklyReportSummary) => `${report.period_start} 至 ${report.period_end}`;

const WeeklyReportsPage = () => {
  const [reports, setReports] = useState<WeeklyReportSummary[]>([]);
  const [searchParams] = useSearchParams();
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [error, setError] = useState('');

  const loadReports = async (refresh = false) => {
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const nextReports = await api.fetchWeeklyReports();
      setReports(nextReports);
      const requestedReportId = searchParams.get('reportId');
      setSelectedReportId((current) => requestedReportId && nextReports.some((report: WeeklyReportSummary) => report.id === requestedReportId)
        ? requestedReportId
        : current && nextReports.some((report: WeeklyReportSummary) => report.id === current)
        ? current
        : nextReports[0]?.id || null);
    } catch (reason: any) {
      setError(reason.message || '加载周报失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadReports();
  }, [searchParams]);

  const groupOptions = useMemo(() => Array.from(new Map(reports.map((report) => [report.group_id, report.group_name])).entries())
    .map(([value, label]) => ({ value, label })), [reports]);
  const filteredReports = selectedGroup === 'all'
    ? reports
    : reports.filter((report) => report.group_id === selectedGroup);
  const selectedReport = filteredReports.find((report) => report.id === selectedReportId)
    || filteredReports[0]
    || null;

  const handleGroupChange = (groupId: string) => {
    setSelectedGroup(groupId);
    const firstReport = groupId === 'all' ? reports[0] : reports.find((report) => report.group_id === groupId);
    setSelectedReportId(firstReport?.id || null);
  };

  const openHistory = () => {
    setDrawerVisible(true);
    void loadReports(true);
  };

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  }

  return (
    <Layout style={{ flex: 1, height: '100%', background: '#f4f2ed', position: 'relative' }}>
      <Drawer
        title="周报档案"
        extra={<Button type="text" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void loadReports(true)}>刷新</Button>}
        placement="left"
        closable
        onClose={() => setDrawerVisible(false)}
        open={drawerVisible}
        getContainer={false}
        style={{ position: 'absolute' }}
        width={310}
        styles={{ body: { padding: 0 } }}
      >
        <div style={{ padding: 16, borderBottom: '1px solid #e6e0d6', background: '#fbfaf7' }}>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>所属群组</Typography.Text>
          <Select
            value={selectedGroup}
            onChange={handleGroupChange}
            style={{ width: '100%' }}
            options={[{ label: '全部群组', value: 'all' }, ...groupOptions]}
          />
        </div>
        <List
          dataSource={filteredReports}
          locale={{ emptyText: <Empty description="暂无周报" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(report) => (
            <List.Item
              style={{ padding: 0, borderBottom: '1px solid #eee9e1' }}
              onClick={() => {
                setSelectedReportId(report.id);
                setDrawerVisible(false);
              }}
            >
              <button
                type="button"
                style={{
                  width: '100%', border: 0, textAlign: 'left', cursor: 'pointer', padding: '14px 16px',
                  background: report.id === selectedReport?.id ? '#eef5f3' : '#fff', color: '#172421',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{report.group_name}</div>
                <div style={{ color: '#5e665f', fontSize: 12 }}>{formatPeriod(report)}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{dayjs(report.generated_at).format('YYYY-MM-DD HH:mm')}</Typography.Text>
                  <Tag color="green" style={{ margin: 0 }}>v{report.version}</Tag>
                </div>
              </button>
            </List.Item>
          )}
        />
      </Drawer>

      <Content style={{ padding: 24, overflow: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 16 }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0, color: '#172421', letterSpacing: '-0.03em' }}>周报</Typography.Title>
            <Typography.Text type="secondary">按群归档的周度交付记录，可直接预览完整 HTML。</Typography.Text>
          </div>
          {selectedReport && (
            <Button icon={<ExportOutlined />} onClick={() => window.open(api.getWeeklyReportUrl(selectedReport.id), '_blank', 'noopener,noreferrer')}>
              新窗口打开
            </Button>
          )}
        </div>
        {error ? (
          <Alert message="周报加载失败" description={error} type="error" showIcon />
        ) : selectedReport ? (
          <div style={{ flex: '0 0 auto', height: 'max(640px, calc(100vh - 190px))', border: '1px solid #d9d2c6', borderRadius: 10, overflow: 'hidden', background: '#fff', boxShadow: '0 14px 35px rgba(45, 55, 45, .08)' }}>
            <iframe
              key={selectedReport.id}
              src={api.getWeeklyReportUrl(selectedReport.id)}
              style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
              title={`${selectedReport.group_name}周报`}
            />
          </div>
        ) : (
          <Empty description="暂无已生成的周报" style={{ margin: '100px auto' }} />
        )}
      </Content>

      <div
        role="button"
        aria-label="打开周报档案"
        tabIndex={0}
        style={{
          position: 'absolute', top: 120, left: -1, zIndex: 1, background: '#173f36', color: '#fff', border: '1px solid #173f36',
          borderLeft: 'none', padding: '8px 12px', borderRadius: '0 8px 8px 0', cursor: 'pointer', boxShadow: '2px 0 8px rgba(0,0,0,.10)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
        onClick={openHistory}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') openHistory();
        }}
      >
        <MenuOutlined style={{ fontSize: 14 }} />
        <span style={{ fontSize: 14 }}>周报档案</span>
      </div>
    </Layout>
  );
};

export default WeeklyReportsPage;
