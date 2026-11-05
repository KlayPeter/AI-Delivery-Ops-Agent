import { useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Select, Tag } from 'antd';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface Operation { key: string; alias: string; method: string; path: string; summary: string; servers: string[]; parameters: unknown[]; warnings?: string[]; serverWarning?: string; issue?: string }
interface Catalog { serviceId: string; source: { url: string; title: string; sha256: string; openapi: string }; checkedAt: string; operations: Operation[] }
export default function OpenApiSetupPage() {
  const { mutate } = useWorkspace();
  const [catalog, setCatalog] = useState<Catalog | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [servers, setServers] = useState<Record<string, string>>({}), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [profile, setProfile] = useState<{ filename: string; yaml: string } | null>(null), [inspectionId, setInspectionId] = useState<string | null>(null), [runId, setRunId] = useState<string | null>(null);
  const reset = () => { setSelected([]); setServers({}); setReviewed(false); setProfile(null); };
  const inspect = async (input: { serviceId: string; url: string }) => {
    setBusy(true); setError(''); setCatalog(null); setInspectionId(null); reset();
    try {
      const result = await api.runAgent('openapi.spec.inspect', { serviceId: input.serviceId.trim(), url: input.url.trim() }, crypto.randomUUID());
      setInspectionId(result.runId);
      const detail = await api.fetchRun(result.runId);
      if (detail.run.status !== 'succeeded') throw new Error(detail.run.error?.message || '规范读取失败');
      const artifact = detail.artifacts.find((item: { metadata?: { artifactRole?: string } }) => item.metadata?.artifactRole === 'openapi.catalog');
      if (!artifact) throw new Error('记录缺少 OpenAPI 目录');
      setCatalog(artifact.content as Catalog); await mutate();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const exportProfile = async () => {
    if (!catalog || !inspectionId) return;
    setBusy(true); setError('');
    try { setProfile(await api.exportOpenApiProfile({ inspectionRunId: inspectionId, reviewedReadOnly: reviewed, selections: catalog.operations.filter(operation => selected.includes(operation.key)).map(operation => ({ key: operation.key, serverUrl: servers[operation.key] || operation.servers[0] })) })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const download = () => {
    if (!profile) return;
    const url = URL.createObjectURL(new Blob([profile.yaml], { type: 'application/yaml;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = profile.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>接入 API</h1><p>从 OpenAPI 规范选择读取接口，审查服务地址后导出固定契约配置。</p></div></div>
    <section className="knowledge-search"><h2>1. 读取接口目录</h2>
      <Form layout="vertical" onFinish={inspect} disabled={busy} initialValues={{ serviceId: 'open-meteo', url: 'https://raw.githubusercontent.com/open-meteo/open-meteo/ecd65b64d966224046aaebbcda33a216f0ebd731/openapi/forecast.yml' }} onValuesChange={() => { setCatalog(null); setInspectionId(null); reset(); }}>
        <Form.Item name="url" label="公开 OpenAPI JSON / YAML 地址" rules={[{ required: true, message: '请填写规范地址' }, { validator: async (_, value: string) => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error('请使用不含凭据或查询参数的公开 HTTPS 原始文档地址'); } }]} extra="支持 OpenAPI 3.0 / 3.1 的基础 GET 参数；GitHub 请提供固定版本的 raw 文件。此步骤不调用规范中列出的接口。"><Input maxLength={1024} /></Form.Item>
        <Form.Item name="serviceId" label="本地服务标识" rules={[{ required: true, pattern: /^[a-z][a-z0-9-]{0,63}$/, message: '使用小写字母开头的字母、数字或短横线，最多 64 字符' }]}><Input maxLength={64} /></Form.Item>
        <div className="form-actions"><Button type="primary" htmlType="submit" loading={busy}>读取接口目录</Button>{inspectionId && <Button onClick={() => setRunId(inspectionId)}>查看发现记录</Button>}</div>
      </Form>
    </section>
    {error && <Alert type="error" showIcon title="接入步骤未完成" description={error} />}
    {catalog && <section className="knowledge-search"><div className="connection-title"><h2>2. 审查读取接口</h2><Tag>{selected.length} / 20 已选</Tag></div>
      <p className="muted break-text">{catalog.source.title} · OpenAPI {catalog.source.openapi} · 内容指纹 {catalog.source.sha256.slice(0, 12)} · <a href={catalog.source.url} target="_blank" rel="noreferrer">查看原始规范</a></p>
      <p className="muted">规范内容来自第三方。GET 不能证明没有副作用；请核对用途、服务地址和参数。当前不提供认证、私网、远程引用或写入方法。</p>
      {!catalog.operations.length && <p>文档没有提供可列出的路径接口。</p>}
      <div className="mcp-tool-list">{catalog.operations.map(operation => <article className="mcp-tool" key={operation.key}>
        <Checkbox checked={selected.includes(operation.key)} disabled={busy || Boolean(operation.issue) || (!selected.includes(operation.key) && selected.length >= 20)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, operation.key] : previous.filter(key => key !== operation.key)); setReviewed(false); setProfile(null); }}><strong className="break-text">{operation.key}</strong></Checkbox>
        <p className="muted break-text">{operation.summary}</p>
        {operation.issue ? <Tag color="warning">{operation.issue}</Tag> : <><label htmlFor={`server-${operation.alias}`}>实际服务地址</label><Select id={`server-${operation.alias}`} style={{ width: '100%' }} disabled={busy} value={servers[operation.key] || operation.servers[0]} options={operation.servers.map(value => ({ value, label: value }))} onChange={value => { setServers(previous => ({ ...previous, [operation.key]: value })); setReviewed(false); setProfile(null); }} /></>}
        {operation.serverWarning && <p className="muted">{operation.serverWarning}</p>}{operation.warnings?.map(warning => <p className="muted" key={warning}>{warning}</p>)}
        {!operation.issue && <details><summary>查看参数契约与工具标识</summary><p className="muted break-text">openapi.{catalog.serviceId}.{operation.alias}</p><pre className="json-view">{JSON.stringify(operation.parameters, null, 2)}</pre></details>}
      </article>)}</div>
      <div className="form-actions"><Checkbox checked={reviewed} disabled={busy || !selected.length} onChange={event => { setReviewed(event.target.checked); setProfile(null); }}>我已审查所选接口和服务地址，确认仅授予读取用途</Checkbox></div>
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!selected.length || !reviewed} onClick={exportProfile}>生成接入配置</Button></div>
    </section>}
    {profile && <section className="knowledge-search"><h2>3. 保存并启动已授权接口</h2><p>将 <code>{profile.filename}</code> 保存到 <code>backend/examples/</code>。在仓库根目录停止原服务后启动：</p><pre className="json-view">AGENT_PLUGINS_FILE=examples/{profile.filename} bun run local</pre>
      <p className="muted">该文件选择独立组合，重启后出现“API 工具”。配置固定本次选择的服务器、路径和输入契约；不会自动加载规范后续新增的接口，也不修改当前 Host。</p>
      <details><summary>查看完整配置</summary><pre className="json-view">{profile.yaml}</pre></details><div className="form-actions"><Button type="primary" onClick={download}>下载本地配置</Button></div>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
