import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Alert, Button } from 'antd';
import dayjs from 'dayjs';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import type { StatusPanel } from './panels';

export function StatusPanelView({ panel, onSelectRun, children }: { panel: StatusPanel; onSelectRun: (id: string) => void; children?: ReactNode }) {
  return <section className="run-action-panel">
    <Alert type={panel.tone === 'neutral' ? 'info' : panel.tone} title={panel.title} description={panel.description} showIcon />
    {panel.checkedAt && <p className="muted">检查时间：{dayjs(panel.checkedAt).format('YYYY-MM-DD HH:mm:ss')} · 显示该次检查结果</p>}
    {panel.items?.length ? <ul className="action-items">{panel.items.map((item, index) => <li key={index}><div className="action-item-heading"><strong>{item.label}</strong><span>{item.value}</span></div>{item.detail && <div className="muted">{item.detail}</div>}</li>)}</ul> : null}
    <div className="form-actions">{children}{panel.relatedRun && <Button type="link" onClick={() => onSelectRun(panel.relatedRun!.id)}>{panel.relatedRun.label}</Button>}</div>
  </section>;
}

interface Action { id: string; label: string; description?: string; available: boolean; panel: StatusPanel }
export default function RunActions({ runId, onSelectRun }: { runId: string; onSelectRun: (id: string) => void }) {
  const [running, setRunning] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const { mutate: refreshWorkspace } = useWorkspace();
  const { data, error, mutate } = useSWR<{ actions: Action[] }>(['run-actions', runId], () => api.fetchRunActions(runId), { refreshInterval: running ? 2000 : 0 });
  const execute = async (action: Action) => {
    setRunning(action.id); setActionError('');
    try {
      const result = await api.runAction(runId, action.id, crypto.randomUUID());
      if (!['succeeded', 'duplicate'].includes(result.status)) setActionError('后续动作未完成，请在运行记录中查看检查详情。');
    } catch (e) { setActionError(errorMessage(e)); }
    finally { await Promise.allSettled([mutate(), refreshWorkspace()]); setRunning(null); }
  };
  return <div aria-live="polite">
    {error && <Alert type="error" title="后续动作加载失败" action={<Button onClick={() => mutate()}>重试</Button>} />}
    {actionError && <Alert type="error" title="操作未完成" description={actionError} showIcon />}
    {!error && data?.actions.map(action => <StatusPanelView key={action.id} panel={running === action.id ? { schemaVersion: '1.0', tone: 'neutral', title: '正在执行后续动作', description: '完成后显示本次检查结果。' } : action.panel} onSelectRun={onSelectRun}>
      <Button onClick={() => execute(action)} loading={running === action.id} disabled={Boolean(running && running !== action.id) || !action.available} title={action.available ? action.description : '当前运行范围未启用此能力'}>{action.label}</Button>
      <Button type="text" aria-label={`刷新${action.label}状态`} icon={<ReloadOutlined aria-hidden />} onClick={() => mutate()} disabled={Boolean(running)}>刷新状态</Button>
    </StatusPanelView>)}
  </div>;
}
