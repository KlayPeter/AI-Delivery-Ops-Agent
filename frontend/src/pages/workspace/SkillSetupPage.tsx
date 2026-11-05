import { useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Tag } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface Inspection {
  bundle: { requestedUrl: string; owner: string; repo: string; commit: string; filePath: string; rawSkill: string; sha256: string; skillUrl: string; inspectedAt: string; license: { url: string; path: string; text: string } | null };
  skill: { manifest: { name: string; description: string }; declarations: { license: string; compatibility: string; allowedTools: string } };
}
interface ReviewedSelection { inspectionRunId: string; reviewedSha256: string; name: string; sourceUrl: string; sourceLabel: string }
const example = 'https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md';
export default function SkillSetupPage() {
  const { data: workspace, mutate: refresh } = useWorkspace();
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null), [inspectionId, setInspectionId] = useState<string | null>(null), [runId, setRunId] = useState<string | null>(null), [lastRunId, setLastRunId] = useState<string | null>(null), [reviewed, setReviewed] = useState(false), [licensed, setLicensed] = useState(false);
  const [selections, setSelections] = useState<ReviewedSelection[]>([]);
  const alreadySelected = inspection && selections.some(item => item.sourceUrl === inspection.bundle.skillUrl && item.reviewedSha256 === inspection.bundle.sha256);
  const candidates = (workspace?.runs || []).filter(run => !run.parentRunId && run.capability === 'skills.github.inspect' && run.status === 'succeeded');
  const reset = () => { setInspection(null); setInspectionId(null); setReviewed(false); setLicensed(false); setNotice(''); };
  const load = async (id: string) => { reset(); const result = await api.fetchSkillInspection(id); setInspection(result); setInspectionId(id); setUrl(result.bundle.requestedUrl); };
  const inspect = async () => {
    if (!url.trim()) return;
    setBusy(true); setError(''); reset();
    try {
      const result = await api.runAgent('skills.github.inspect', { url: url.trim() }, crypto.randomUUID()); setLastRunId(result.runId);
      const detail = await api.fetchRun(result.runId); if (detail.run.status !== 'succeeded') throw new Error(detail.run.error?.message || 'Skill 读取未完成');
      await load(result.runId);
    } catch (e) { setError(errorMessage(e)); } finally { await refresh(); setBusy(false); }
  };
  const open = async (id: string) => { setBusy(true); setError(''); try { await load(id); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  const addSelection = () => {
    if (!inspection || !inspectionId || !reviewed || !licensed || alreadySelected || selections.length >= 8) return;
    setSelections([...selections, { inspectionRunId: inspectionId, reviewedSha256: inspection.bundle.sha256, name: inspection.skill.manifest.name, sourceUrl: inspection.bundle.skillUrl, sourceLabel: `${inspection.bundle.owner}/${inspection.bundle.repo}/${inspection.bundle.filePath} · ${inspection.bundle.commit.slice(0, 8)}` }]);
  };
  const download = async (collection = false) => {
    if (collection ? !selections.length : !inspection || !inspectionId || !reviewed || !licensed) return;
    setBusy(true); setExporting(true); setError('');
    try {
      const profile = await api.exportSkillProfile(collection ? { skills: selections.map(item => ({ inspectionRunId: item.inspectionRunId, reviewedSha256: item.reviewedSha256, confirmedPromptOnly: true, confirmedLicense: true })) } : { inspectionRunId: inspectionId, reviewedSha256: inspection!.bundle.sha256, confirmedPromptOnly: true, confirmedLicense: true });
      const objectUrl = URL.createObjectURL(new Blob([profile.yaml], { type: 'application/yaml;charset=utf-8' })), link = document.createElement('a'); link.href = objectUrl; link.download = profile.filename; link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice(`已下载 ${profile.filename}。保存到 backend 目录，停止本地进程后选择此配置重启；届时会出现「使用 Skill」。下载不会改变当前装配。`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); setExporting(false); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>接入 Skill</h1><p>把公开 GitHub 的指令技能，审查后接到本地工作台。</p></div><div className="form-actions">{lastRunId && <Button onClick={() => setRunId(lastRunId)}>查看最近运行</Button>}<Button disabled={busy} onClick={() => refresh()}>刷新记录</Button></div></div>
    {error && <Alert type="error" showIcon title="Skill 接入未完成" description={error} />}
    {notice && <Alert type="success" showIcon title="配置已导出，保存并选择后重启" description={notice} />}
    <section className="knowledge-search"><h2>1. 读取公开的 SKILL.md</h2><p className="muted">只读取这个文件和可找到的许可，固定到完整提交。无需模型，不克隆或安装仓库。</p>
      <label htmlFor="skill-source-url">GitHub 文件链接</label><Input id="skill-source-url" value={url} disabled={busy} maxLength={1024} placeholder="https://github.com/组织/仓库/blob/main/技能目录/SKILL.md" onChange={event => { setUrl(event.target.value); reset(); }} />
      <div className="form-actions"><Button type="primary" loading={busy && !exporting} disabled={busy || !url.trim()} onClick={inspect}>读取并检查 Skill</Button><Button disabled={busy} onClick={() => { setUrl(example); reset(); }}>填入 Anthropic 前端设计示例</Button></div>
      {candidates.length > 0 && <div className="form-actions"><label htmlFor="skill-saved-inspection">打开已有发现记录</label><Select id="skill-saved-inspection" value={inspectionId || undefined} disabled={busy} placeholder="最近 50 次根运行中的成功记录" options={candidates.map(run => ({ value: run.id, label: `${dayjs(run.createdAt).format('MM-DD HH:mm:ss')} · ${run.id.slice(0, 8)}` }))} onChange={open} /></div>}
    </section>
    {inspection && <section className="knowledge-search"><div className="connection-title"><h2>2. 审查指令与使用范围</h2><Tag>来源快照</Tag></div>
      <h3>{inspection.skill.manifest.name}</h3><p>{inspection.skill.manifest.description}</p>
      <p className="break-text"><a href={inspection.bundle.skillUrl} target="_blank" rel="noopener noreferrer">查看固定提交中的原文件</a> · {inspection.bundle.owner}/{inspection.bundle.repo}</p>
      <p className="muted break-text">提交：{inspection.bundle.commit}<br />文件 SHA-256：{inspection.bundle.sha256}</p>
      <p>本次只启用指令文本，外部工具权限为 0。不会执行脚本、读取文件、浏览网页或加载 references / assets；需要这些资源的技能无法完整运行。</p>
      {inspection.skill.declarations.allowedTools && <p className="muted break-text">上游工具声明：{inspection.skill.declarations.allowedTools}。该声明不会变成授权。</p>}
      {inspection.skill.declarations.compatibility && <p className="muted break-text">上游环境说明：{inspection.skill.declarations.compatibility}</p>}
      <details><summary>查看完整 Skill 文件</summary><pre className="json-view">{inspection.bundle.rawSkill}</pre></details>
      <details><summary>查看许可信息</summary><p className="break-text">文件声明：{inspection.skill.declarations.license || '未声明'}</p>{inspection.bundle.license ? <><a href={inspection.bundle.license.url} target="_blank" rel="noopener noreferrer">查看同一提交的许可文件</a><pre className="json-view">{inspection.bundle.license.text}</pre></> : <p>未取得许可文件。请到来源仓库自行核对，读取成功不代表允许复制或使用。</p>}</details>
      <div className="form-actions"><Checkbox checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)}>我已审查完整指令，接受只运行文本、没有外部工具的范围</Checkbox></div>
      <div className="form-actions"><Checkbox checked={licensed} disabled={busy} onChange={event => setLicensed(event.target.checked)}>我已核对来源和许可，具备使用这份 Skill 的权限</Checkbox></div>
      <div className="form-actions"><Button type="primary" loading={exporting} disabled={busy || !reviewed || !licensed} onClick={() => download()}>下载这一份的配置</Button><Button disabled={busy || !reviewed || !licensed || Boolean(alreadySelected) || selections.length >= 8} onClick={addSelection}>{alreadySelected ? '已加入待导出列表' : '加入待导出列表'}</Button><Button disabled={busy} onClick={() => setRunId(inspectionId)}>查看发现运行</Button></div>
      <p className="muted">配置包含固定指令、来源及已取得的许可正文，不含模型密钥。运行时再使用你配置的模型；保存和重启前不会启用。</p>
    </section>}
    {selections.length > 0 && <section className="knowledge-search"><h2>3. 一起导出多份 Skill</h2><p aria-live="polite">已选择 {selections.length} / 8 份。列表只在本页保留，刷新后可从成功发现记录重新审查加入。</p>
      {selections.map(item => <article className="evidence" key={item.sourceUrl + item.reviewedSha256}><strong>{item.name}</strong><p className="muted break-text">{item.sourceLabel}</p><div className="form-actions"><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">固定来源</a><Button disabled={busy} aria-label={`移除 ${item.name} ${item.sourceLabel}`} onClick={() => setSelections(selections.filter(selected => selected !== item))}>移除</Button></div></article>)}
      <div className="form-actions"><Button type="primary" loading={exporting} disabled={busy} onClick={() => download(true)}>下载所选 Skill 的配置</Button></div><p className="muted">服务会重新核验每份原记录和审查指纹。配置只包含所选 Skill、接入助手和模型提供者；不会合并当前其他插件。所选内容配置最多 512 KiB，保存并选择后重启，再从「使用 Skill」逐份运行。</p>
    </section>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
