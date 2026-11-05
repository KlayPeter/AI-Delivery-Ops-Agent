export function readKnowledgeModelConfig(operation: string) {
    const model = process.env.KNOWLEDGE_MODEL?.trim();
    const key = process.env.KNOWLEDGE_API_KEY?.trim();
    const base = process.env.KNOWLEDGE_API_BASE?.trim();
    if (!model || !key || !base) throw new Error(`${operation} requires KNOWLEDGE_API_BASE, KNOWLEDGE_MODEL and KNOWLEDGE_API_KEY; it sends selected evidence to that model`);
    const endpoint = new URL(base);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('KNOWLEDGE_API_BASE must be an HTTP(S) URL without credentials, query or fragment');
    return { provider: process.env.KNOWLEDGE_PROVIDER || 'openai-compatible', api_base: endpoint.href, api_key: key, model };
}
