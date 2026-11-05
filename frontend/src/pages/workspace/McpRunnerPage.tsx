import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Empty, Form, Input, Select, Skeleton } from 'antd';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import { mcpArguments } from './mcpInput';
import RunDrawer from './RunDrawer';

interface Tool { id: string; description: string; inputSchema: unknown }
export default function McpRunnerPage() {
  const { mutate } = useWorkspace();
  const { data, error: loadingError, isLoading, mutate: refresh } = useSWR<{ tools: Tool[] }>('mcp-runner-tools', api.fetchMcpTools);
  const [form] = Form.useForm();
  const toolId = Form.useWatch('toolId', form), selected = data?.tools.find(tool => tool.id === toolId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const execute = async (values: { toolId: string; arguments: string }) => {
    setBusy(true); setError('');
    try {
      const result = await api.runAgent('mcp.tools.run', { toolId: values.toolId, arguments: mcpArguments(values.arguments) }, crypto.randomUUID());
      setRunId(result.runId); await mutate();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>运行工具</h1><p>使用本地配置已授权的 MCP 读取工具，查看实际结果与执行步骤。</p></div></div>
    {loadingError ? <Alert type="error" showIcon title="工具授权加载失败" description="请检查后端和所选插件配置。" action={<Button onClick={() => refresh()}>重试</Button>} /> : isLoading ? <Skeleton active /> : !data?.tools.length ? <Empty description="当前没有已授权的工具" /> : <section className="knowledge-search">
      <Form form={form} layout="vertical" onFinish={execute} initialValues={{ arguments: '{}' }} disabled={busy}>
        <Form.Item name="toolId" label="已授权工具" rules={[{ required: true, message: '请选择工具' }]}><Select placeholder="选择要运行的工具" showSearch optionFilterProp="label" options={data.tools.map(tool => ({ value: tool.id, label: tool.id }))} onChange={() => form.setFieldValue('arguments', '{}')} /></Form.Item>
        {selected && <><p className="muted break-text">{selected.description}</p><details><summary>查看当前参数契约</summary><pre className="json-view">{JSON.stringify(selected.inputSchema, null, 2)}</pre></details></>}
        <Form.Item name="arguments" label="工具参数（JSON 对象）" rules={[{ required: true, message: '请填写参数，无参数时使用 {}' }, { validator: async (_, value: string) => { mcpArguments(value || ''); } }]} extra="参数会发送给对应的第三方服务；请按契约填写，最多 32 KiB。"><Input.TextArea rows={8} spellCheck={false} /></Form.Item>
        {error && <Alert type="error" showIcon title="工具未能执行" description={error} />}
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={busy} disabled={!selected}>运行工具</Button></div>
        <p className="muted">无需模型。一次执行记录包含授权路由和上游工具两个步骤，共享同一调用预算；服务的实际行为仍由提供者实现。</p>
      </Form>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
