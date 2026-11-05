import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Form, Input } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

export default function ResearchPage() {
  const { data, mutate } = useWorkspace();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const research = async ({ prompt }: { prompt: string }) => {
    setBusy(true); setError('');
    try { const result = await api.startAgent('personal.research', { prompt: prompt.trim(), source: 'private' }, crypto.randomUUID()); setRunId(result.runId); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const available = data?.agents.some(agent => agent.status === 'active' && agent.capabilities.includes('personal.research'));
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>研究助手</h1><p>从一个问题出发，让 Agent 选择资料子任务，再把来源和研究稿一起交给你。</p></div></div>
    {!data?.modelConfigured && <Alert type="info" showIcon title="研究助手需要模型服务" description={<span>先<Link to="/connections">连接自己的模型</Link>，也可以查看{data?.pages.some(page => page.path === '/knowledge') ? <Link to="/knowledge">知识库</Link> : <Link to="/agents">可用资料能力</Link>}直接检索原文。</span>} />}
    <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><RobotOutlined aria-hidden /></span><h2>这次想研究什么</h2></div>
      <Form layout="vertical" onFinish={research} disabled={busy}>
        <Form.Item name="prompt" label="问题与资料范围" rules={[{ required: true, whitespace: true, message: '请说明研究问题，以及你希望使用的资料' }]} extra="可使用当前知识来源、明确给出的公开网页，以及已装配的开发文档或发布准备能力。"><Input.TextArea rows={6} maxLength={4000} showCount placeholder="例如：查找 API 迁移说明相关笔记，整理发布前必须确认的事项，区分原文要求和你的建议。" /></Form.Item>
        {error && <Alert type="error" showIcon title="研究未能发起" description={error} />}
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={busy} disabled={!available || !data?.modelConfigured}>开始研究</Button></div>
      </Form>
      <p className="muted">问题和取回的知识片段会发送给你配置的模型。最多四次子任务委派，缺少信息时可暂停提问；完成前会检查真实子任务资料。研究稿仍需复核，知识问答子任务另有引用核验。</p>
    </section>
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
