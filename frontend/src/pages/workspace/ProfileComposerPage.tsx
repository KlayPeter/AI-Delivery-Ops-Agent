import { useState } from 'react';
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { Alert, Button, Checkbox, Tabs, Tag } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useConnections, useWorkspace } from './state';

interface Profile { filename: string; yaml: string; summary: { kind: string; file: string; items: string[] }[]; files?: { name: string; yaml: string }[]; expectedRevision?: string | null; saved?: boolean }
interface SavedProfile { revision: string | null; editable: boolean; enabled: boolean; pending: boolean; profile?: Profile }
export default function ProfileComposerPage() {
  const { data, mutate: refreshWorkspace } = useWorkspace();
  const { data: connections, error: connectionsError, mutate: refreshConnections } = useConnections();
  const { data: saved, error: savedError, mutate: refreshSaved } = useSWR<SavedProfile>('saved-plugin-profile', api.fetchSavedPluginProfile);
  const [mode, setMode] = useState('setup'), [assistants, setAssistants] = useState<string[] | null>(null);
  const managed = Boolean(data && !data.managedByPluginFile);
  const selected = assistants ?? (managed ? (connections?.values.PLUGIN_SETUP_ASSISTANTS || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean) : []);
  const [notice, setNotice] = useState('');
  const [files, setFiles] = useState<File[]>([]), [profile, setProfile] = useState<Profile | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const setup = async () => {
    setBusy(true); setError(''); setProfile(null);
    try { setProfile(await api.exportPluginSetup(selected)); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError(''); setNotice(''); setProfile(null);
    try {
      let next = await api.saveConnections({ PLUGIN_SETUP_ASSISTANTS: selected.join('\n') });
      await refreshConnections(next, false); setNotice('助手选择已保存。');
      next = await api.applyConnections(next); await refreshConnections(next, false); await refreshWorkspace();
      setAssistants(null); setNotice(next.restartRequired ? '助手选择已保存，重启本地后端后生效。' : selected.length ? '接入助手已应用，可直接打开下面的入口。' : '接入助手已停用，历史记录保留。');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const compose = async () => {
    setBusy(true); setError(''); setNotice(''); setProfile(null); setConfirmed(false);
    try {
      if (!files.length || files.length > 3 || files.reduce((total, file) => total + file.size, 0) > 1024 * 1024) throw new Error('请选择 1–3 份配置，总量最多 1 MiB。');
      const input = await Promise.all(files.map(async file => ({ name: file.name, yaml: await file.text() })));
      setProfile({ ...await api.composePluginProfiles(input), files: input, expectedRevision: saved?.revision ?? null });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const reviewSaved = () => {
    if (!saved?.profile) return;
    setMode('compose'); setProfile({ ...saved.profile, expectedRevision: saved.revision, saved: true }); setConfirmed(false); setError(''); setNotice('');
  };
  const applySaved = async (next: SavedProfile) => {
    await refreshSaved(next, false);
    if (!next.pending) { setNotice('当前已使用这份组合。'); return; }
    if (!connections) throw new Error('请等待本机连接状态加载后重试。');
    const applied = await api.applyConnections({ ...connections, restartRequired: true });
    await refreshConnections(applied, false); await refreshWorkspace();
    const observed = await refreshSaved();
    if (applied.restartRequired) { setNotice('组合已保存，请重启本地后端后应用；配置和历史保留。'); return; }
    if (!observed || observed.revision !== next.revision || observed.pending) throw new Error('组合状态已变化或尚未生效，请刷新后重新核对。');
    setProfile(null); setConfirmed(false); setNotice(observed.enabled ? '插件组合已应用，可从插件和 Agent 页面使用。' : '已恢复个人预设，保存的组合和历史记录保留。');
  };
  const savePrepared = async () => {
    if (!profile || profile.expectedRevision === undefined || !confirmed) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = profile.saved ? await api.activatePluginProfile({ expectedRevision: profile.expectedRevision, confirmed: true, enabled: true })
        : await api.savePluginProfile({ files: profile.files!, expectedRevision: profile.expectedRevision, confirmed: true });
      setNotice('组合已保存，正在应用。'); await applySaved(next);
    } catch (e) { setError(errorMessage(e)); await refreshSaved().catch(() => {}); } finally { setBusy(false); }
  };
  const restorePersonal = async () => {
    if (!saved) return;
    setBusy(true); setError(''); setNotice('');
    try { await applySaved(saved.enabled ? await api.activatePluginProfile({ expectedRevision: saved.revision, confirmed: true, enabled: false }) : saved); }
    catch (e) { setError(errorMessage(e)); await refreshSaved().catch(() => {}); } finally { setBusy(false); }
  };
  const download = () => {
    if (!profile) return;
    const url = URL.createObjectURL(new Blob([profile.yaml], { type: 'application/yaml;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = profile.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>接入与组合</h1><p>启用接入助手，或把已审查的开源能力放进你的个人工作台。</p></div><Link to="/plugins">返回插件</Link></div>
    {savedError && <Alert type="error" showIcon title="保存的组合读取失败" description={errorMessage(savedError)} action={<Button onClick={() => refreshSaved()}>重试</Button>} />}
    {saved?.profile && <section className="knowledge-search">
      <h2>已保存的组合 <Tag>{saved.pending ? '待应用' : saved.enabled ? '已启用' : '已停用'}</Tag></h2>
      <p>{saved.profile.summary.map(item => item.kind).join('、')} · 保存在本机，恢复个人预设会保留这份组合和历史记录。</p>
      {!saved.editable && <p className="muted">当前由显式配置文件管理插件，保存的组合暂不生效。</p>}
      <div className="form-actions"><Button disabled={busy || !saved.editable} onClick={reviewSaved}>{saved.enabled ? '核对保存的组合' : '核对并启用'}</Button>
        {saved.editable && (saved.enabled || saved.pending) && <Button disabled={busy || !connections} onClick={restorePersonal}>{saved.enabled ? '恢复个人预设' : '应用个人预设'}</Button>}</div>
    </section>}
    <Tabs activeKey={mode} onChange={value => { setMode(value); setProfile(null); setConfirmed(false); setError(''); setNotice(''); }} items={[{ key: 'setup', label: '启用接入助手', disabled: busy, children: <section className="knowledge-search">
      <h2>1. 选择接入助手</h2>
      <p>{managed ? '勾选需要的助手并保存，即可填写公开链接、审查内容。这里只启用接入入口，实际 Skill 和工具仍需审查后启用。' : data?.compositionSource === 'saved' ? '当前使用已保存的组合，接入助手随组合启用。恢复个人预设后可调整助手选择；高级导出仍可使用。' : '当前插件由自定义文件管理。可在此导出所选助手配置，核对后按原方式启用；不会覆盖当前文件。'}</p>
      {managed && connectionsError && <Alert type="error" showIcon title="助手设置读取失败" description={errorMessage(connectionsError)} action={<Button onClick={() => refreshConnections()}>重试</Button>} />}
      <Checkbox.Group style={{ display: 'block' }} value={selected} disabled={busy} onChange={values => { setAssistants(values); setProfile(null); setError(''); setNotice(''); }}>
        <p><Checkbox value="skills">GitHub Skill 接入助手 {data?.pages.some(page => page.path === '/skills') && <Tag>当前已启用</Tag>}</Checkbox></p>
        <p className="muted">读取固定提交的 SKILL.md 与许可供你审查；运行导出的文本 Skill 时才需要模型。</p>
        <p><Checkbox value="openapi">OpenAPI 接入助手 {data?.pages.some(page => page.path === '/openapi-setup') && <Tag>当前已启用</Tag>}</Checkbox></p>
        <p className="muted">发现公开规范中可用的 GET 接口，核对服务、参数与读取用途；发现阶段不调用接口。</p>
      </Checkbox.Group>
      <p className="muted">MCP 接入助手已包含在个人预设中。{managed ? '取消勾选并保存可停用助手，原知识库与运行记录保留。' : '此处导出不会自动合并当前自定义插件；接入后可使用「组合已有配置」。'}</p>
      {managed ? <>
        <div className="form-actions"><Button type="primary" loading={busy} disabled={!connections} onClick={apply}>{connections?.reloadAvailable ? '保存并应用' : '保存助手选择'}</Button></div>
        <details><summary>导出配置（高级）</summary><p className="muted">生成可审查的个人基底配置，不改变当前装配。</p><Button loading={busy} disabled={!selected.length} onClick={setup}>生成助手配置</Button></details>
      </> : <div className="form-actions"><Button type="primary" loading={busy} disabled={!selected.length} onClick={setup}>生成助手配置</Button></div>}
      <div className="form-actions">{data?.pages.some(page => page.path === '/skills') && <Link to="/skills">接入 GitHub Skill</Link>}{data?.pages.some(page => page.path === '/openapi-setup') && <Link to="/openapi-setup">接入 OpenAPI</Link>}</div>
    </section> }, { key: 'compose', label: '组合已有配置', disabled: busy, children: <section className="knowledge-search">
      <h2>1. 选择导出配置</h2>
      <p>选择从本应用接入助手下载的 YAML。Skill、MCP、OpenAPI 各一份，最多三份、总量 1 MiB；一份 Skill 配置可包含多项技能。</p>
      <label htmlFor="plugin-profile-files">已审查的 YAML 文件</label>
      <input id="plugin-profile-files" className="profile-file-input" type="file" accept=".yaml,.yml" multiple disabled={busy} onChange={event => { setFiles(Array.from(event.target.files || [])); setProfile(null); setConfirmed(false); setError(''); setNotice(''); }} />
      {!!files.length && <ul>{files.map((file, index) => <li className="break-text" key={index}>{file.name} · {Math.ceil(file.size / 1024)} KiB</li>)}</ul>}
      <p className="muted">文件只提交到本机服务进行结构校验，不运行插件、不调用外部服务。来源、许可与工具用途仍以你的原审查为准。</p>
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!files.length} onClick={compose}>校验并预览组合</Button></div>
    </section> }]} />
    {notice && <Alert type="success" showIcon title={notice} />}
    {error && <Alert type="error" showIcon title="操作未完成" description={error} />}
    {profile && <>
      <section className="knowledge-search" aria-live="polite">
        <h2>2. 核对配置内容</h2>
        <p><Tag>个人工作台</Tag>沿用重启时本机的知识来源、模型连接和 GitHub 设置，再追加以下插件。</p>
        {profile.summary.map(item => <div key={item.kind}><h3>{item.kind} <Tag>{item.file}</Tag></h3><ul>{item.items.map((text, index) => <li key={index} className="break-text">{text}</li>)}</ul></div>)}
        <p className="muted">{mode === 'setup' ? '此文件只启用所选接入助手，尚未导入任何第三方 Skill 或工具。' : 'Skill 的原始内容、许可、ID 形态，以及工具白名单与来源指纹均保留。结构校验不能证明第三方服务的实际行为。'}当前自定义插件不会自动合并。</p>
        <details><summary>查看完整 YAML</summary><pre className="json-view">{profile.yaml}</pre></details>
      </section>
      <section className="knowledge-search">
        {mode === 'compose' && saved?.editable ? <>
          <h2>3. 保存并应用</h2>
          <p>这会替换本机保存的插件组合；知识来源、模型设置与历史记录继续保留。应用时会连接所选 MCP 服务。</p>
          <Checkbox checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}>已核对以上来源、许可与读取授权，确认启用这份组合</Checkbox>
          {profile.expectedRevision !== saved.revision && <p className="muted">保存的组合已变化，请重新校验并预览后再保存。</p>}
          <div className="form-actions"><Button type="primary" loading={busy} disabled={!confirmed || !connections || profile.expectedRevision !== saved.revision} onClick={savePrepared}>{connections?.reloadAvailable ? '保存并应用组合' : '保存组合'}</Button></div>
          <details><summary>下载与启动恢复（高级）</summary><p>下载不会改动当前工作台。保存到 backend 目录后仍可按显式配置方式启动。</p><Button icon={<DownloadOutlined aria-hidden />} onClick={download}>下载组合配置</Button><p>若所选服务启动失败，可在根目录运行以下命令恢复个人预设，再启动本地工作台；保存的组合仍保留。</p><pre className="json-view">bun run plugins:reset{'\n'}bun run local</pre></details>
        </> : <>
        <h2>3. 下载并启动</h2>
        <p>把 <code className="break-text">{profile.filename}</code> 保存到项目的 <code>backend/</code> 目录，停止原服务后，在仓库根目录运行：</p>
        <pre className="json-view">AGENT_PLUGINS_FILE={profile.filename} bun run local</pre>
        <p className="muted">下载不会更改当前工作台，已有运行记录保留。{mode === 'setup' ? '重启后打开「接入 Skill」或「接入 API」，审查来源并导出能力，再回到「组合已有配置」。' : '重启后所选插件共同启用。'}</p>
        <div className="form-actions"><Button type="primary" icon={<DownloadOutlined aria-hidden />} onClick={download}>{mode === 'setup' ? '下载助手配置' : '下载组合配置'}</Button></div>
        </>}
      </section>
    </>}
  </div>;
}
