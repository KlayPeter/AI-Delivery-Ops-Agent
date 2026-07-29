import type { RegisteredTool, ToolDefinition, ToolHandler } from './contracts';

const clone = <T>(value: T): T => structuredClone(value);

export class ToolRegistry {
    private readonly tools = new Map<string, RegisteredTool>();

    register(definition: ToolDefinition, handler: ToolHandler): void {
        if (!definition.id.trim() || !definition.version.trim()) throw new Error('Tool id and version are required');
        if (!definition.description.trim()) throw new Error('Tool description is required');
        if (definition.timeoutSeconds <= 0) throw new Error('Tool timeoutSeconds must be positive');
        if (definition.sideEffect === 'write' && !definition.idempotent) {
            throw new Error(`Write Tool must be idempotent: ${definition.id}`);
        }
        if (this.tools.has(definition.id)) throw new Error(`Tool already registered: ${definition.id}`);
        this.tools.set(definition.id, { definition: clone(definition), handler });
    }

    resolve(id: string): RegisteredTool {
        const tool = this.tools.get(id);
        if (!tool) throw new Error(`Tool not found: ${id}`);
        return { definition: clone(tool.definition), handler: tool.handler };
    }

    list(): ToolDefinition[] {
        return Array.from(this.tools.values()).map(tool => clone(tool.definition));
    }
}
