import { useRef, useState } from 'react';
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { Alert, Button, Checkbox, Skeleton } from 'antd';
import { api } from '@/api';
import { errorMessage } from './state';

interface Preview { runId: string; artifactHash: string; contextHash: string; question: string; limit: number; model: { provider: string; name: string; endpoint: string } }
export default function ReanswerPanel({ sourceRunId, sourceLabel, canAnswer, modelConfigured, pendingSettings, onStart, onSelectRun }: {
  sourceRunId: string; sourceLabel: string; canAnswer: boolean; modelConfigured: boolean; pendingSettings: boolean;
  onStart: (runId: string) => void; onSelectRun: (runId: string) => void;
}) {
  const { data, error, mutate } = useSWR<Preview>(['reanswer-preview', sourceRunId], () => api.fetchReanswerSource(sourceRunId));
  const [confirmed, setConfirmed] = useState('');
  const requestId = useRef({ identity: '', id: '' });
  const [running, setRunning] = useState(false), [actionError, setActionError] = useState('');
  const identity = data ? `${data.artifactHash}:${data.contextHash}` : '';
  const ready = Boolean(data && identity && confirmed === identity && canAnswer && modelConfigured && !pendingSettings);
  const execute = async () => {
    if (!data || !ready) return;
    setRunning(true); setActionError('');
    try {
      if (requestId.current.identity !== identity) requestId.current = { identity, id: crypto.randomUUID() };
      const result = await api.startAgent('knowledge.answer', { question: data.question, limit: data.limit, reanswer: { runId: data.runId, artifactHash: data.artifactHash, contextHash: data.contextHash, confirmed: true } }, requestId.current.id);
      setConfirmed(''); requestId.current = { identity: '', id: '' }; onStart(result.runId); void mutate().catch(() => {});
    } catch (e) { setActionError(errorMessage(e)); }
    finally { setRunning(false); }
  };
  return <section className="knowledge-search" aria-busy={running}>
    <h2>按最新资料重新回答</h2>
    <p>沿用原问题，重新检索当前知识来源；生成独立结果，保留原回答与引用。</p>
    {error ? <Alert type="error" showIcon title="无法准备原问题" description={errorMessage(error)} action={<Button onClick={() => mutate()}>重试</Button>} /> : !data ? <Skeleton active /> : <>
      <div className="section-caption">原问题</div><p className="break-text">{data.question}</p>
      <p className="muted break-text">资料：{sourceLabel} · 最多检索 {data.limit} 条片段<br />模型：{data.model.provider || '当前供应商'} / {data.model.name || '未设置'}<br />服务：{data.model.endpoint}</p>
      {!modelConfigured && <p className="muted">请先<Link to="/connections">配置模型</Link>，再确认生成。</p>}
      {!canAnswer && <Alert type="warning" showIcon title="当前问答插件与知识来源不可用或不匹配" />}
      {pendingSettings && <p className="muted">请先应用已保存的配置，再重新确认。</p>}
      <Checkbox checked={confirmed === identity} disabled={running || !canAnswer || !modelConfigured || pendingSettings} onChange={event => setConfirmed(event.target.checked ? identity : '')}>确认使用当前来源和模型；选中的最新片段会发送给上述模型服务</Checkbox>
      {actionError && <Alert type="error" showIcon title="启动未确认" description={actionError} />}
      <div className="form-actions"><Button type="primary" loading={running} disabled={!ready} onClick={execute}>读取最新资料并生成</Button><Button disabled={running} onClick={() => onSelectRun(data.runId)}>查看原回答</Button></div>
      <p className="muted">新回答需要你审阅，不会自动证明或修正旧结论。<Link to="/knowledge">返回普通问答</Link></p>
    </>}
  </section>;
}
