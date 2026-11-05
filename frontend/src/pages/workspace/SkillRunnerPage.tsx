import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Checkbox, Input, Select, Skeleton, Tag } from 'antd';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import { api } from '@/api';
import { capabilityName, errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface SkillInfo { id: string; name: string; description: string; supports: string; source: { repository: string; path: string; url: string; commit: string; sha256: string }; allowedTools: string[] }
interface KnowledgePreview { sha256: string; snapshot: { runId: string; retrieval: { partial: boolean; contextTruncated: boolean }; evidence: { citationId: string; title: string; path: string; heading: string; excerpt: string; documentVersion: string; lineStart: number; lineEnd: number }[] } }
export default function SkillRunnerPage() {
  const { data: workspace, mutate: refresh } = useWorkspace();
  const { data: catalog, error: loadingError, isLoading } = useSWR<{ skills: SkillInfo[]; knowledgeCapabilities?: string[] }>('imported-prompt-skills', api.fetchImportedSkills);
  const [selectedId, setSelectedId] = useState('');
  const skills = catalog?.skills || [], skill = selectedId ? skills.find(item => item.id === selectedId) : skills.length === 1 ? skills[0] : undefined;
  const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const [useKnowledge, setUseKnowledge] = useState(false), [knowledgeRunId, setKnowledgeRunId] = useState(''), [confirmedHash, setConfirmedHash] = useState('');
  const { data: knowledge, error: knowledgeError, isLoading: knowledgeLoading, mutate: refreshKnowledge } = useSWR<KnowledgePreview>(useKnowledge && knowledgeRunId ? ['skill-knowledge-preview', knowledgeRunId] : null, () => api.fetchSkillContext(knowledgeRunId));
  const knowledgeRuns = (workspace?.runs || []).filter(run => run.status === 'succeeded' && !run.parentRunId && catalog?.knowledgeCapabilities?.includes(run.capability));
  const knowledgeReady = !useKnowledge || Boolean(knowledge && !knowledgeError && !knowledgeLoading && confirmedHash === knowledge.sha256);
  const run = async () => {
    if (!prompt.trim() || !workspace?.modelConfigured || !skill || loadingError || !knowledgeReady) return;
    setBusy(true); setError('');
    try { const result = await api.startAgent('skills.prompt.run', { prompt: prompt.trim(), skillId: skill.id, ...(useKnowledge && knowledge ? { knowledge: { runId: knowledge.snapshot.runId, sha256: knowledge.sha256, confirmed: true } } : {}) }, crypto.randomUUID()); setRunId(result.runId); await refresh(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="workspace-page"><div className="page-heading"><div><h1>使用 Skill</h1><p>用已审查的固定指令完成一份文本任务，保留实际 Skill 和模型步骤。</p></div></div>
    {loadingError ? <Alert type="error" showIcon title="Skill 加载失败" description={errorMessage(loadingError)} /> : isLoading ? <Skeleton active /> : <section className="knowledge-search">
      <h2>选择已审查的 Skill</h2><p className="muted">每次只使用所选 Skill 的固定指令。不同仓库或版本的同名技能会分别保留。</p>
      <label htmlFor="imported-skill-choice">本次使用</label><Select id="imported-skill-choice" style={{ width: '100%' }} disabled={busy} value={skill?.id} placeholder="请选择一份 Skill" options={skills.map(item => ({ value: item.id, label: `${item.name} · ${item.source.repository} · ${item.source.path} · ${item.source.commit.slice(0, 8)}` }))} onChange={setSelectedId} />
      {selectedId && !skill && <Alert type="warning" showIcon title="原选择已不在当前配置中，请重新选择" />}
      {!skills.length && <Alert type="info" title="当前没有可用 Skill，请检查本地插件配置" />}
    </section>}
    {!loadingError && skill && <section className="knowledge-search">
      <div className="connection-title"><h2>{skill.name}</h2><Tag>仅文本</Tag></div><p>{skill.description}</p>
      <p className="muted break-text">{skill.source.repository}/{skill.source.path}</p>
      <p className="muted">外部工具 0 项；不执行代码、修改文件或加载附属资源。需要这些能力的上游任务可能无法完成。模型生成的内容需要人工核对。</p>
      <details><summary>查看当前来源与内容版本</summary><p><a href={skill.source.url} target="_blank" rel="noopener noreferrer">固定提交中的原文件</a></p><p className="muted break-text">提交：{skill.source.commit}<br />SHA-256：{skill.source.sha256}</p></details>
      {!workspace?.modelConfigured && <Alert showIcon type="info" title="请先配置模型" description={<Link to="/connections">前往连接与模型，保存后重启本地后端</Link>} />}
      {catalog?.knowledgeCapabilities && <div className="resume-form"><Checkbox checked={useKnowledge} disabled={busy} onChange={event => { setUseKnowledge(event.target.checked); setConfirmedHash(''); }}>为本次任务选择知识检索资料</Checkbox>
        {useKnowledge && <>
          <p className="muted">使用一次已保存检索中的原文片段，不重新读取当前来源。输出中的事实、引用和资料时效仍需核对。</p>
          <label htmlFor="skill-knowledge-run">成功的检索记录</label><Select id="skill-knowledge-run" style={{ width: '100%' }} disabled={busy} value={knowledgeRunId || undefined} placeholder="选择最近 50 次根运行中的成功检索" options={knowledgeRuns.map(run => ({ value: run.id, label: `${capabilityName(run.capability)} · ${dayjs(run.createdAt).format('MM-DD HH:mm:ss')} · ${run.id.slice(0, 8)}` }))} onChange={id => { setKnowledgeRunId(id); setConfirmedHash(''); }} />
          {!knowledgeRuns.length && <p>先到{workspace?.pages.some(page => page.path === '/knowledge') ? <Link to="/knowledge">知识库检索原文</Link> : <Link to="/skills">接入 Skill 时勾选保留个人工作台</Link>}，完成一次命中资料的检索。</p>}
          {knowledgeLoading && <p role="status">正在读取已保存的资料快照…</p>}
          {knowledgeError && <Alert type="error" showIcon title="资料预览失败" description={errorMessage(knowledgeError)} action={<Button onClick={() => refreshKnowledge()}>重试</Button>} />}
          {knowledge && !knowledgeError && <>
            {(knowledge.snapshot.retrieval.partial || knowledge.snapshot.retrieval.contextTruncated) && <Alert type="warning" showIcon title="这份资料存在读取不完整或上下文预算限制" />}
            <details><summary>查看将发送的 {knowledge.snapshot.evidence.length} 条原文片段</summary>{knowledge.snapshot.evidence.map(hit => <article className="evidence" key={hit.citationId}><strong>{hit.title || hit.path}</strong><p className="muted break-text">{hit.path} · 行 {hit.lineStart}–{hit.lineEnd}<br />文档版本：{hit.documentVersion}</p><blockquote>{hit.excerpt}</blockquote></article>)}</details>
            <div className="form-actions"><Button disabled={busy} onClick={() => setRunId(knowledge.snapshot.runId)}>查看原检索与完整来源</Button></div>
            <Checkbox checked={confirmedHash === knowledge.sha256} disabled={busy} onChange={event => setConfirmedHash(event.target.checked ? knowledge.sha256 : '')}>我确认将以上片段与任务发送给当前模型，并核对生成结果</Checkbox>
          </>}
        </>}
      </div>}
      <label htmlFor="imported-skill-prompt">交给这份 Skill 的任务</label><Input.TextArea id="imported-skill-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy} maxLength={8000} rows={6} placeholder="描述目标、内容和约束；结果以文本返回。" />
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!prompt.trim() || !workspace?.modelConfigured || !knowledgeReady} onClick={run}>使用 Skill 生成文本</Button></div><p className="muted">任务、所选 Skill 指令和明确确认的资料片段会发送给当前模型，可能产生费用。不额外发送路径、打开 URI 字段或未选资料；任务、标题和片段本身可能包含这些信息。Skill 最长运行 45 秒；此过程不会重新读取 GitHub。</p>
    </section>}
    {error && <Alert type="error" showIcon title="Skill 运行未完成" description={error} />}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
