export function setInputCapture(enabled: boolean): void;
export function rememberRunInput(runId: string | undefined, input: unknown): void;
export function readRunInput(runId: string): Record<string, unknown> | undefined;

export function formatRunInput(input: Record<string, unknown>): string;
