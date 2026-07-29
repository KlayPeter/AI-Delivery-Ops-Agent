import { useEffect, useState } from 'react';
import { Table, Tag, Typography, message, Tooltip, Space, Alert, DatePicker, Select, Button, Tabs } from 'antd';
import { api } from '@/api';
import dayjs from 'dayjs';

import { ContextsFilter } from '@/components/contexts/ContextsFilter';
import { ContextsTable } from '@/components/contexts/ContextsTable';

const { Title, Text } = Typography;

const ContextsPage = () => {
  const [contexts, setContexts] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 15, total: 0 });
  const [members, setMembers] = useState<any[]>([]);
  const [filters, setFilters] = useState<any>({ startDate: null, endDate: null, contextType: 'all', chatType: 'private', targetOpenId: 'all', groupId: 'all' });
  const [appliedFilters, setAppliedFilters] = useState<any>({ startDate: null, endDate: null, contextType: 'all', chatType: 'private', targetOpenId: 'all', groupId: 'all' });


  useEffect(() => {
    api.fetchConfig().then(cfg => {
      if (cfg.groups) {
        setGroups(cfg.groups);
      }
    }).catch(console.error);
  }, []);

  const fetchContexts = async (page: number, pageSize: number, filtersToApply: any = {}) => {
    setLoading(true);
    try {
      const response = await api.fetchContexts(page, pageSize, filtersToApply);
      setContexts(response.contexts || []);
      setPagination({
        current: response.page || page,
        pageSize: response.pageSize || pageSize,
        total: response.total || 0,
      });
      setError('');
    } catch (err: any) {
      setError(err.message || '加载上下文失败');
      message.error('加载上下文失败：' + (err.message || '请求失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContexts(pagination.current, pagination.pageSize, appliedFilters);
  }, [appliedFilters]);

  useEffect(() => {
    api.fetchConfig().then(data => {
      if (data && data.members) setMembers(data.members);
    }).catch(err => console.error('Failed to load members:', err));
  }, []);

  const handleSearch = () => {
    setAppliedFilters(filters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const handleReset = () => {
    const defaultFilters = { startDate: null, endDate: null, contextType: 'all', chatType: filters.chatType, targetOpenId: 'all' };
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const handleTabChange = (key: string) => {
    const newFilters = { ...filters, chatType: key };
    setFilters(newFilters);
    setAppliedFilters(newFilters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  return (
    <div style={{ padding: "24px", flex: 1, overflow: "auto", backgroundColor: "#f5f5f5" }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0, marginBottom: 8 }}>上下文记忆</Title>
        <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>展示系统发送的强交互消息记录，当用户对其“引用回复”时中台能精确识别上下文语境。</Text>
      </div>

      <ContextsFilter
        filters={filters}
        setFilters={setFilters}
        members={members}
        groups={groups}
        handleSearch={handleSearch}
        handleReset={handleReset}
        handleTabChange={handleTabChange}
      />

      {error && <Alert message="上下文加载失败" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}

      <ContextsTable
        contexts={contexts}
        loading={loading}
        pagination={pagination}
        fetchContexts={fetchContexts}
        appliedFilters={appliedFilters}
      />
      </div>
    </div>
  );
};

export default ContextsPage;
