import { useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Tag } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface Tool { name: string; alias: string; description: string; readOnlyHint: boolean; inputSchema: unknown; outputSchema?: unknown; issue?: string }
interface Catalog { serverId: string; url: string; checkedAt: string; server: { name: string; version: string }; tools: Tool[] }
export default function McpSetupPage() {
  const { mutate } = useWorkspace();
  const [catalog, setCatalog] = useState<Catalog | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [profile, setProfile] = useState<{ filename: string; yaml: string } | null>(null);
  const [inspectionId, setInspectionId] = useState<string | null>(null), [runId, setRunId] = useState<string | null>(null);
  const resetSelection = () => { setSelected([]); setReviewed(false); setProfile(null); };
  const inspect = async (input: { serverId: string; url: string }) => {
    setBusy(true); setError(''); setCatalog(null); setInspectionId(null); resetSelection();
    try {
      const result = await api.runAgent('mcp.server.inspect', { serverId: input.serverId.trim(), url: input.url.trim() }, crypto.randomUUID());
      setInspectionId(result.runId);
      const detail = await api.fetchRun(result.runId);
      if (detail.run.status !== 'succeeded') throw new Error(detail.run.error?.message || '工具发现未能完成');
      const artifact = detail.artifacts.find((item: { type: string }) => item.type === 'json');
      if (!artifact) throw new Error('运行缺少工具目录');
      setCatalog(artifact.content as Catalog); await mutate();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const exportProfile = async () => {
    if (!catalog) return;
    setBusy(true); setError('');
    try { setProfile(await api.exportMcpProfile({ serverId: catalog.serverId, url: catalog.url, reviewedReadOnly: reviewed,
      tools: catalog.tools.filter(tool => selected.includes(tool.name)).map(({ name, alias }) => ({ name, alias })) })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const download = () => {
    if (!profile) return;
    const url = URL.createObjectURL(new Blob([profile.yaml], { type: 'application/yaml;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = profile.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>接入工具</h1><p>连接一个 MCP 服务，选择需要的能力，带着明确授权开始使用。</p></div></div>
    <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><ApiOutlined aria-hidden /></span><h2>1. 发现服务</h2></div>
      <Form layout="vertical" onFinish={inspect} disabled={busy} initialValues={{ serverId: 'context7', url: 'https://mcp.context7.com/mcp' }} onValuesChange={() => { setCatalog(null); setInspectionId(null); resetSelection(); }}>
        <Form.Item name="url" label="公开 HTTPS MCP 地址" rules={[{ required: true, message: '请填写服务地址' }, { type: 'url', message: '请填写完整的 HTTPS 地址' }]} extra="使用匿名访问，只读取服务信息和工具目录。当前不支持 OAuth、私网服务或带密钥的链接。"><Input maxLength={1024} placeholder="https://mcp.example.com/mcp" /></Form.Item>
        <Form.Item name="serverId" label="本地服务标识" rules={[{ required: true, pattern: /^[a-z][a-z0-9-]{0,63}$/, message: '以小写字母开头，只使用小写字母、数字和短横线，最多 64 字符' }]}><Input maxLength={64} /></Form.Item>
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={busy}>发现工具</Button>{inspectionId && <Button onClick={() => setRunId(inspectionId)}>查看发现记录</Button>}</div>
      </Form>
    </section>
    {error && <Alert type="error" showIcon title="未能完成接入步骤" description={error} />}
    {catalog && <section className="knowledge-search">
      <div className="connection-title"><h2>2. 选择读取工具</h2><Tag>{selected.length} / 50 已选</Tag></div>
      <p className="muted break-text">服务自报：{catalog.server.name || '未命名'} · {catalog.server.version || '版本未知'} · 发现于 {new Date(catalog.checkedAt).toLocaleString()}</p>
      <p className="muted">工具说明来自第三方服务。请核对参数和实际用途；“服务声明只读”不等于已经获得你的授权。</p>
      {!catalog.tools.length && <p>服务没有提供工具。</p>}
      <div className="mcp-tool-list">{catalog.tools.map(tool => <article className="mcp-tool" key={tool.name}>
        <Checkbox checked={selected.includes(tool.name)} disabled={busy || Boolean(tool.issue) || (!selected.includes(tool.name) && selected.length >= 50)} onChange={event => {
          setSelected(previous => event.target.checked ? [...previous, tool.name] : previous.filter(name => name !== tool.name)); setReviewed(false); setProfile(null);
        }}><strong className="break-text">{tool.name}</strong></Checkbox>
        <p className="muted break-text">{tool.description.length > 240 ? tool.description.slice(0, 240) + '…' : tool.description || '服务未提供说明'}</p>
        <span className="muted">{tool.issue || (tool.readOnlyHint ? '服务声明只读 · 仍需审查' : '服务未声明只读 · 需自行核实')}</span>
        <details><summary>查看完整说明与参数契约</summary><p className="muted break-text">{tool.description}</p><p className="muted break-text">mcp.{catalog.serverId}.{tool.alias}</p><pre className="json-view">{JSON.stringify({ inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, null, 2)}</pre></details>
      </article>)}</div>
      <div className="form-actions"><Checkbox checked={reviewed} disabled={busy || !selected.length} onChange={event => { setReviewed(event.target.checked); setProfile(null); }}>我已审查所选工具，确认只授权读取用途</Checkbox></div>
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!selected.length || !reviewed} onClick={exportProfile}>生成接入配置</Button></div>
    </section>}
    {profile && <section className="knowledge-search">
      <h2>3. 保存配置并启动</h2>
      <p>将 <code>{profile.filename}</code> 保存到项目的 <code>backend/examples/</code>，在后端目录启动：</p>
      <pre className="json-view">AGENT_PLUGINS_FILE=examples/{profile.filename} bun run dev</pre>
      <p className="muted">此文件选择独立的 MCP 组合，重启后出现“运行工具”入口。当前进程尚未安装这些工具；已有历史记录保留。</p>
      <details><summary>查看完整配置</summary><pre className="json-view">{profile.yaml}</pre></details>
      <div className="form-actions"><Button type="primary" onClick={download}>下载本地配置</Button></div>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
