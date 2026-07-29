import type { ToolCallBudget } from './contracts';

export class RunToolCallBudget implements ToolCallBudget {
    readonly limit: number;
    private consumed: number;

    constructor(limit: number, consumed = 0) {
        this.limit = Math.max(0, Math.floor(limit));
        this.consumed = Math.max(0, Math.floor(consumed));
    }

    get used(): number {
        return this.consumed;
    }

    consume(toolId: string): void {
        if (this.consumed >= this.limit) {
            throw Object.assign(new Error(`Agent Tool call limit exceeded: ${this.limit}`), {
                code: 'TOOL_CALL_LIMIT_EXCEEDED',
                retryable: false,
                toolId,
                limit: this.limit,
                used: this.consumed,
            });
        }
        this.consumed++;
    }
}
