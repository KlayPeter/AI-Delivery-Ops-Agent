import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Checkbox, Tabs, Tag } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';

interface Profile { filename: string; yaml: string; summary: { kind: string; file: string; items: string[] }[] }
export default function ProfileComposerPage() {
  const { data } = useWorkspace();
  const [mode, setMode] = useState('setup'), [assistants, setAssistants] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]), [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const setup = async () => {
    setBusy(true); setError(''); setProfile(null);
    try { setProfile(await api.exportPluginSetup(assistants)); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const compose = async () => {
    setBusy(true); setError(''); setProfile(null);
    try {
      if (!files.length || files.length > 3 || files.reduce((total, file) => total + file.size, 0) > 1024 * 1024) throw new Error('请选择 1–3 份配置，总量最多 1 MiB。');
      setProfile(await api.composePluginProfiles(await Promise.all(files.map(async file => ({ name: file.name, yaml: await file.text() })))));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const download = () => {
    if (!profile) return;
    const url = URL.createObjectURL(new Blob([profile.yaml], { type: 'application/yaml;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = profile.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>接入与组合</h1><p>启用接入助手，或把已审查的开源能力放进你的个人工作台。</p></div><Link to="/plugins">返回插件</Link></div>
    <Tabs activeKey={mode} onChange={value => { setMode(value); setProfile(null); setError(''); }} items={[{ key: 'setup', label: '启用接入助手', disabled: busy, children: <section className="knowledge-search">
      <h2>1. 选择接入助手</h2>
      <p>首次接入时，先启用需要的助手。重启后可填写公开 GitHub Skill 链接或 OpenAPI 规范地址，审查内容，再导出实际能力。</p>
      <Checkbox.Group style={{ display: 'block' }} value={assistants} disabled={busy} onChange={values => { setAssistants(values); setProfile(null); setError(''); }}>
        <p><Checkbox value="skills">GitHub Skill 接入助手 {data?.pages.some(page => page.path === '/skills') && <Tag>当前已启用</Tag>}</Checkbox></p>
        <p className="muted">读取固定提交的 SKILL.md 与许可供你审查；运行导出的文本 Skill 时才需要模型。</p>
        <p><Checkbox value="openapi">OpenAPI 接入助手 {data?.pages.some(page => page.path === '/openapi-setup') && <Tag>当前已启用</Tag>}</Checkbox></p>
        <p className="muted">发现公开规范中可用的 GET 接口，核对服务、参数与读取用途；发现阶段不调用接口。</p>
      </Checkbox.Group>
      <p className="muted">MCP 接入助手已包含在个人预设中。这里生成的配置保留个人工作台及所选助手；当前自定义插件不会自动加入，可在审查导出后使用「组合已有配置」。</p>
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!assistants.length} onClick={setup}>生成助手配置</Button></div>
    </section> }, { key: 'compose', label: '组合已有配置', disabled: busy, children: <section className="knowledge-search">
      <h2>1. 选择导出配置</h2>
      <p>选择从本应用接入助手下载的 YAML。Skill、MCP、OpenAPI 各一份，最多三份、总量 1 MiB；一份 Skill 配置可包含多项技能。</p>
      <label htmlFor="plugin-profile-files">已审查的 YAML 文件</label>
      <input id="plugin-profile-files" className="profile-file-input" type="file" accept=".yaml,.yml" multiple disabled={busy} onChange={event => { setFiles(Array.from(event.target.files || [])); setProfile(null); setError(''); }} />
      {!!files.length && <ul>{files.map((file, index) => <li className="break-text" key={index}>{file.name} · {Math.ceil(file.size / 1024)} KiB</li>)}</ul>}
      <p className="muted">文件只提交到本机服务进行结构校验，不运行插件、不调用外部服务。来源、许可与工具用途仍以你的原审查为准。</p>
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!files.length} onClick={compose}>校验并预览组合</Button></div>
    </section> }]} />
    {error && <Alert type="error" showIcon title="未能生成配置" description={error} />}
    {profile && <>
      <section className="knowledge-search" aria-live="polite">
        <h2>2. 核对配置内容</h2>
        <p><Tag>个人工作台</Tag>沿用重启时本机的知识来源、模型连接和 GitHub 设置，再追加以下插件。</p>
        {profile.summary.map(item => <div key={item.kind}><h3>{item.kind} <Tag>{item.file}</Tag></h3><ul>{item.items.map((text, index) => <li key={index} className="break-text">{text}</li>)}</ul></div>)}
        <p className="muted">{mode === 'setup' ? '此文件只启用所选接入助手，尚未导入任何第三方 Skill 或工具。' : 'Skill 的原始内容、许可、ID 形态，以及工具白名单与来源指纹均保留。结构校验不能证明第三方服务的实际行为。'}当前自定义插件不会自动合并。</p>
        <details><summary>查看完整 YAML</summary><pre className="json-view">{profile.yaml}</pre></details>
      </section>
      <section className="knowledge-search">
        <h2>3. 下载并启动</h2>
        <p>把 <code className="break-text">{profile.filename}</code> 保存到项目的 <code>backend/</code> 目录，停止原服务后，在仓库根目录运行：</p>
        <pre className="json-view">AGENT_PLUGINS_FILE={profile.filename} bun run local</pre>
        <p className="muted">下载不会更改当前工作台，已有运行记录保留。{mode === 'setup' ? '重启后打开「接入 Skill」或「接入 API」，审查来源并导出能力，再回到「组合已有配置」。' : '重启后所选插件共同启用。'}</p>
        <div className="form-actions"><Button type="primary" icon={<DownloadOutlined aria-hidden />} onClick={download}>{mode === 'setup' ? '下载助手配置' : '下载组合配置'}</Button></div>
      </section>
    </>}
  </div>;
}
