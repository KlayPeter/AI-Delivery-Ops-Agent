import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { Alert, Button, Empty, Form, Input, Modal, Select, Spin, Tag } from 'antd';
import { api } from '@/api';
import { formatRunInput, readRunInput, rememberRunInput } from '@/runInputs.mjs';
import { capabilityName, errorMessage, needsModel, useWorkspace, type RunInfo } from './state';
import RunDrawer from './RunDrawer';
import { mcpArguments as parseMcpArguments } from './mcpInput';

interface Recipe { id: string; name: string; sourceRunId: string; capability: string; agentName: string; agentVersion: string; input: Record<string, unknown>; available: boolean; reason?: string }
interface Source { run: RunInfo; steps: { kind: string; name: string; status: string }[] }
export default function RecipesPage() {
  const { data: workspace, mutate: refreshWorkspace } = useWorkspace();
  const { data, error: loadError, mutate } = useSWR<{ recipes: Recipe[]; capabilities: string[] }>('recipes', api.fetchRecipes);
  const [search, setSearch] = useSearchParams(), sourceId = search.get('runId') || '';
  const validSource = /^[a-f0-9-]{36}$/i.test(sourceId);
  const { data: source, error: sourceError } = useSWR<Source>(validSource ? ['recipe-source', sourceId] : null, () => api.fetchRun(sourceId));
  const [error, setError] = useState(''), [saved, setSaved] = useState(''), [busy, setBusy] = useState(false), [warning, setWarning] = useState('');
  const [selected, setSelected] = useState<Recipe | null>(null), [parameters, setParameters] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const requestId = useRef({ key: '', id: '' }), launchRequestId = useRef({ key: '', id: '' });
  const idFor = (reference: typeof requestId, key: string) => { if (reference.current.key !== key) reference.current = { key, id: crypto.randomUUID() }; return reference.current.id; };
  const save = async ({ name, parameters: text }: { name: string; parameters: string }) => {
    setBusy(true); setError(''); setSaved('');
    try {
      const input = parseMcpArguments(text), key = JSON.stringify({ sourceId, name, input });
      await api.saveRecipe({ id: idFor(requestId, key), name, sourceRunId: sourceId, input }); await mutate(); setSaved('配方已保存。下次可在下方核对参数后运行。'); setSearch({}); requestId.current = { key: '', id: '' };
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const open = async (id: string) => {
    setError('');
    try { const result = await api.fetchRecipe(id); setSelected(result.recipe); setParameters(formatRunInput(result.recipe.input)); }
    catch (e) { setError(errorMessage(e)); }
  };
  const launch = async () => {
    if (!selected) return;
    setBusy(true); setError(''); setWarning('');
    try {
      const input = parseMcpArguments(parameters), result = await api.launchRecipe(selected.id, input, idFor(launchRequestId, JSON.stringify({ recipeId: selected.id, input })));
      if (result.warning) setWarning(result.warning);
      if (result.runId) { rememberRunInput(result.runId, input); setRunId(result.runId); launchRequestId.current = { key: '', id: '' }; }
      setSelected(null); await refreshWorkspace();
    } catch (e) {
      if (e instanceof Error && 'status' in e && [400, 409].includes(Number(e.status))) launchRequestId.current = { key: '', id: '' };
      setError(errorMessage(e));
    } finally { setBusy(false); }
  };
  const sourceSupported = source?.run.status === 'succeeded' && !source.run.parentRunId && data?.capabilities.includes(source.run.capability)
    && source.steps.filter(step => step.kind === 'agent' && !step.name.startsWith('delegate:')).length === 1;
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>任务配方</h1><p>把完成过的任务保存下来，下次核对参数后再运行。每次都有新的执行记录。</p></div></div>
    {loadError && <Alert type="error" title="配方加载失败" description={errorMessage(loadError)} action={<Button onClick={() => mutate()}>重试</Button>} />}
    {!selected && error && <Alert type="error" showIcon title="配方操作未完成" description={error} />}
    {warning && <Alert type="warning" showIcon title={warning} />}
    <section className="knowledge-search">
      <h2>从完成的任务创建</h2>
      <label htmlFor="recipe-source">来源运行</label>
      <Select id="recipe-source" style={{ width: '100%', marginBlock: 8 }} value={sourceId || undefined} placeholder="选择一条已完成的任务" allowClear onChange={value => { setSearch(value ? { runId: value } : {}); setError(''); setSaved(''); }} options={workspace?.runs.filter(run => run.status === 'succeeded').map(run => ({ value: run.id, label: `${capabilityName(run.capability, workspace.agents.find(agent => agent.capabilities.includes(run.capability))?.name)} · ${new Date(run.createdAt).toLocaleString()}` }))} />
      {sourceId && (!validSource || sourceError) && <Alert type="error" title="无法读取来源运行" />}
      {validSource && !source && !sourceError && <Spin />}
      {source && <>
        <p className="muted"><Button type="link" onClick={() => setRunId(source.run.id)}>查看来源结果</Button>配方保存的是目标与参数，模型服务、知识内容和工具实现仍使用当前环境。</p>
        {!sourceSupported ? <Alert type="info" title="这条运行暂不支持配方" description="请使用已审查的个人读取任务。人工多轮任务需先用完整参数重新执行，旧记录也可能缺少执行凭证。" /> : <Form key={source.run.id} layout="vertical" onFinish={save} initialValues={{ name: `${capabilityName(source.run.capability, workspace?.agents.find(agent => agent.capabilities.includes(source.run.capability))?.name)}配方`, parameters: formatRunInput(readRunInput(source.run.id) || {}) }} disabled={busy}>
          <Form.Item name="name" label="配方名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}><Input maxLength={80} /></Form.Item>
          <Form.Item name="parameters" label="原任务参数（JSON）" rules={[{ required: true, message: '请填写原任务参数' }]} extra={readRunInput(source.run.id) ? '已带入本页提交的参数；保存前会核对原输入指纹。' : '此页面会话未保留原参数，请粘贴原始 JSON。不会根据模型输出猜测参数。'}><Input.TextArea rows={5} maxLength={32768} /></Form.Item>
          <p className="muted">确认后在本机保存完整参数，请检查其中的私密内容。修改参数可在下次运行时进行。</p>
          <Button type="primary" htmlType="submit" loading={busy}>确认保存配方</Button>
        </Form>}
      </>}
      {saved && <Alert type="success" showIcon title={saved} />}
    </section>
    <section className="knowledge-search">
      <h2>我的配方</h2>
      {!data && !loadError ? <Spin /> : !data?.recipes.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="完成一次知识检索或研究任务后，可以在结果中保存配方" /> : <ul className="recipe-list">{data.recipes.map(recipe => {
        const agent = workspace?.agents.find(item => item.capabilities.includes(recipe.capability)), modelMissing = needsModel(agent) && !workspace?.modelConfigured;
        return <li key={recipe.id}><div><h3>{recipe.name} {!recipe.available && <Tag color="warning">当前不可运行</Tag>}</h3><p className="muted">{capabilityName(recipe.capability, recipe.agentName)} · v{recipe.agentVersion}</p>{recipe.reason && <p>{recipe.reason}</p>}{modelMissing && <p>此配方需要<Link to="/connections">连接模型</Link></p>}</div>
          <div className="form-actions"><Button onClick={() => setRunId(recipe.sourceRunId)}>来源结果</Button><Button type="primary" disabled={!recipe.available || modelMissing} onClick={() => open(recipe.id)}>使用配方</Button></div>
        </li>;
      })}</ul>}
    </section>
    <Modal title={selected ? `使用「${selected.name}」` : '使用配方'} open={Boolean(selected)} onCancel={() => !busy && setSelected(null)} onOk={launch} confirmLoading={busy} okText="确认参数并运行" cancelText="取消">
      <p>创建新运行，保留与配方及来源结果的关联。修改只影响这次任务。</p>
      <label htmlFor="recipe-parameters">本次参数（JSON）</label><Input.TextArea id="recipe-parameters" value={parameters} onChange={event => setParameters(event.target.value)} rows={8} maxLength={32768} disabled={busy} />
      {error && <Alert type="error" showIcon title="本次运行未能发起" description={error} />}
    </Modal>
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
