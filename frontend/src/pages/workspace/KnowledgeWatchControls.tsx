import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Select, Skeleton, Tag } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';
import { errorMessage } from './state';
import { reviewLabels, reviewState, type KnowledgeReview } from './knowledgeReviews';

interface WatchPlan { enabled: boolean; runIds: string[]; intervalMinutes: number; nextCheckAt: string; lastAttemptAt?: string; lastCheckRunId?: string; lastRunStatus?: string; lastError?: string }
export default function KnowledgeWatchControls({ selected, blocked, onSelectRun }: { selected: string[]; blocked: boolean; onSelectRun: (id: string) => void }) {
  const { data, error: loadError, isLoading, mutate } = useSWR<{ plan: WatchPlan | null; reviews: KnowledgeReview[]; unavailable: string }>('knowledge-watch', api.fetchKnowledgeWatch, { refreshInterval: 10_000 });
  const [interval, setInterval] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const plan = data?.plan, minutes = interval ?? plan?.intervalMinutes ?? 60;
  const targets = selected.length ? selected : plan?.runIds || [];
  const saveLabel = !plan ? '为所选结果开启计划' : selected.length ? '用所选结果更新计划'
    : plan.enabled ? '更新原计划频率' : '按此频率启用原计划';
  const save = async (runIds: string[]) => {
    setBusy(true); setError('');
    try { await api.saveKnowledgeWatch({ runIds, intervalMinutes: minutes }); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const pause = async () => {
    setBusy(true); setError('');
    try { await api.pauseKnowledgeWatch(); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <section className="knowledge-search" aria-label="知识定期复核计划">
    <h2>定期复核 <Tag>{plan?.enabled ? '已启用' : plan ? '已暂停' : '未启用'}</Tag></h2>
    <p className="muted">为下方所选结果设置复核频率，最多 20 条。按计划读取引用来源，保存独立检查与原结果；公开网页会产生读取请求，检查无需模型。本地服务关闭期间暂停，恢复后至多补一次到期检查。</p>
    {loadError ? <Alert type="error" title="计划加载失败" description={errorMessage(loadError)} action={<Button onClick={() => mutate()}>重试</Button>} /> : isLoading ? <Skeleton active paragraph={{ rows: 1 }} /> : <>
      <label htmlFor="knowledge-watch-interval">复核频率</label>
      <Select id="knowledge-watch-interval" style={{ width: 160 }} value={minutes} disabled={busy || blocked} onChange={setInterval} options={[{ value: 1, label: '每分钟' }, { value: 15, label: '每 15 分钟' }, { value: 60, label: '每小时' }, { value: 1440, label: '每 24 小时' }]} />
      <div className="form-actions"><Button type="primary" disabled={busy || blocked || !targets.length} loading={busy} onClick={() => save(targets)}>{saveLabel}</Button>{plan?.enabled && <Button disabled={busy} onClick={pause}>暂停计划</Button>}</div>
      {plan && <>
        <p className="muted">计划包含 {plan.runIds.length} 条结果。{plan.enabled ? <>下一次到期 <time dateTime={plan.nextCheckAt}>{dayjs(plan.nextCheckAt).format('YYYY-MM-DD HH:mm:ss')}</time>，服务约每 30 秒查看到期计划。</> : '已暂停后续检查，正在执行的检查会保留。'}{plan.lastAttemptAt && <> 上次发起 {dayjs(plan.lastAttemptAt).format('YYYY-MM-DD HH:mm:ss')}。</>}</p>
        {plan.lastError && <Alert type="warning" showIcon title="定期检查未完成" description={plan.lastError} />}
        {plan.lastRunStatus === 'running' && <p role="status">上次检查尚未记录完成状态，实际执行记录以运行历史为准。</p>}
        {plan.lastCheckRunId && <Button type="link" onClick={() => onSelectRun(plan.lastCheckRunId!)}>查看上次定期检查</Button>}
        <details><summary>查看计划中的结果与上次评估</summary><ul>{plan.runIds.map(id => {
          const review = data?.reviews.find(item => item.id === id);
          return <li key={id}><Button type="link" onClick={() => onSelectRun(id)} aria-label={`查看计划原结果 ${id}`}>{id.slice(0, 8)}</Button>{review && <><Tag>{reviewLabels[reviewState(review)]}</Tag>{review.assessment.checkedAt && <span className="muted">检查于 {dayjs(review.assessment.checkedAt).format('YYYY-MM-DD HH:mm:ss')}</span>}</>}</li>;
        })}</ul></details>
      </>}
      {data?.unavailable && <Alert type="warning" title={data.unavailable} />}
    </>}
    {error && <Alert type="error" showIcon title="计划未更新" description={error} />}
  </section>;
}
