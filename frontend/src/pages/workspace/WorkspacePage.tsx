import { useState } from 'react';
import useSWR from 'swr';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Collapse, Empty, Input, Select, Skeleton, Table } from 'antd';
import { ArrowRightOutlined, ArrowUpOutlined, FileSearchOutlined, RobotOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/api';
import { capabilityName, errorMessage, needsModel, useWorkspace, type RunInfo } from './state';
import { prepareInput } from './input';
import RunDrawer, { RunStatus } from './RunDrawer';

export default function WorkspacePage({ history = false }: { history?: boolean }) {
  const { data, error, isLoading, mutate } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [prompt, setPrompt] = useState(params.get('query') || '');
  const [jsonInput, setJsonInput] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string>();
  const [filter, setFilter] = useState('');
  const capability = params.get('capability') || 'delivery.ops.orchestrate';
  const agent = data?.agents.find(item => item.capabilities.includes(capability));
  const retrieval = data?.agents.flatMap(item => item.capabilities).find(value => ['knowledge.markdown.retrieve', 'knowledge.web.retrieve'].includes(value));
  const groupTask = ['summary.daily.generate', 'summary.weekly.generate', 'dashboard.project.generate'].includes(capability);
  const { data: config } = useSWR(groupTask ? 'workspace-team-config' : null, api.fetchConfig);
  const requiresModel = needsModel(agent);
  const selectCapability = (value: string) => { setParams({ capability: value }, { replace: true }); setJsonInput(''); setRunError(''); };
  const execute = async () => {
    setRunning(true); setRunError('');
    try {
      const input = jsonInput.trim() ? JSON.parse(jsonInput) : groupTask
        ? { groupId, dayIso: new Date().toISOString(), cutoffAt: new Date().toISOString(), period: 'current_week', sendToGroup: false }
        : prepareInput(capability, prompt);
      const result = await api.runAgent(capability, input, crypto.randomUUID());
      setRunId(result.runId); await mutate();
    } catch (e) { setRunError(errorMessage(e)); }
    finally { setRunning(false); }
  };
  const runs = (data?.runs || []).filter(run => `${capabilityName(run.capability, data?.agents.find(item => item.capabilities.includes(run.capability))?.name)} ${run.id} ${run.status}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>{history ? '运行记录' : '工作台'}</h1><p>{history ? '查看最近 50 次任务的状态、执行步骤和产物。' : '把工作交给 Agent，让每一步都有迹可循。'}</p></div>
      {history && <Link className="primary-link" to="/">新建任务 <ArrowRightOutlined aria-hidden /></Link>}
    </div>
    {error && <Alert type="error" showIcon title="无法连接本地后端" description={error.message} action={<Button onClick={() => mutate()}>重试</Button>} />}
    {isLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : <>
      {!history && <>
        <section className="task-composer" aria-labelledby="new-task-title">
          <div className="composer-heading"><div className="icon-tile"><RobotOutlined aria-hidden /></div><h2 id="new-task-title">发起一个任务</h2><span className="muted">本地工作区</span></div>
          <label className="sr-only" htmlFor="task-prompt">任务内容</label>
          <Input.TextArea id="task-prompt" className="task-input" value={prompt} onChange={e => setPrompt(e.target.value)} autoSize={{ minRows: 4, maxRows: 12 }} maxLength={4000} placeholder={capability === 'knowledge.impact.check' ? '填写历史回答或发布草稿的运行 ID，多项用逗号或空格分隔…' : capability.startsWith('knowledge.') ? '输入你想检索或回答的问题…' : '描述你想完成的工作，例如：帮我梳理本周项目的风险与下一步安排…'} />
          {groupTask && <div className="group-picker"><label htmlFor="run-group">目标团队</label><Select id="run-group" placeholder="选择已配置的群组" value={groupId} onChange={setGroupId} options={(config?.groups || []).map((g: { chat_id: string; name?: string }) => ({ value: g.chat_id, label: g.name || g.chat_id }))} notFoundContent={<Link to="/config">先配置团队</Link>} /></div>}
          <div className="composer-footer"><div className="agent-picker"><label htmlFor="task-agent">执行能力</label><Select id="task-agent" value={capability} onChange={selectCapability} options={data?.agents.filter(a => a.status === 'active').flatMap(a => a.capabilities.map(value => ({ value, label: capabilityName(value, a.name) })))} /></div>
            <Button type="primary" icon={<ArrowUpOutlined aria-hidden />} loading={running} onClick={execute} disabled={!agent || (!jsonInput.trim() && (groupTask ? !groupId : !prompt.trim())) || Boolean(requiresModel && !data?.modelConfigured)}>开始执行</Button>
          </div>
          {requiresModel && !data?.modelConfigured && <div className="composer-notice">此能力需要模型服务。<Link to="/connections">去连接模型 <ArrowRightOutlined aria-hidden /></Link>，也可以先体验下方的笔记检索。</div>}
          {capability === 'knowledge.impact.check' && <div className="composer-notice">也可以在<Link to="/runs">历史结果详情</Link>中直接点击「检查引用变化」。</div>}
          <Collapse ghost className="advanced-input" items={[{ key: 'input', label: '高级任务参数', children: <><p className="muted">为已安装插件提供结构化输入；填写后替代上方任务描述。</p><Input.TextArea aria-label="JSON 任务参数" value={jsonInput} onChange={e => setJsonInput(e.target.value)} placeholder={'{ "prompt": "任务描述" }'} rows={4} /></> }]} />
        </section>
        {runError && <Alert type="error" showIcon title="任务未能发起" description={runError} />}
        <div className="quick-actions">
          {retrieval ? <button onClick={() => { selectCapability(retrieval); setPrompt('API 迁移说明'); }}><FileSearchOutlined aria-hidden /><span><strong>从知识库开始</strong><small>检索已有笔记，查看原文证据</small></span><ArrowRightOutlined aria-hidden /></button> : <Link to="/knowledge"><FileSearchOutlined aria-hidden /><span><strong>配置知识来源</strong><small>查看当前知识插件配置</small></span><ArrowRightOutlined aria-hidden /></Link>}
          <Link to="/agents"><RobotOutlined aria-hidden /><span><strong>选择专业 Agent</strong><small>查看当前可用能力与执行方式</small></span><ArrowRightOutlined aria-hidden /></Link>
        </div>
      </>}
      <section className="runs-section" aria-labelledby="recent-runs-title">
        <div className="section-heading"><h2 id="recent-runs-title">{history ? '全部运行' : '最近运行'}</h2><div className="section-actions">{history ? <Input.Search aria-label="搜索运行记录" placeholder="搜索任务或运行 ID" value={filter} onChange={e => setFilter(e.target.value)} /> : <Link to="/runs">查看全部</Link>}<Button type="text" aria-label="刷新运行记录" icon={<ReloadOutlined aria-hidden />} onClick={() => mutate()} /></div></div>
        <Table<RunInfo> rowKey="id" size="middle" dataSource={history ? runs : runs.slice(0, 6)} pagination={history ? { pageSize: 10, hideOnSinglePage: true } : false} scroll={{ x: 580 }} columns={[
          { title: '任务', key: 'task', render: (_, run) => <button className="run-link" onClick={() => setRunId(run.id)}><strong>{capabilityName(run.capability, data?.agents.find(item => item.capabilities.includes(run.capability))?.name)}</strong><span>{run.id.slice(0, 8)}</span></button> },
          { title: '状态', dataIndex: 'status', render: status => <RunStatus status={status} /> },
          { title: '发起时间', dataIndex: 'createdAt', render: value => dayjs(value).format('MM-DD HH:mm') },
          { title: '操作', key: 'action', render: (_, run) => <Button type="link" onClick={() => setRunId(run.id)}>查看详情</Button> },
        ]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>还没有运行记录</strong><p>发起第一个任务后，执行过程和结果会保存在这里。</p></>} /> }} />
      </section>
    </>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
