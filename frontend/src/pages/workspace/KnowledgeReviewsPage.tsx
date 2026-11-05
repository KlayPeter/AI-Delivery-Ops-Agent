import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Alert, Button, Checkbox, Empty, Input, Pagination, Select, Skeleton, Tag } from 'antd';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '@/api';
import { capabilityName, errorMessage, useWorkspace } from './state';
import { filterReviews, reviewLabels, reviewState, selectedReviewIds, type KnowledgeReview } from './knowledgeReviews';
import RunDrawer from './RunDrawer';

const colors: Record<string, string> = { needs_review: 'warning', current: 'success', unverifiable: 'warning' };
export default function KnowledgeReviewsPage() {
  const { data: workspace, mutate: refreshWorkspace } = useWorkspace();
  const candidates = (workspace?.runs || []).filter(run => run.status === 'succeeded' && ['knowledge.answer', 'release.prepare'].includes(run.capability)).map(run => run.id);
  const { data, error: loadingError, isLoading, isValidating, mutate: refresh } = useSWR<{ reviews: KnowledgeReview[] }>(candidates.length ? ['knowledge-reviews', candidates] : null, () => api.fetchKnowledgeReviews(candidates));
  const { mutate } = useSWRConfig();
  const [query, setQuery] = useState(''), [state, setState] = useState('all'), [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string[]>([]), [checking, setChecking] = useState(false), [error, setError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const reviews = data?.reviews || [], filtered = filterReviews(reviews, query, state);
  const selected = selectedReviewIds(filtered, picked), currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 10)));
  const canRun = workspace?.agents.some(agent => agent.status === 'active' && agent.capabilities.includes('knowledge.impact.check'));
  const reset = () => { setPicked([]); setPage(1); };
  const check = async () => {
    if (!selected.length || checking) return;
    setChecking(true); setError('');
    try {
      const result = await api.runAgent('knowledge.impact.check', { runIds: selected, operation: 'check' }, crypto.randomUUID());
      if (!result.runId) throw new Error('未返回检查记录，请先查看运行历史，避免重复提交。');
      setRunId(result.runId); setPicked([]);
      if (result.status === 'failed' || result.status === 'cancelled') setError('本次检查未完成，请查看检查记录中的错误与执行步骤。');
    } catch (e) { setError(errorMessage(e)); }
    finally {
      await Promise.allSettled([refresh(), refreshWorkspace(), mutate(key => Array.isArray(key) && key[0] === 'run-actions' && selected.includes(String(key[1])))]);
      setChecking(false);
    }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>知识复核</h1><p>资料更新后，找出需要重新确认的历史回答与发布草稿。</p></div><Button loading={isValidating} disabled={checking} onClick={() => { refresh(); refreshWorkspace(); }}>刷新列表</Button></div>
    <p className="muted">列出最近 50 次根运行中的成功知识回答与发布草稿。状态仅代表上次检查；刷新列表不会读取来源或自动重新检查。</p>
    {error && <Alert type="error" showIcon title="检查未完成" description={error} />}
    {loadingError ? <Alert type="error" showIcon title="历史引用加载失败" description={errorMessage(loadingError)} action={<Button onClick={() => refresh()}>重试</Button>} /> : isLoading ? <Skeleton active /> : !reviews.length ? <Empty description="最近记录中还没有可复核的知识回答或发布草稿"><Link to="/">去发起任务</Link></Empty> : <>
      <div className="review-filters">
        <div><label htmlFor="review-query">搜索运行或引用路径</label><Input id="review-query" value={query} allowClear placeholder="运行 ID、笔记路径或网页地址" disabled={checking} onChange={event => { setQuery(event.target.value); reset(); }} /></div>
        <div><label htmlFor="review-state">上次检查状态</label><Select id="review-state" value={state} disabled={checking} onChange={value => { setState(value); reset(); }} options={[{ value: 'all', label: '全部状态' }, ...Object.entries(reviewLabels).map(([value, label]) => ({ value, label }))]} /></div>
      </div>
      <div className="review-toolbar"><div className="form-actions"><Button disabled={checking || !canRun || !filtered.some(review => review.canCheck)} onClick={() => setPicked(filtered.filter(review => review.canCheck).slice(0, 20).map(review => review.id))}>选择筛选结果的前 20 条</Button><Button disabled={checking || !selected.length} onClick={() => setPicked([])}>清空选择</Button></div><div className="form-actions"><span className="muted" role="status" aria-atomic="true">已选择 {selected.length} 条，最多 20 条</span><Button type="primary" loading={checking} disabled={!canRun || !selected.length} onClick={check}>检查所选引用</Button></div></div>
      {!canRun && <Alert type="warning" title="复核 Agent 当前未启用，可先查看历史记录。" showIcon />}
      <ul className="review-list" aria-label="历史知识引用">
        {filtered.slice((currentPage - 1) * 10, currentPage * 10).map(review => {
          const status = reviewState(review);
          return <li className="review-row" key={review.id}>
            <Checkbox aria-label={`选择运行 ${review.id}`} checked={selected.includes(review.id)} disabled={checking || !canRun || !review.canCheck || (selected.length >= 20 && !selected.includes(review.id))} onChange={event => setPicked(event.target.checked ? [...selected, review.id] : selected.filter(id => id !== review.id))} />
            <div className="review-content"><div className="review-heading"><strong>{capabilityName(review.capability)}</strong><Tag color={colors[status]}>{review.assessment.reason === 'check_incomplete' ? '上次检查未完成' : reviewLabels[status]}</Tag></div>
              <p className="muted break-text">{dayjs(review.createdAt).format('YYYY-MM-DD HH:mm')} · {review.id.slice(0, 8)}</p>
              <ul className="review-paths">{review.references.slice(0, 2).map((reference, index) => <li key={index} className="break-text">{reference.sourceKind === 'web' ? '网页' : reference.sourceKind === 'markdown' ? '笔记' : '历史引用'} · {reference.path}</li>)}</ul>
              <p className="muted">{review.references.length ? `共引用 ${review.references.length} 个文档版本` : review.canCheck ? '历史引用需要检查' : status === 'not_applicable' ? '原结果没有实际引用知识文档' : '历史结果格式无法核验，请查看原结果'}{review.assessment.checkedAt && <> · <span className="review-time">上次检查 <time dateTime={review.assessment.checkedAt}>{dayjs(review.assessment.checkedAt).format('YYYY-MM-DD HH:mm:ss')}</time></span></>}</p>
            </div>
            <div className="review-links"><Button onClick={() => setRunId(review.id)} aria-label={`查看原结果 ${review.id}`}>查看原结果</Button>{review.assessment.checkRunId && <Button type="link" onClick={() => setRunId(review.assessment.checkRunId!)} aria-label={`查看检查记录 ${review.assessment.checkRunId}`}>查看检查记录</Button>}</div>
          </li>;
        })}
      </ul>
      {!filtered.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的历史结果，试试其他路径或状态" />}
      {filtered.length > 10 && <Pagination current={currentPage} pageSize={10} total={filtered.length} showSizeChanger={false} onChange={setPage} disabled={checking} />}
      <p className="muted">检查会读取当前所选来源，公开网页可能产生网络请求。不调用模型、不重写原结果；版本一致也不代表结论语义正确。</p>
    </>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
