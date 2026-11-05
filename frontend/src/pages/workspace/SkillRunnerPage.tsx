import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Input, Skeleton, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

interface SkillInfo { name: string; description: string; supports: string; source: { url: string; commit: string; sha256: string }; allowedTools: string[] }
export default function SkillRunnerPage() {
  const { data: workspace, mutate: refresh } = useWorkspace();
  const { data: skill, error: loadingError, isLoading } = useSWR<SkillInfo>('imported-prompt-skill', api.fetchImportedSkill);
  const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [runId, setRunId] = useState<string | null>(null);
  const run = async () => {
    if (!prompt.trim() || !workspace?.modelConfigured) return;
    setBusy(true); setError('');
    try { const result = await api.startAgent('skills.prompt.run', { prompt: prompt.trim() }, crypto.randomUUID()); setRunId(result.runId); await refresh(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="workspace-page"><div className="page-heading"><div><h1>使用 Skill</h1><p>用已审查的固定指令完成一份文本任务，保留实际 Skill 和模型步骤。</p></div></div>
    {loadingError ? <Alert type="error" showIcon title="Skill 加载失败" description={errorMessage(loadingError)} /> : isLoading ? <Skeleton active /> : skill && <section className="knowledge-search">
      <div className="connection-title"><h2>{skill.name}</h2><Tag>仅文本</Tag></div><p>{skill.description}</p>
      <p className="muted">外部工具 0 项；不执行代码、修改文件或加载附属资源。需要这些能力的上游任务可能无法完成。模型生成的内容需要人工核对。</p>
      <details><summary>查看当前来源与内容版本</summary><p><a href={skill.source.url} target="_blank" rel="noopener noreferrer">固定提交中的原文件</a></p><p className="muted break-text">提交：{skill.source.commit}<br />SHA-256：{skill.source.sha256}</p></details>
      {!workspace?.modelConfigured && <Alert showIcon type="info" title="请先配置模型" description={<Link to="/connections">前往连接与模型，保存后重启本地后端</Link>} />}
      <label htmlFor="imported-skill-prompt">交给这份 Skill 的任务</label><Input.TextArea id="imported-skill-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy} maxLength={8000} rows={6} placeholder="描述目标、内容和约束；结果以文本返回。" />
      <div className="form-actions"><Button type="primary" loading={busy} disabled={!prompt.trim() || !workspace?.modelConfigured} onClick={run}>使用 Skill 生成文本</Button></div><p className="muted">任务和指令会发送给当前配置的模型，可能产生费用。Skill 最长运行 45 秒；此过程不会重新读取 GitHub。</p>
    </section>}
    {error && <Alert type="error" showIcon title="Skill 运行未完成" description={error} />}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
