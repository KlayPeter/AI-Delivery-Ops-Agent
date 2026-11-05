let enabled = false;
const inputs = new Map();
export function setInputCapture(value) { enabled = value; if (!enabled) inputs.clear(); }
export function rememberRunInput(runId, input) {
  if (!enabled || !runId) return;
  try {
    const json = JSON.stringify(input);
    if (new TextEncoder().encode(json).byteLength > 32768) return;
    inputs.set(runId, JSON.parse(json));
    if (inputs.size > 50) inputs.delete(inputs.keys().next().value);
  } catch { /* Unserializable SDK inputs are not recipe candidates. */ }
}
export function readRunInput(runId) {
  const input = inputs.get(runId);
  return input === undefined ? undefined : structuredClone(input);
}

export function formatRunInput(input) {
  const pretty = JSON.stringify(input, null, 2);
  return new TextEncoder().encode(pretty).byteLength <= 32768 ? pretty : JSON.stringify(input);
}
