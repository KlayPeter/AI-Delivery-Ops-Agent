import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Form, Input, Select, Skeleton, Tabs, Tag } from 'antd';
import { ApiOutlined, RobotOutlined, ProjectOutlined, GithubOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useConnections, useWorkspace, type ConnectionState } from './state';

interface Field { key: string; label: string; placeholder?: string; secret?: boolean; options?: { value: string; label: string }[] }
const groups: { key: string; title: string; icon: ReactNode; description: string; fields: Field[] }[] = [
  { key: 'model', title: '模型服务', icon: <RobotOutlined aria-hidden />, description: '为模型循环和知识问答提供推理能力。支持 OpenAI 兼容接口、Google Gemini 和 Ollama 本机接口。通过本地启动器运行时，保存后自动应用。保存不代表已验证连接或模型可用。', fields: [
    { key: 'AI_PROVIDER', label: '接口类型', options: [{ value: 'openai', label: 'OpenAI 兼容接口（含 DeepSeek）' }, { value: 'google', label: 'Google Gemini' }, { value: 'ollama', label: 'Ollama · 本机接口，无需 Key' }] },
    { key: 'AI_API_BASE', label: 'API 地址', placeholder: 'https://api.openai.com/v1' },
    { key: 'AI_MODEL', label: '模型名称', placeholder: '填写供应商提供的模型 ID' },
    { key: 'AI_API_KEY', label: 'API Key', secret: true },
  ] },
  { key: 'github', title: 'GitHub', icon: <GithubOutlined aria-hidden />, description: '选择一个仓库用于发布准备。公开仓库可匿名读取；填写 Token 时请授予必要的只读权限。保存并应用后启用发布准备插件。清空仓库可停用。', fields: [
    { key: 'RELEASE_GITHUB_REPOSITORY', label: '仓库', placeholder: 'owner/repository' },
    { key: 'RELEASE_GITHUB_BRANCH', label: '目标分支（可选）', placeholder: '留空使用仓库默认分支' },
    { key: 'RELEASE_GITHUB_TOKEN', label: '读取 Token（可选）', secret: true },
  ] },
  { key: 'feishu', title: '飞书', icon: <ApiOutlined aria-hidden />, description: '填写你自己的飞书应用。群聊和私聊能力需另行启用团队插件；应用凭据后可建立机器人长连接，填写凭据不会自动装配团队 Agent。', fields: [
    { key: 'FEISHU_APP_ID', label: 'App ID', placeholder: 'cli_…' }, { key: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true },
    { key: 'FEISHU_BOT_NAME', label: '机器人名称', placeholder: 'AI 交付助理' }, { key: 'FEISHU_BOT_OPEN_ID', label: '机器人 Open ID（可选）', placeholder: 'ou_…' },
  ] },
  { key: 'tapd', title: 'TAPD', icon: <ProjectOutlined aria-hidden />, description: '为按需启用的任务、周报和项目看板插件提供项目数据；填写凭据不会自动装配团队功能。', fields: [
    { key: 'TAPD_WORKSPACE_ID', label: '项目 Workspace ID', placeholder: '项目 ID' }, { key: 'TAPD_API_BASE', label: 'API 地址', placeholder: 'https://api.tapd.cn' },
    { key: 'TAPD_API_TOKEN', label: 'API Token', secret: true }, { key: 'TAPD_WORKITEM_TYPE_ID', label: '工作项类型 ID（可选）' },
  ] },
];

function ConnectionForm({ group, data, onSaved }: { group: typeof groups[number]; data: ConnectionState; onSaved: (value: ConnectionState) => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const { data: workspace, mutate: refreshWorkspace } = useWorkspace();
  const provider = Form.useWatch('AI_PROVIDER', form) || data.values.AI_PROVIDER || 'openai';
  const localModel = group.key === 'model' && provider === 'ollama';
  const secret = group.fields.find(field => field.secret)?.key || '';
  const save = async (values: Record<string, string>) => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const payload = Object.fromEntries(group.fields.filter(field => !(localModel && field.key === 'AI_API_KEY') && (!field.secret || values[field.key]?.trim())).map(field => [field.key, values[field.key] || '']));
      let next = await api.saveConnections(payload); onSaved(next);
      for (const field of group.fields.filter(field => field.secret)) form.setFieldValue(field.key, '');
      next = await api.applyConnections(next); onSaved(next); await refreshWorkspace(); setSaved(true);
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  return <section className="connection-panel">
    <div className="connection-title"><span className="icon-tile">{group.icon}</span><h2>{group.title}</h2><Tag>{(group.key === 'model' ? data.values.AI_MODEL : group.key === 'github' ? data.values.RELEASE_GITHUB_REPOSITORY : data.secrets[secret]) ? '已保存参数' : '未配置'}</Tag></div>
    <p className="muted">{group.description}</p>
    {['feishu', 'tapd'].includes(group.key) && <details><summary>如何启用团队功能</summary><p className="muted">在后端目录使用已有团队组合启动。该配置替换默认个人组合；已有记录保留，需要混合能力时可在自己的配置中明确选择插件。</p><pre className="json-view">AGENT_PLUGINS_FILE=profiles/agents/team.yaml bun run dev</pre></details>}
    {localModel && <Alert type="info" showIcon title="使用你已准备好的 Ollama 模型" description="先在本机启动 Ollama，再填写 ollama list 中的模型名。这里只连接 HTTP 回环地址；应用不会下载模型。是否使用云端模型由你的 Ollama 配置决定。" />}
    {group.key === 'model' && workspace && <p className="muted">当前模型插件：{workspace.modelProviders?.map(item => item.name).join('、') || '未装配，请在插件配置中添加模型提供者'}。</p>}
    <Form form={form} layout="vertical" onFinish={save} initialValues={{ ...data.values, AI_PROVIDER: data.values.AI_PROVIDER === 'gemini' ? 'google' : data.values.AI_PROVIDER || 'openai' }}>
      <div className="connection-fields">{group.fields.filter(field => !(localModel && field.key === 'AI_API_KEY')).map(field => <Form.Item key={field.key} name={field.key} label={field.label} rules={localModel && field.key === 'AI_MODEL' ? [{ required: true, whitespace: true, message: '请填写本机已有的模型名称' }] : undefined} extra={localModel && field.key === 'AI_MODEL' ? '填写本机已有的模型名称；模型需要支持当前任务使用的工具调用。' : localModel && field.key === 'AI_API_BASE' ? '例如 http://127.0.0.1:11434/v1；留空使用此默认地址。' : field.secret && data.secrets[field.key] ? '已保存，留空将保留当前密钥。' : undefined}>
        {field.options ? <Select options={field.key === 'AI_PROVIDER' ? [...field.options, ...(workspace?.modelProviders || []).filter(item => !['openai', 'google', 'ollama'].includes(item.id)).map(item => ({ value: item.id, label: item.name }))] : field.options} onChange={value => { if (field.key === 'AI_PROVIDER') { form.setFieldValue('AI_API_BASE', value === 'ollama' ? 'http://127.0.0.1:11434/v1' : value === 'google' ? '' : value === 'openai' ? 'https://api.openai.com/v1' : form.getFieldValue('AI_API_BASE')); setSaved(false); } }} /> : field.secret ? <Input.Password autoComplete="new-password" placeholder={data.secrets[field.key] ? '输入新密钥可替换' : '填写你的密钥'} /> : <Input placeholder={localModel && field.key === 'AI_API_BASE' ? 'http://127.0.0.1:11434/v1' : field.placeholder} autoComplete="off" />}
      </Form.Item>)}</div>
      {error && <Alert type="error" showIcon title="操作未完成" description={error} />}
      {saved && <Alert type="success" showIcon title={data.restartRequired ? '已保存，重启本地后端后生效' : '已保存并加载'} />}
      <div className="form-actions"><Button type="primary" htmlType="submit" loading={saving}>{data.reloadAvailable ? '保存并应用' : '保存配置'}</Button><span className="muted">密钥保存在本机，不会完整回显。</span></div>
    </Form>
  </section>;
}

export default function ConnectionsPage() {
  const { data, error, isLoading, mutate } = useConnections();
  const { mutate: refreshWorkspace } = useWorkspace();
  const [applying, setApplying] = useState(false), [applyError, setApplyError] = useState('');
  const apply = async () => {
    if (!data) return;
    setApplying(true); setApplyError('');
    try { await mutate(await api.applyConnections(data), false); await refreshWorkspace(); }
    catch (e) { setApplyError(errorMessage(e)); } finally { setApplying(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>连接与模型</h1><p>连接你自己的模型和工具，按需扩展 Agent 的工作范围。</p></div></div>
    {error && <Alert type="error" title="配置加载失败" description={error.message} />}
    {data?.restartRequired && <Alert type="warning" title="有配置等待生效" description={data.reloadAvailable ? '当前任务仍使用已加载的配置；任务结束后可在此应用。' : '请重启本地后端。使用根目录 bun run local 启动可直接在页面应用配置。'} action={data.reloadAvailable && <Button onClick={apply} loading={applying}>应用已保存配置</Button>} showIcon />}
    {applyError && <Alert type="error" title="配置尚未应用" description={applyError} showIcon />}
    {isLoading ? <Skeleton active /> : data && <Tabs items={groups.map(group => ({ key: group.key, label: group.title, children: <ConnectionForm group={group} data={data} onSaved={value => { mutate(value, false); }} /> }))} />}
  </div>;
}
