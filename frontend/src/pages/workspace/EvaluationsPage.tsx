import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Checkbox, Empty, Input, Select, Skeleton, Tag } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface Suite { id: string; suiteHash: string; caseTimeoutSeconds: number; maxGenerationCalls: number; cases: { id: string; title: string; question: string }[] }
interface Report {
  label: string; mode: 'fixture' | 'model'; fixture: string | null; suiteHash: string; finishedAt: string; semanticSupport: string;
  target: { provider: string; model: string }; pipeline: { agentVersion: string; sourceHash: string }; graderHash: string;
  summary: { total: number; passed: number; failed: number; generationCalls: number; medianMs: number; p95Ms: number };
  cases: { id: string; title: string; question: string; passed: boolean; elapsedMs: number; caseRunId: string; checks: { id: string; label: string; passed: boolean }[];
    actual: { runStatus: string; answerStatus: string | null; text: string; quotes: { path: string; quote: string }[]; citationPaths: string[]; citationContract: boolean; generationCalls: number; inputTokens: number | null; outputTokens: number | null; trace: { kind: string; name: string; status: string }[] } }[];
}
interface Comparison { passDelta: number; baseline: { label: string }; candidate: { label: string }; cases: { id: string; title: string; change: string }[]; changed: { model: boolean; pipeline: boolean; fixture: boolean } }
export default function EvaluationsPage() {
  const { data: workspace, mutate: refresh } = useWorkspace();
  const { data: suite, error: suiteError, isLoading } = useSWR<Suite>('evaluation-suite', api.fetchEvaluationSuite);
  const [mode, setMode] = useState<'fixture' | 'model'>('fixture'), [preset, setPreset] = useState('baseline'), [label, setLabel] = useState('本地基线'), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [report, setReport] = useState<Report | null>(null), [reportId, setReportId] = useState<string | null>(null), [runId, setRunId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | undefined>(), [candidate, setCandidate] = useState<string | undefined>(), [comparison, setComparison] = useState<Comparison | null>(null);
  const runs = (workspace?.runs || []).filter(run => !run.parentRunId && run.capability === 'quality.rag.evaluate' && run.status === 'succeeded');
  const options = runs.map(run => ({ value: run.id, label: `${dayjs(run.createdAt).format('MM-DD HH:mm:ss')} · ${run.id.slice(0, 8)}` }));
  const load = async (id: string) => { setReport(await api.fetchEvaluationReport(id)); setReportId(id); };
  const start = async () => {
    if (!label.trim() || (mode === 'model' && (!confirmed || !workspace?.modelConfigured))) return;
    setBusy(true); setError('');
    try {
      const result = await api.runAgent('quality.rag.evaluate', mode === 'fixture' ? { mode, fixture: preset, label: label.trim() } : { mode, confirmed: true, label: label.trim() }, crypto.randomUUID());
      setReportId(result.runId); const detail = await api.fetchRun(result.runId);
      if (detail.run.status !== 'succeeded') throw new Error(detail.run.error?.message || '评测未完成，请查看运行记录');
      await load(result.runId);
    } catch (e) { setError(errorMessage(e)); } finally { await refresh(); setBusy(false); }
  };
  const open = async (id: string) => { setBusy(true); setError(''); try { await load(id); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  const compare = async () => { if (!baseline || !candidate || baseline === candidate) return; setBusy(true); setError(''); setComparison(null); try { setComparison(await api.compareEvaluations(baseline, candidate)); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })), link = document.createElement('a');
    link.href = url; link.download = `rag-evaluation-${reportId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>问答评测</h1><p>用同一组资料和问题，检查知识问答有没有退步。</p></div><Button disabled={busy} onClick={() => refresh()}>刷新记录</Button></div>
    {error && <Alert showIcon type="error" title="评测操作未完成" description={error} />}
    {suiteError ? <Alert showIcon type="error" title="题集加载失败" description={errorMessage(suiteError)} /> : isLoading ? <Skeleton active /> : suite && <>
      <section className="knowledge-search"><h2>运行固定题集</h2><p className="muted">6 道题使用随项目附带的虚构笔记，覆盖正常引用、资料冲突、指令注入、空检索、无关干扰与资料不足。独立运行，不读取你的个人资料。</p>
        <div className="form-actions"><label htmlFor="evaluation-mode">运行方式</label><Select id="evaluation-mode" value={mode} disabled={busy} onChange={value => { setMode(value); setConfirmed(false); }} options={[{ value: 'fixture', label: '离线固定样例' }, { value: 'model', label: '当前配置的模型' }]} />
          {mode === 'fixture' && <><label htmlFor="evaluation-preset">样例</label><Select id="evaluation-preset" value={preset} disabled={busy} onChange={setPreset} options={[{ value: 'baseline', label: '正确协议基线' }, { value: 'regression', label: '故意出错的对照' }]} /></>}
        </div>
        <label htmlFor="evaluation-label">记录名称</label><Input id="evaluation-label" value={label} disabled={busy} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="例如：更换模型后" />
        {mode === 'fixture' ? <p className="muted">固定模型回复用于验证检索、引用契约和检查规则；结果不能当成真实模型的正确率。</p> : <>
          <p className="muted">将虚构题集发给当前模型，最多 {suite.maxGenerationCalls} 次生成，每题最多 {suite.caseTimeoutSeconds} 秒；可能产生供应商费用。只支持已配置的 OpenAI 兼容、Google 或 Ollama 模型。</p>
          {!workspace?.modelConfigured && <Alert type="info" showIcon title="请先在连接设置中配置模型" />}
          <div className="form-actions"><Checkbox checked={confirmed} disabled={busy || !workspace?.modelConfigured} onChange={event => setConfirmed(event.target.checked)}>确认使用当前模型运行这组虚构题目</Checkbox></div>
        </>}
        <div className="form-actions"><Button type="primary" loading={busy} disabled={!label.trim() || (mode === 'model' && (!confirmed || !workspace?.modelConfigured))} onClick={start}>运行 6 道题</Button></div>
        {busy && <p role="status" className="muted">正在处理评测，请等待结果；当前模型运行最长约 90 秒。</p>}
        <details><summary>查看固定题目</summary><ul>{suite.cases.map(item => <li key={item.id}><strong>{item.title}</strong>：{item.question}</li>)}</ul></details>
      </section>
      {report && <section className="knowledge-search"><div className="connection-title"><h2>{report.label}</h2><Tag color={report.summary.failed ? 'warning' : 'success'}>{report.summary.passed} / {report.summary.total} 规则通过</Tag></div>
        <p className="muted">{report.mode === 'fixture' ? '离线固定样例' : '当前模型'} · {report.target.model} · {dayjs(report.finishedAt).format('YYYY-MM-DD HH:mm:ss')} · 生成调用 {report.summary.generationCalls} 次</p>
        <p>逐题检查回答形态、引用契约和指定词语。语义支持未验证，规则通过仍可能有事实错误。</p>
        <div className="form-actions"><Button onClick={download}>下载 JSON 报告</Button><Button onClick={() => setRunId(reportId)}>查看评测运行</Button></div>
        <ul className="review-list">{report.cases.map(item => <li className="review-row" key={item.id}><div className="review-content"><details><summary><strong>{item.title}</strong> · {item.passed ? '规则通过' : '存在未通过项'}</summary><p>{item.question}</p>
          <ul>{item.checks.map(check => <li key={check.id}>{check.passed ? '通过' : '未通过'} · {check.label}</li>)}</ul>
          <p className="muted">运行：{item.actual.runStatus} · 回答：{item.actual.answerStatus || '无有效输出'} · {item.elapsedMs.toFixed(1)} ms</p>
          <pre className="json-view">{item.actual.text || '没有回答正文'}</pre><p>实际引用：{!item.actual.quotes.length && '无'}</p><ul>{item.actual.quotes.map((citation, index) => <li className="break-text" key={index}>{citation.path}：{citation.quote}</li>)}</ul>
          <p className="muted">生成调用 {item.actual.generationCalls} 次 · 输入 / 输出 Token：{item.actual.inputTokens ?? '未提供'} / {item.actual.outputTokens ?? '未提供'}</p>
          <details><summary>隔离题目执行轨迹</summary><p className="muted break-text">{item.caseRunId}。内部内存记录随本次评测销毁，以下轨迹保存于报告。</p><ul>{item.actual.trace.map((step, index) => <li className="break-text" key={index}>{step.kind} · {step.name} · {step.status}</li>)}</ul></details>
        </details></div><Tag color={item.passed ? 'success' : 'warning'}>{item.passed ? '通过' : '未通过'}</Tag></li>)}</ul>
        <details><summary>执行版本与耗时</summary><p className="break-text muted">题集：{report.suiteHash}<br />管线：{report.pipeline.sourceHash}<br />规则：{report.graderHash}</p><p className="muted">逐题耗时中位数 {report.summary.medianMs.toFixed(1)} ms · P95 {report.summary.p95Ms.toFixed(1)} ms。{report.mode === 'fixture' ? '包含本机检索与协议处理，不代表模型推理速度。' : '包含检索、模型与检查；单次运行不代表稳定性能。'}</p></details>
      </section>}
      <section className="knowledge-search"><h2>对比两次评测</h2><p className="muted">从最近 50 次根运行中选择。同一题集、同一规则版本、同一运行模式才可比较。</p>
        {!runs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有成功保存的评测报告" /> : <><div className="form-actions"><label htmlFor="evaluation-baseline">基准记录</label><Select id="evaluation-baseline" value={baseline} placeholder="选择基准" options={options} disabled={busy} onChange={value => { setBaseline(value); setComparison(null); }} /><label htmlFor="evaluation-candidate">候选记录</label><Select id="evaluation-candidate" value={candidate} placeholder="选择候选" options={options} disabled={busy} onChange={value => { setCandidate(value); setComparison(null); }} /><Button disabled={busy || !baseline || !candidate || baseline === candidate} onClick={compare}>比较记录</Button></div>
          <div className="form-actions"><label htmlFor="evaluation-report">打开已有报告</label><Select id="evaluation-report" value={reportId || undefined} placeholder="选择评测报告" options={options} disabled={busy} onChange={open} /></div></>}
        {comparison && <><h3>{comparison.baseline.label} → {comparison.candidate.label}</h3><p>规则通过题数变化：{comparison.passDelta > 0 ? '+' : ''}{comparison.passDelta}</p><ul>{comparison.cases.filter(item => item.change !== 'unchanged').map(item => <li key={item.id}>{item.title} · {item.change === 'regressed' ? '新增失败' : '恢复通过'}</li>)}</ul><p className="muted">模型变化：{comparison.changed.model ? '是' : '否'} · 管线变化：{comparison.changed.pipeline ? '是' : '否'} · 固定样例变化：{comparison.changed.fixture ? '是' : '否'}。差异不能直接归因于单个改动，也不证明语义质量提高。</p></>}
      </section>
    </>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
