import { parseArgs } from 'node:util';
import type { AIConfig } from '@/core/config';
import { runEvaluation } from '@/evaluations/runner';
import { compareReports, evaluationInput } from '@/evaluations/grading';

try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, allowPositionals: false, options: {
        mode: { type: 'string', default: 'fixture' }, fixture: { type: 'string', default: 'baseline' }, label: { type: 'string', default: 'local-evaluation' }, 'confirm-model': { type: 'boolean' }, compare: { type: 'string' },
    } });
    const input = evaluationInput.parse(values.mode === 'model' ? { mode: 'model', confirmed: values['confirm-model'] === true, label: values.label } : { mode: values.mode, fixture: values.fixture, label: values.label });
    let config = {} as AIConfig;
    if (input.mode === 'model') {
        const provider = process.env.EVAL_PROVIDER || 'openai', model = process.env.EVAL_MODEL?.trim(), key = process.env.EVAL_API_KEY?.trim() || '';
        const base = new URL(process.env.EVAL_API_BASE || (provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1'));
        if (!model || (!key && provider !== 'ollama') || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
        config = { provider, model, api_key: key, api_base: base.href } as AIConfig;
    }
    const report = await runEvaluation(input, config, AbortSignal.timeout(85000));
    if (values.compare) {
        const file = Bun.file(values.compare); if (file.size > 1024 * 1024) throw new Error();
        const comparison = compareReports(await file.json(), report);
        console.log(JSON.stringify({ report, comparison }));
        process.exitCode = report.summary.failed || comparison.passDelta < 0 ? 1 : 0;
    } else { console.log(JSON.stringify(report)); process.exitCode = report.summary.failed ? 1 : 0; }
} catch {
    console.error('评测未完成：检查参数、同题集同模式的报告与 EVAL_* 模型配置。用法：bun run src/scripts/evaluate.ts --mode fixture --fixture baseline|regression --label 名称 [--compare report.json]；真实模型需 --mode model --confirm-model，并仅使用 EVAL_PROVIDER / EVAL_MODEL / EVAL_API_BASE / EVAL_API_KEY。');
    process.exitCode = 2;
}
