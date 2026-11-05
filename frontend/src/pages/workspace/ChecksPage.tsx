import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Empty, Form, Select, Skeleton } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface Contract { id: string; title: string; version: string; capability: string; provider: { pluginId: string; pluginVersion: string }; artifactChecks: number; stepChecks: number }
export default function ChecksPage() {
  const { data: workspace, mutate } = useWorkspace();
  const { data, error: loadingError, isLoading, mutate: refresh } = useSWR<{ contracts: Contract[] }>('plugin-checks-contracts', api.fetchRunCheckContracts);
  const [form] = Form.useForm();
  const contractId = Form.useWatch('contractId', form), selectedRun = Form.useWatch('runId', form);
  const selected = data?.contracts.find(item => item.id === contractId);
  const candidates = (workspace?.runs || []).filter(run => run.capability === selected?.capability && ['succeeded', 'failed', 'cancelled'].includes(run.status));
  const options = candidates.map(run => ({ value: run.id, label: `${dayjs(run.createdAt).format('MM-DD HH:mm')} · ${run.id.slice(0, 8)} · ${run.status === 'succeeded' ? '已完成' : run.status === 'failed' ? '失败' : '已取消'}` }));
  const [running, setRunning] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const check = async (values: { contractId: string; runId: string; baselineRunId?: string }) => {
    setRunning(true); setError('');
    try { const result = await api.runAgent('quality.runs.check', values, crypto.randomUUID()); setRunId(result.runId); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setRunning(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>结果验收</h1><p>检查插件产物、执行步骤和版本凭证，比较两次运行的规则差异。</p></div><Button onClick={() => { refresh(); mutate(); }}>刷新记录</Button></div>
    {loadingError && <Alert type="error" showIcon title="验收规则加载失败" description="请检查本地后端和插件装配后重试。" action={<Button onClick={() => refresh()}>重试</Button>} />}
    {isLoading ? <Skeleton active /> : !loadingError && !data?.contracts.length ? <Empty description="当前已装配的插件尚未声明验收规则" /> : !loadingError && <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><SafetyCertificateOutlined aria-hidden /></span><h2>验收一次运行</h2></div>
      <Form form={form} layout="vertical" onFinish={check}>
        <Form.Item name="contractId" label="验收规则" rules={[{ required: true, message: '请选择插件声明的规则' }]}><Select placeholder="选择要检查的结果类型" options={data?.contracts.map(item => ({ value: item.id, label: `${item.title} · v${item.version}` }))} onChange={() => form.resetFields(['runId', 'baselineRunId'])} /></Form.Item>
        {selected && <p className="muted">{selected.provider.pluginId} · {selected.artifactChecks} 项产物检查，{selected.stepChecks} 项步骤检查</p>}
        <Form.Item name="runId" label="受检运行" rules={[{ required: true, message: '请选择要验收的运行' }]} extra="列出最近 50 次根运行中，已结束且匹配规则的记录。"><Select disabled={!selected} placeholder="选择受检结果" options={options} showSearch optionFilterProp="label" /></Form.Item>
        <Form.Item name="baselineRunId" label="对比基准（可选）" extra="两次记录按同一份规则检查；比较差异不直接证明插件升级是原因。"><Select allowClear disabled={!selected} placeholder="仅验收一次，或选择另一运行比较" options={options.filter(item => item.value !== selectedRun)} showSearch optionFilterProp="label" /></Form.Item>
        {error && <Alert type="error" showIcon title="验收未能执行" description={error} />}
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={running} disabled={!selected}>开始验收</Button></div>
      </Form>
      <p className="muted">读取已有记录，不重执行任务或调用模型。报告保留规则和证据指纹；结构通过不等于内容语义正确。旧记录缺少版本凭证时会明确标记。</p>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
