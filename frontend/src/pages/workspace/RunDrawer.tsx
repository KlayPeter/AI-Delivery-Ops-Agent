import { useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import { Alert, Button, Collapse, Drawer, Empty, Input, Spin, Tabs, Tag, Timeline, Typography } from 'antd';
import ReactMarkdown from 'react-markdown';
import { api } from '@/api';
import { capabilityName, errorMessage, useWorkspace, type RunInfo } from './state';
import { sourceHref } from './input';
import RunActions, { StatusPanelView } from './RunActions';
import { parseStatusPanels } from './panels';

const statuses: Record<string, [string, string]> = {
  queued: ['等待执行', 'default'], running: ['执行中', 'processing'], succeeded: ['已完成', 'success'],
  failed: ['执行失败', 'error'], waiting_human: ['待补充信息', 'warning'], cancelled: ['已取消', 'default'],
};
export function RunStatus({ status }: { status: string }) {
  const [label, color] = statuses[status] || [status, 'default'];
  return <Tag color={color}>{label}</Tag>;
}

interface Evidence { sourceKind?: string; lineBasis?: string; title?: string; path: string; excerpt: string; lineStart?: number; lineEnd?: number; openUri?: string; citationId?: string }
interface SourceCoverage { kind: 'markdown' | 'web'; status: 'available' | 'unavailable'; indexed: number; partial: boolean }
interface KnowledgeResult { hits?: Evidence[]; evidence?: Evidence[]; claims?: { text: string; citations?: { citationId: string }[] }[]; status?: string; reason?: string; source?: { partial?: boolean; sources?: SourceCoverage[] }; retrieval?: { partial?: boolean; sources?: SourceCoverage[] } }
interface RunDetail { run: RunInfo; controls?: { canCancel: boolean; cancellationRequested: boolean }; steps: { id: string; name: string; kind: string; status: string; error?: { message: string } }[]; artifacts: { id: string; type: string; content?: unknown; metadata?: Record<string, unknown> }[]; children: RunInfo[]; checkpoint?: { question?: string } }
function downloadMarkdown(content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'result.md'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ResultContent({ artifact, onSelectRun }: { artifact: { id: string; type: string; content?: unknown; metadata?: Record<string, unknown> }; onSelectRun: (id: string) => void }) {
  const content = artifact.content;
  const panels = parseStatusPanels(artifact.metadata?.statusPanels);
  if (panels) return <>{panels.map((panel, index) => <StatusPanelView key={index} panel={panel} onSelectRun={onSelectRun} />)}</>;
  if (typeof content === 'string') return <div className="result-markdown"><div className="form-actions"><Typography.Text copyable={{ text: content }}>复制 Markdown</Typography.Text><Button onClick={() => downloadMarkdown(content)}>下载 Markdown</Button></div><ReactMarkdown skipHtml components={{ img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>, a: ({ href, children }) => <a href={sourceHref(href)} target="_blank" rel="noreferrer">{children}</a> }}>{content}</ReactMarkdown></div>;
  const data = content && typeof content === 'object' ? content as KnowledgeResult : {};
  if (data.hits || data.claims || data.status === 'insufficient_evidence') {
    const evidence = data.hits || data.evidence || [];
    const sourceCoverage = data.source?.sources || data.retrieval?.sources;
    return <div className="result-content">
      {(data.source?.partial || data.retrieval?.partial) && <Alert type="warning" title="部分来源未能完整读取，本次结果可能不完整" showIcon />}
      {Array.isArray(sourceCoverage) && sourceCoverage.length <= 2 && <p className="muted">{sourceCoverage.filter(item => item && ['markdown', 'web'].includes(item.kind) && ['available', 'unavailable'].includes(item.status)).map(item => <Tag key={item.kind}>{item.kind === 'web' ? '网页' : '笔记'} · {item.status === 'unavailable' ? '读取失败' : item.partial ? '部分可读' : '已读取'}</Tag>)}</p>}
      {data.claims?.map((claim, i) => <p key={i}>{claim.text} {claim.citations?.map(citation => { const index = evidence.findIndex(hit => hit.citationId === citation.citationId); return index >= 0 ? <a key={citation.citationId} href={`#evidence-${artifact.id}-${index}`}>[{index + 1}] </a> : null; })}</p>)}
      {data.status === 'insufficient_evidence' && <Alert type="info" title="当前资料不足以回答" description={data.reason} showIcon />}
      <div className="section-caption">{data.hits ? `找到 ${evidence.length} 条相关片段` : '引用来源'}</div>
      {evidence.map((hit, i) => <article className="evidence" id={`evidence-${artifact.id}-${i}`} key={i}>
        <strong>{data.claims ? `[${i + 1}] ` : ''}{hit.title || hit.path}</strong><div className="muted break-text">{hit.sourceKind === 'web' ? '网页 · 提取文本 · ' : hit.sourceKind === 'markdown' ? '笔记 · ' : ''}{hit.path} · 行 {hit.lineStart}–{hit.lineEnd}</div>
        <blockquote>{hit.excerpt}</blockquote>
        {sourceHref(hit.openUri) && <a href={sourceHref(hit.openUri)} target="_blank" rel="noreferrer">打开原文</a>}
      </article>)}
      {!evidence.length && !data.reason && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有命中相关片段，试试其他关键词" />}
    </div>;
  }
  return <pre className="json-view">{JSON.stringify(content, null, 2)}</pre>;
}

export default function RunDrawer({ runId, onClose, onSelectRun }: { runId: string | null; onClose: () => void; onSelectRun: (id: string) => void }) {
  const { data: workspace, mutate } = useWorkspace();
  const { data, error, isLoading, mutate: refresh } = useSWR<RunDetail>(runId ? ['run', runId] : null, () => api.fetchRun(runId!), { refreshInterval: details => details && ['running', 'queued', 'waiting_human'].includes(details.run.status) ? 2000 : 0 });
  const recipesAvailable = workspace?.pages.some(page => page.path === '/recipes');
  const watchesAvailable = workspace?.plugins.some(plugin => plugin.id === 'knowledge.watch');
  const { data: watchSource } = useSWR<{ receipt: { runIds: string[]; attemptedAt: string } | null }>(runId && watchesAvailable ? ['knowledge-watch-receipt', runId] : null, () => api.fetchKnowledgeWatchReceipt(runId!));
  const { data: provenance } = useSWR<{ receipt: { recipeName: string; sourceRunId: string; parametersChanged: boolean } | null }>(runId && recipesAvailable ? ['recipe-receipt', runId] : null, () => api.fetchRecipeReceipt(runId!));
  const [reply, setReply] = useState('');
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [stopping, setStopping] = useState(false), [stopError, setStopError] = useState('');
  const artifacts = (data?.artifacts || []).filter(artifact => data?.run.status === 'waiting_human' || artifact.metadata?.waitingHuman !== true).sort((a, b) => Number(Boolean(parseStatusPanels(b.metadata?.statusPanels))) - Number(Boolean(parseStatusPanels(a.metadata?.statusPanels))) || Number(b.metadata?.artifactRole === 'personal.research.summary') - Number(a.metadata?.artifactRole === 'personal.research.summary'));
  const resume = async () => {
    setResuming(true); setResumeError('');
    try { await api.resumeRun(runId!, { prompt: reply.trim(), text: reply.trim() }, crypto.randomUUID()); setReply(''); await Promise.all([refresh(), mutate()]); }
    catch (e) { setResumeError(errorMessage(e)); } finally { setResuming(false); }
  };
  const stop = async () => {
    setStopping(true); setStopError('');
    try { await api.cancelRun(runId!); await Promise.all([refresh(), mutate()]); }
    catch (e) { setStopError(errorMessage(e)); } finally { setStopping(false); }
  };
  return <Drawer title={data ? capabilityName(data.run.capability, workspace?.agents.find(agent => agent.capabilities.includes(data.run.capability))?.name) : '运行详情'} open={Boolean(runId)} onClose={onClose} size="large" className="run-drawer">
    {isLoading ? <Spin /> : error ? <Alert type="error" title="加载失败" description={error.message} /> : data ? <>
      <div className="run-meta"><RunStatus status={data.run.status} />{data.run.triggerType === 'schedule' && <Tag>定时触发</Tag>}<Typography.Text copyable className="muted">{data.run.id}</Typography.Text></div>
      {data.controls?.canCancel && <div className="form-actions"><Button onClick={stop} loading={stopping}>请求停止</Button><span className="muted">已完成的操作不会撤销</span></div>}
      {data.controls?.cancellationRequested && ['running', 'queued'].includes(data.run.status) && <Alert type="info" showIcon title="已请求停止，正在更新运行记录" />}
      {stopError && <Alert type="error" showIcon title="停止请求未确认" description={stopError} />}
      {recipesAvailable && data.run.status === 'succeeded' && !data.run.parentRunId && <p><Link to={`/recipes?runId=${encodeURIComponent(data.run.id)}`} onClick={onClose}>保存为任务配方</Link></p>}
      {provenance?.receipt && <Alert type="info" showIcon title={`来自「${provenance.receipt.recipeName}」配方${provenance.receipt.parametersChanged ? ' · 本次参数已修改' : ''}`} action={<Button onClick={() => onSelectRun(provenance.receipt!.sourceRunId)}>查看来源运行</Button>} />}
      {watchSource?.receipt && <Alert type="info" showIcon title="由知识定期复核计划发起" description={`本次检查 ${watchSource.receipt.runIds.length} 条历史结果，发起于 ${dayjs(watchSource.receipt.attemptedAt).format('YYYY-MM-DD HH:mm:ss')}`} />}
      {data.run.error && <Alert type={data.run.status === 'cancelled' ? 'info' : 'error'} showIcon title={data.run.status === 'cancelled' ? '任务已取消' : '本次执行未完成'} description={data.run.error.message} />}
      {data.run.status === 'succeeded' && <RunActions runId={data.run.id} onSelectRun={onSelectRun} />}
      {data.run.status === 'waiting_human' && data.run.parentRunId && <Alert type="info" showIcon title="子任务等待补充信息" description="请返回父任务，由父 Agent 管理继续执行。" action={<Button onClick={() => onSelectRun(data.run.parentRunId!)}>查看父任务</Button>} />}
      {data.run.status === 'waiting_human' && !data.run.parentRunId && <div className="resume-form">
        <Alert type="warning" title="Agent 需要你补充信息" description={data.checkpoint?.question || '查看下方结果，补充后继续同一次运行。'} showIcon />
        <label htmlFor="resume-input">补充说明</label><Input.TextArea id="resume-input" value={reply} onChange={e => setReply(e.target.value)} rows={3} />
        {resumeError && <Alert type="error" title={resumeError} />}<Button onClick={resume} loading={resuming} disabled={!reply.trim()} type="primary">继续执行</Button>
      </div>}
      <Tabs items={[
        { key: 'result', label: '结果', children: artifacts.length ? artifacts.map(a => <ResultContent key={a.id} artifact={a} onSelectRun={onSelectRun} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={data.run.status === 'running' ? '执行中，产物完成后会显示在这里' : '本次运行没有生成产物'} /> },
        { key: 'steps', label: `执行步骤 · ${data.steps.length}`, children: <>
          <Timeline items={data.steps.map(step => ({ color: step.status === 'failed' ? 'red' : step.status === 'running' ? 'blue' : 'gray', content: <div><strong>{step.name}</strong><div className="muted">{step.kind} · {step.status}</div>{step.error && <p>{step.error.message}</p>}</div> }))} />
          {data.children.map((run: RunInfo) => <div className="child-run" key={run.id}>{capabilityName(run.capability, workspace?.agents.find(agent => agent.capabilities.includes(run.capability))?.name)}<RunStatus status={run.status} /><Button type="link" onClick={() => onSelectRun(run.id)}>查看子任务</Button></div>)}
        </> },
        { key: 'detail', label: '详情', children: <Collapse items={[{ key: 'raw', label: '原始运行记录', children: <pre className="json-view">{JSON.stringify(data, null, 2)}</pre> }]} /> },
      ]} />
    </> : null}
  </Drawer>;
}
