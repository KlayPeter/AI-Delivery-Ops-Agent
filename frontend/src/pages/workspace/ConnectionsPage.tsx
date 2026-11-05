import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Form, Input, Select, Skeleton, Tabs, Tag } from 'antd';
import { ApiOutlined, RobotOutlined, ProjectOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useConnections, type ConnectionState } from './state';

interface Field { key: string; label: string; placeholder?: string; secret?: boolean; options?: { value: string; label: string }[] }
const groups: { key: string; title: string; icon: ReactNode; description: string; fields: Field[] }[] = [
  { key: 'model', title: '模型服务', icon: <RobotOutlined aria-hidden />, description: '为模型循环和知识问答提供推理能力。支持 OpenAI 兼容接口及 Google Gemini。', fields: [
    { key: 'AI_PROVIDER', label: '接口类型', options: [{ value: 'openai', label: 'OpenAI 兼容接口（含 DeepSeek）' }, { value: 'google', label: 'Google Gemini' }] },
    { key: 'AI_API_BASE', label: 'API 地址', placeholder: 'https://api.openai.com/v1' },
    { key: 'AI_MODEL', label: '模型名称', placeholder: '填写供应商提供的模型 ID' },
    { key: 'AI_API_KEY', label: 'API Key', secret: true },
  ] },
  { key: 'feishu', title: '飞书', icon: <ApiOutlined aria-hidden />, description: '连接你的飞书应用，在群聊和私聊中使用 Agent。保存后重启后端，建立机器人长连接。', fields: [
    { key: 'FEISHU_APP_ID', label: 'App ID', placeholder: 'cli_…' }, { key: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true },
    { key: 'FEISHU_BOT_NAME', label: '机器人名称', placeholder: 'AI 交付助理' }, { key: 'FEISHU_BOT_OPEN_ID', label: '机器人 Open ID（可选）', placeholder: 'ou_…' },
  ] },
  { key: 'tapd', title: 'TAPD', icon: <ProjectOutlined aria-hidden />, description: '接入项目工作项，为任务、周报和项目看板提供数据。', fields: [
    { key: 'TAPD_WORKSPACE_ID', label: '项目 Workspace ID', placeholder: '项目 ID' }, { key: 'TAPD_API_BASE', label: 'API 地址', placeholder: 'https://api.tapd.cn' },
    { key: 'TAPD_API_TOKEN', label: 'API Token', secret: true }, { key: 'TAPD_WORKITEM_TYPE_ID', label: '工作项类型 ID（可选）' },
  ] },
];

function ConnectionForm({ group, data, onSaved }: { group: typeof groups[number]; data: ConnectionState; onSaved: (value: ConnectionState) => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const secret = group.fields.find(field => field.secret)?.key || '';
  const save = async (values: Record<string, string>) => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const payload = Object.fromEntries(group.fields.filter(field => !field.secret || values[field.key]?.trim()).map(field => [field.key, values[field.key] || '']));
      const next = await api.saveConnections(payload); onSaved(next); setSaved(true);
      for (const field of group.fields.filter(field => field.secret)) form.setFieldValue(field.key, '');
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  return <section className="connection-panel">
    <div className="connection-title"><span className="icon-tile">{group.icon}</span><h2>{group.title}</h2><Tag>{data.secrets[secret] ? '已配置' : '未配置'}</Tag></div>
    <p className="muted">{group.description}</p>
    <Form form={form} layout="vertical" onFinish={save} initialValues={{ ...data.values, AI_PROVIDER: data.values.AI_PROVIDER === 'gemini' ? 'google' : data.values.AI_PROVIDER || 'openai' }}>
      <div className="connection-fields">{group.fields.map(field => <Form.Item key={field.key} name={field.key} label={field.label} extra={field.secret && data.secrets[field.key] ? '已保存，留空将保留当前密钥。' : undefined}>
        {field.options ? <Select options={field.options} /> : field.secret ? <Input.Password autoComplete="new-password" placeholder={data.secrets[field.key] ? '输入新密钥可替换' : '填写你的密钥'} /> : <Input placeholder={field.placeholder} autoComplete="off" />}
      </Form.Item>)}</div>
      {error && <Alert type="error" showIcon title="保存失败" description={error} />}
      {saved && <Alert type="success" showIcon title={data.restartRequired ? '已保存，重启本地后端后生效' : '已保存并加载'} />}
      <div className="form-actions"><Button type="primary" htmlType="submit" loading={saving}>保存配置</Button><span className="muted">密钥保存在本机，不会完整回显。</span></div>
    </Form>
  </section>;
}

export default function ConnectionsPage() {
  const { data, error, isLoading, mutate } = useConnections();
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>连接与模型</h1><p>连接你自己的模型和工具，按需扩展 Agent 的工作范围。</p></div></div>
    {error && <Alert type="error" title="配置加载失败" description={error.message} />}
    {data?.restartRequired && <Alert type="warning" title="有配置等待生效" description="请重启本地后端。当前任务仍使用本次启动时加载的配置。" showIcon />}
    {isLoading ? <Skeleton active /> : data && <Tabs items={groups.map(group => ({ key: group.key, label: group.title, children: <ConnectionForm group={group} data={data} onSaved={value => { mutate(value, false); }} /> }))} />}
  </div>;
}
