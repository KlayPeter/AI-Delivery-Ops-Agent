import { LLMAdapter } from "../adapters/llm";
import { loadConfig } from "../core/config";

const config = loadConfig();
const llm = new LLMAdapter(config.ai, false);
const result = await llm.healthCheck();

console.log(JSON.stringify({
    ok: result.ok,
    ms: result.ms,
    diagnostics: result.diagnostics,
    error: result.error || "",
    content: result.content ? result.content.slice(0, 200) : "",
    attempts: result.raw?.attempts || [],
}, null, 2));

process.exit(result.ok ? 0 : 1);
