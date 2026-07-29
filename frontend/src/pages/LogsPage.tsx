import { useEffect, useState } from 'react';
import { Typography, Tag, Alert, Table, DatePicker, Select, Space, Button } from 'antd';
import { api } from '@/api';
import dayjs from 'dayjs';
import { getEventMapping, EVENT_TYPE_MAP } from '@/constants';

import { LogsFilter } from '@/components/logs/LogsFilter';
import { LogsTable } from '@/components/logs/LogsTable';

const { Title } = Typography;

const LogsPage = () => {
  const [logs, setLogs] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [filters, setFilters] = useState<any>({ startDate: null, endDate: null, eventType: 'all', groupId: 'all' });
  const [appliedFilters, setAppliedFilters] = useState<any>({ startDate: null, endDate: null, eventType: 'all', groupId: 'all' });


  useEffect(() => {
    api.fetchConfig().then(cfg => {
      if (cfg.groups) {
        setGroups(cfg.groups);
      }
    }).catch(console.error);
  }, []);

  const fetchLogs = async (page: number, pageSize: number, filtersToApply: any = {}) => {
    setLoading(true);
    try {
      const response = await api.fetchLogs(page, pageSize, filtersToApply);
      setLogs(response.logs || []);
      setPagination({
        current: response.page || page,
        pageSize: response.pageSize || pageSize,
        total: response.total || 0,
      });
      setError('');
    } catch (e: any) {
      setError(e.message || '加载日志失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(pagination.current, pagination.pageSize, appliedFilters);
  }, [appliedFilters]);

  const handleSearch = () => {
    setAppliedFilters(filters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const handleReset = () => {
    const defaultFilters = { startDate: null, endDate: null, eventType: 'all', groupId: 'all' };
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  return (
    <div style={{ padding: "24px", flex: 1, overflow: "auto", backgroundColor: "#f5f5f5" }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Title level={3} style={{ margin: 0, marginBottom: 8 }}>系统审计日志</Title>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>记录系统行为轨迹、外部请求回调及底层报错日志</Typography.Text>

      <LogsFilter
        filters={filters}
        setFilters={setFilters}
        groups={groups}
        handleSearch={handleSearch}
        handleReset={handleReset}
      />

      {error && <Alert message="日志加载失败" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}

      <LogsTable
        logs={logs}
        loading={loading}
        groups={groups}
        pagination={pagination}
        fetchLogs={fetchLogs}
        appliedFilters={appliedFilters}
      />
      </div>
    </div>
  );
};

export default LogsPage;
