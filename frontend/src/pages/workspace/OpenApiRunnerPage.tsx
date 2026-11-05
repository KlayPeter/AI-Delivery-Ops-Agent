import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Empty, Form, Input, Select, Skeleton } from 'antd';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import { toolArguments } from './toolInput';
import RunDrawer from './RunDrawer';
interface Tool { id: string; key: string; summary: string; serverUrl: string; inputSchema: unknown }
export default function OpenApiRunnerPage() {
  const { mutate } = useWorkspace();
  const { data, error: loadingError, isLoading, mutate: refresh } = useSWR<{ tools: Tool[]; source: { title: string; url: string; sha256: string } }>('openapi-runner-tools', api.fetchOpenApiTools);
  const [form] = Form.useForm();
  const toolId = Form.useWatch('toolId', form), selected = data?.tools.find(tool => tool.id === toolId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const execute = async (values: { toolId: string; arguments: string }) => {
    setBusy(true); setError('');
    try { const result = await api.runAgent('openapi.tools.run', { toolId: values.toolId, arguments: toolArguments(values.arguments) }, crypto.randomUUID()); setRunId(result.runId); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="workspace-page"><div className="page-heading"><div><h1>API 工具</h1><p>读取本地配置明确授权的公开接口，保留规范指纹、响应与执行步骤。</p></div></div>
    {loadingError ? <Alert type="error" showIcon title="接口契约加载失败" action={<Button onClick={() => refresh()}>重试</Button>} /> : isLoading ? <Skeleton active /> : !data?.tools.length ? <Empty description="没有已授权的 OpenAPI 读取接口" /> : <section className="knowledge-search">
      <p className="muted break-text">{data.source.title} · 规范指纹 {data.source.sha256.slice(0, 12)} · <a href={data.source.url} target="_blank" rel="noreferrer">原始规范</a></p>
      <Form form={form} layout="vertical" onFinish={execute} initialValues={{ arguments: '{}' }} disabled={busy}>
        <Form.Item name="toolId" label="已授权接口" rules={[{ required: true, message: '请选择要读取的接口' }]}><Select placeholder="选择接口" options={data.tools.map(tool => ({ value: tool.id, label: tool.key }))} onChange={() => form.setFieldValue('arguments', '{}')} /></Form.Item>
        {selected && <><p className="muted break-text">{selected.summary}</p><p className="muted break-text">实际服务：{selected.serverUrl}</p><details><summary>输入契约（path / query）</summary><pre className="json-view">{JSON.stringify(selected.inputSchema, null, 2)}</pre></details></>}
        <Form.Item name="arguments" label="接口参数（JSON 对象）" rules={[{ required: true, message: '请填写参数，无参数时使用 {}' }, { validator: async (_, value: string) => { toolArguments(value || ''); } }]} extra="按契约将参数放入 path 或 query；参数会发送给所选服务，并保存在本机运行记录中。最多 32 KiB。"><Input.TextArea rows={8} spellCheck={false} /></Form.Item>
        {error && <Alert type="error" showIcon title="接口读取未完成" description={error} />}
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={busy} disabled={!selected}>读取接口</Button></div><p className="muted">不调用模型。完整响应保存在运行详情中，预览最多 64 KiB；接口数据由第三方提供，系统检查 JSON 格式，不保证数据内容正确。</p>
      </Form>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
