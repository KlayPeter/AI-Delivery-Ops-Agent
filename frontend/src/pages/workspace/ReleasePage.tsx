import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Form, Input, List, Tag } from 'antd';
import { FileSearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/api';
import { errorMessage, useConnections, useWorkspace } from './state';
import { prepareReleaseInput } from './releaseInput';
import RunDrawer, { RunStatus } from './RunDrawer';

interface Values { since: string; until?: string; policyQuery: string }
export default function ReleasePage() {
  const { data: workspace, mutate } = useWorkspace();
  const { data: connections } = useConnections();
  const [form] = Form.useForm<Values>();
  const [running, setRunning] = useState<'collect' | 'prepare' | null>(null);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const enabled = workspace?.agents.some(agent => agent.status === 'active' && agent.capabilities.includes('release.prepare'));
  const sourceDependencies = workspace?.plugins.find(plugin => plugin.id === 'release.prepare')?.requires || [];
  const sourceLabel = sourceDependencies.includes('knowledge.mixed') ? '已选笔记与公开网页' : sourceDependencies.includes('knowledge.web') ? '已选公开网页'
    : sourceDependencies.includes('knowledge.markdown') ? (workspace?.knowledgeKind === 'sample' ? '虚构示例笔记' : '已选 Markdown / Obsidian 目录') : '该插件明确配置的知识来源';
  const runs = workspace?.runs.filter(run => run.capability === 'release.prepare') || [];
  const execute = async (operation: 'collect' | 'prepare') => {
    setError(''); setRunning(operation);
    try {
      const values = await form.validateFields();
      const result = await api.runAgent('release.prepare', prepareReleaseInput(values, operation), crypto.randomUUID());
      setRunId(result.runId); await mutate();
    } catch (e) { if (!(e && typeof e === 'object' && 'errorFields' in e)) setError(errorMessage(e)); }
    finally { setRunning(null); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>发布准备</h1><p>对照你的发布规则和仓库变更，整理证据、草稿与待确认项。</p></div><Tag>只读</Tag></div>
    {workspace?.managedByPluginFile ? <Alert type="info" showIcon title="来源由自定义插件配置管理" description="仓库和知识来源以 AGENT_PLUGINS_FILE 为准，页面保存的连接设置不会覆盖该组合。" />
      : connections?.restartRequired && <Alert type="warning" showIcon title="连接配置等待重启生效" description="本次任务仍使用启动时的仓库和知识来源。" />}
    <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><FileSearchOutlined aria-hidden /></span><h2>准备这次发布</h2></div>
      <p className="muted">读取固定仓库在时间段内合并的 PR，以及当前开放的 Issue。规则来自{sourceLabel}。<Link to="/connections">配置仓库</Link> · <Link to={workspace?.pages.some(page => page.path === '/knowledge') ? '/knowledge' : '/plugins'}>查看个人规则配置</Link></p>
      <Form form={form} layout="vertical" initialValues={{ since: dayjs().subtract(7, 'day').format('YYYY-MM-DDTHH:mm'), policyQuery: '发布规则 API 迁移' }} onFinish={() => execute('collect')}>
        <div className="connection-fields">
          <Form.Item name="since" label="合并开始时间" rules={[{ required: true, message: '请选择开始时间' }]}><Input type="datetime-local" /></Form.Item>
          <Form.Item name="until" label="合并结束时间（可选）" extra="本地时间；不填则截至本轮采集时刻。"><Input type="datetime-local" /></Form.Item>
        </div>
        <Form.Item name="policyQuery" label="个人规则关键词" extra="例如：API 变更、迁移说明、发布检查。关键词检索不会读取整座知识库。" rules={[{ required: true, whitespace: true, message: '请填写规则关键词' }]}><Input maxLength={500} /></Form.Item>
        {error && <Alert type="error" showIcon title="任务未能发起" description={error} />}
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={running === 'collect'} disabled={!enabled || running === 'prepare'}>收集证据</Button><Button onClick={() => execute('prepare')} loading={running === 'prepare'} disabled={!enabled || running === 'collect' || !workspace?.modelConfigured}>生成发布草稿</Button></div>
        <p className="muted">收集证据不调用模型。生成草稿会把选中的仓库事实与个人规则片段发送给已配置模型，结果始终需要人工复核。</p>
        {!workspace?.modelConfigured && <p className="muted">生成草稿前请先<Link to="/connections">连接模型</Link>。</p>}
      </Form>
    </section>
    <section className="runs-section" aria-labelledby="release-history-title">
      <div className="section-heading"><h2 id="release-history-title">最近发布准备</h2><Link to="/runs">全部运行</Link></div>
      <List dataSource={runs.slice(0, 8)} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从收集证据开始，结果和执行步骤会保存在这里。" /> }} renderItem={run => <List.Item actions={[<Button key="view" type="link" onClick={() => setRunId(run.id)}>查看结果</Button>]}>
        <List.Item.Meta title={<button className="run-link" onClick={() => setRunId(run.id)}>{dayjs(run.createdAt).format('MM-DD HH:mm')} · {run.id.slice(0, 8)}</button>} description={<RunStatus status={run.status} />} />
      </List.Item>} />
    </section>
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
