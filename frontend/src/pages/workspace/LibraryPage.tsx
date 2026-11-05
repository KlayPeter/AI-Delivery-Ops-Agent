import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Empty, Form, Input, List, Skeleton, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { FileSearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface LibraryItem { id: string; title: string; runId: string; savedAt: string; sourceCapability: string; modified: boolean }
export default function LibraryPage() {
  const { data: workspace, mutate } = useWorkspace();
  const { data, error: listError, isLoading, mutate: refresh } = useSWR<{ items: LibraryItem[] }>('knowledge-library', api.fetchLibrary);
  const [running, setRunning] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const search = async ({ query }: { query: string }) => {
    setRunning(true); setError('');
    try { const result = await api.runAgent('knowledge.library.manage', { operation: 'search', query: query.trim(), limit: 5 }, crypto.randomUUID()); setRunId(result.runId); await mutate(); }
    catch (e) { setError(errorMessage(e)); } finally { setRunning(false); }
  };
  const useAsSource = async () => {
    setSaving(true); setError('');
    try { await api.saveConnections({ KNOWLEDGE_KIND: 'library' }); setNotice('资料库已保存为知识来源，重启本地后端后，可在知识库中生成引用回答和检查引用变化。'); }
    catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>资料库</h1><p>收录值得保留的网页和文档，让后续任务有资料可用。</p></div><Button onClick={() => refresh()}>刷新资料</Button></div>
    {notice && <Alert type="success" showIcon title="知识来源已保存" description={notice} />}
    {error && <Alert type="error" showIcon title="操作失败" description={error} />}
    <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><FileSearchOutlined aria-hidden /></span><h2>检索已收录的资料</h2></div>
      <Form layout="vertical" onFinish={search}><Form.Item name="query" label="关键词或问题" rules={[{ required: true, whitespace: true, message: '请输入关键词或问题' }]}><Input placeholder="输入想查找的内容…" maxLength={500} /></Form.Item>
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={running}>检索原文</Button>{!workspace?.managedByPluginFile && <Button onClick={useAsSource} loading={saving}>设为知识来源</Button>}</div>
      </Form>
      <p className="muted">原文检索无需模型。设为知识来源后，知识库使用这些资料；生成回答需要你配置的模型。</p>
    </section>
    {listError ? <Alert type="error" showIcon title="资料列表加载失败" description="检查本地后端和资料目录后重试。" action={<Button onClick={() => refresh()}>重试</Button>} /> : isLoading ? <Skeleton active /> : <section className="knowledge-search">
      <h2>已收录资料 <span className="muted">{data?.items.length || 0}</span></h2>
      {!data?.items.length ? <Empty description="还没有收录资料。在网页或文档的成功结果中，点击“收录到资料库”。"><div className="form-actions">{workspace?.pages.some(page => page.path === '/capture') && <Link className="primary-link" to="/capture">收集网页</Link>}{workspace?.pages.some(page => page.path === '/documents') && <Link className="primary-link" to="/documents">导入文档</Link>}</div></Empty>
        : <List dataSource={data.items} renderItem={item => <List.Item actions={[<Button key="source" onClick={() => setRunId(item.runId)}>查看原始结果</Button>]}><List.Item.Meta title={item.title} description={<>{item.sourceCapability === 'knowledge.page.capture' ? '网页资料' : '本地文档'} · {dayjs(item.savedAt).format('YYYY-MM-DD HH:mm')}{item.modified && <> · <Tag color="warning">收录后有改动</Tag></>}</>} /></List.Item>} />}
      <p className="muted">资料保存于应用的本地目录，保留原始运行和内容指纹。重复收录不会新增副本或覆盖已有改动。</p>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => { setRunId(null); refresh(); }} onSelectRun={setRunId} />
  </div>;
}
