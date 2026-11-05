import { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { FileSearchOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

export default function CapturePage() {
  const { data, mutate } = useWorkspace();
  const [running, setRunning] = useState(false), [error, setError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const execute = async ({ url }: { url: string }) => {
    setRunning(true); setError('');
    try { const result = await api.runAgent('knowledge.page.capture', { url: url.trim() }, crypto.randomUUID()); setRunId(result.runId); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setRunning(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>网页收集</h1><p>把值得保留的公开文章转成带来源的 Markdown 资料。</p></div></div>
    <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><FileSearchOutlined aria-hidden /></span><h2>收集一篇文章</h2></div>
      <Form layout="vertical" onFinish={execute}>
        <Form.Item name="url" label="公开网页链接" rules={[{ required: true, message: '请填写网页链接' }, { type: 'url', message: '请填写完整的 HTTP 或 HTTPS 链接' }]} extra="读取单页正文；不支持登录页面、动态交互和全站抓取。"><Input placeholder="https://example.com/article" maxLength={1024} /></Form.Item>
        {error && <Alert type="error" showIcon title="未能收集网页" description={error} />}
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={running} disabled={!data?.agents.some(agent => agent.capabilities.includes('knowledge.page.capture'))}>收集正文</Button></div>
        <p className="muted">无需模型。结果保留原始链接、采集时间和内容版本，可复制或下载后放入你的知识目录。</p>
      </Form>
    </section>
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
