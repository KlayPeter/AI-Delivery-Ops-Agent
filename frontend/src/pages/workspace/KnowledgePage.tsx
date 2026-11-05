import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Drawer, Form, Input, Select, Skeleton, Tag } from 'antd';
import { FileSearchOutlined, FolderOutlined, SettingOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useConnections, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface KnowledgeWorkspace { kind: 'sample' | 'markdown' | 'web'; pluginId: string; capability: string }
export default function KnowledgePage() {
  const { data: workspace, mutate } = useWorkspace();
  const { data, error, isLoading, mutate: refreshConnections } = useConnections();
  const { data: source, error: sourceError, isLoading: sourceLoading, mutate: refreshSource } = useSWR<KnowledgeWorkspace>('knowledge-workspace', api.fetchKnowledgeWorkspace, { refreshInterval: 5000 });
  const [form] = Form.useForm();
  const kind = Form.useWatch('KNOWLEDGE_KIND', form) || data?.values.KNOWLEDGE_KIND || 'sample';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const retrieval = !sourceError && source && workspace?.agents.some(agent => agent.status === 'active' && agent.capabilities.includes(source.capability)) ? source.capability : undefined;
  const canAnswer = Boolean(retrieval && workspace?.agents.some(agent => agent.status === 'active' && agent.capabilities.includes('knowledge.answer')) && workspace.plugins.some(plugin => plugin.id === 'knowledge.answer' && plugin.requires?.includes(source?.pluginId || '')));
  const execute = async (answer = false) => {
    if (!retrieval || !query.trim() || (answer && !canAnswer)) return;
    setRunning(true); setActionError('');
    try {
      const result = await api.runAgent(answer ? 'knowledge.answer' : retrieval, answer ? { question: query.trim(), limit: 5 } : { operation: 'search', query: query.trim(), limit: 5 }, crypto.randomUUID());
      setRunId(result.runId); await mutate();
    } catch (e) { setActionError(errorMessage(e)); } finally { setRunning(false); }
  };
  const save = async (values: Record<string, string>) => {
    setSaving(true); setActionError('');
    try { const next = await api.saveConnections(values); await refreshConnections(next, false); setNotice('知识来源已保存，重启本地后端后生效。'); setSettingsOpen(false); }
    catch (e) { setActionError(errorMessage(e)); } finally { setSaving(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>知识库</h1><p>让 Agent 使用你的笔记与资料，结果保留可追溯的原文引用。</p></div><Button icon={<SettingOutlined aria-hidden />} onClick={() => setSettingsOpen(true)} disabled={!data || workspace?.managedByPluginFile}>配置来源</Button></div>
    {error && <Alert type="error" title="知识配置加载失败" description={error.message} />}
    {sourceError && <Alert type="error" showIcon title="知识来源加载失败" description="无法确认当前插件选择的来源，请重试。" action={<Button onClick={() => refreshSource()}>重试</Button>} />}
    {notice && <Alert type="success" title={notice} showIcon />}
    {data?.restartRequired && !notice && <Alert type="warning" title="本地配置等待重启后端生效，当前仍使用已加载的来源" showIcon />}
    {workspace?.managedByPluginFile && <Alert type="info" title="知识插件由自定义插件配置管理" description="请修改插件配置文件并重启本地后端来调整来源。" showIcon />}
    {isLoading || sourceLoading ? <Skeleton active /> : <>
      <section className="knowledge-search">
        <div className="connection-title"><span className="icon-tile"><FileSearchOutlined aria-hidden /></span><h2>从资料中找答案</h2></div>
        <label htmlFor="knowledge-query">你想了解什么？</label><Input.TextArea id="knowledge-query" placeholder="输入问题或关键词…" value={query} onChange={e => setQuery(e.target.value)} rows={3} maxLength={500} />
        <div className="form-actions"><Button type="primary" onClick={() => execute()} loading={running} disabled={!retrieval || !query.trim()}>检索原文</Button><Button onClick={() => execute(true)} disabled={running || !query.trim() || !workspace?.modelConfigured || !canAnswer}>生成引用回答</Button></div>
        <p className="muted">检索原文不调用模型。生成回答会将选中片段发送给你配置的模型。</p>
        {source && workspace?.plugins.some(plugin => plugin.id === 'knowledge.answer' && !plugin.requires?.includes(source.pluginId)) && <p className="muted">当前回答插件使用其他知识来源，本页仅开放原文检索。请在插件配置中选择相同来源。</p>}
      </section>
      {actionError && <Alert type="error" showIcon title="操作失败" description={actionError} />}
      <section className="source-card"><div className="icon-tile"><FolderOutlined aria-hidden /></div><div><h2>{!retrieval ? '来源暂不可用' : source?.kind === 'sample' ? '示例笔记' : source?.kind === 'web' ? '公开网页' : '个人笔记目录'}</h2><p className="muted">{!retrieval ? '请检查插件装配与本地后端连接。' : source?.kind === 'sample' ? '仓库内的虚构资料，可直接体验检索，无需密钥。' : '只读来源；每次检索刷新索引，保留内容版本。'}</p>{source?.kind === 'sample' && <Button type="link" onClick={() => setQuery('API 迁移说明')}>试试「API 迁移说明」</Button>}</div><Tag>{retrieval ? '已装配' : '不可用'}</Tag></section>
    </>}
    <Drawer title="配置知识来源" open={settingsOpen} onClose={() => setSettingsOpen(false)} size="large">
      {data && <Form layout="vertical" form={form} initialValues={{ ...data.values, KNOWLEDGE_KIND: data.values.KNOWLEDGE_KIND || 'sample' }} onFinish={save}>
        <Form.Item name="KNOWLEDGE_KIND" label="来源类型"><Select options={[{ value: 'sample', label: '示例笔记' }, { value: 'markdown', label: 'Markdown / Obsidian 文件夹' }, { value: 'web', label: '公开网页链接' }]} /></Form.Item>
        {kind === 'markdown' && <><Form.Item name="KNOWLEDGE_ROOT" label="本机目录" rules={[{ required: true, message: '请填写笔记目录的绝对路径' }]}><Input placeholder="/Users/你的名字/Notes" /></Form.Item><Form.Item name="KNOWLEDGE_VAULT_NAME" label="Obsidian Vault 名称（可选）"><Input /></Form.Item><Form.Item name="KNOWLEDGE_EXCLUDE" label="排除的子目录" extra="每行一个相对目录，如 Private。隐藏文件和符号链接自动跳过。"><Input.TextArea rows={3} /></Form.Item></>}
        {kind === 'web' && <Form.Item name="KNOWLEDGE_URLS" label="公开链接" rules={[{ required: true, message: '请填写链接' }]} extra="每行一个，最多 5 个；读取所选单页。"><Input.TextArea rows={5} placeholder="https://example.com/docs" /></Form.Item>}
        {actionError && <Alert type="error" title={actionError} />}
        <p className="muted">来源配置保存在本机，重启后端后生效。笔记内容始终只读。</p><Button type="primary" htmlType="submit" loading={saving}>保存来源</Button>
      </Form>}
    </Drawer>
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
