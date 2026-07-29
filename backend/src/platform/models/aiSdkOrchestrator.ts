import { ToolLoopAgent, dynamicTool, hasToolCall, jsonSchema, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import type { HumanInputRequest, ModelGateway, OrchestratorAdapter, OrchestratorRunRequest, OrchestratorRunResult } from './contracts';

export class AiSdkOrchestratorAdapter implements OrchestratorAdapter {
    constructor(private readonly models: ModelGateway) {}

    async run(request: OrchestratorRunRequest): Promise<OrchestratorRunResult> {
        let humanRequest: HumanInputRequest | undefined;
        const tools: ToolSet = {};
        for (const definition of request.tools) {
            if (definition.name === 'request_human_input') throw new Error('request_human_input is reserved');
            tools[definition.name] = dynamicTool({
                description: definition.description,
                inputSchema: jsonSchema(definition.inputSchema as any),
                execute: (input, options) => definition.execute(input, options.toolCallId, options.abortSignal),
            });
        }
        tools.request_human_input = dynamicTool({
            description: 'Ask the user for missing information and stop the current run until they reply.',
            inputSchema: jsonSchema({
                type: 'object',
                required: ['question'],
                properties: {
                    question: { type: 'string' },
                    fields: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            }),
            execute: async input => {
                const record = input as { question: string; fields?: string[] };
                humanRequest = { question: record.question, fields: Array.isArray(record.fields) ? record.fields.map(String) : [] };
                return { status: 'waiting_human', question: record.question };
            },
        });

        let modelCalls = 0;
        let toolCalls = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        const agent = new ToolLoopAgent({
            id: request.agentId,
            model: this.models.resolve(request.modelProfile),
            instructions: request.instructions,
            tools,
            stopWhen: [hasToolCall('request_human_input'), stepCountIs(Math.max(1, request.maxSteps))],
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature,
        });
        const result = await agent.generate({
            messages: request.messages as ModelMessage[],
            abortSignal: request.signal,
            timeout: { totalMs: request.timeoutMs },
            onStepFinish: async step => {
                modelCalls++;
                toolCalls += step.toolCalls.length;
                inputTokens += Number(step.usage?.inputTokens || 0);
                outputTokens += Number(step.usage?.outputTokens || 0);
                await request.onStep?.({
                    modelCalls: 1,
                    toolCalls: step.toolCalls.length,
                    inputTokens: Number(step.usage?.inputTokens || 0),
                    outputTokens: Number(step.usage?.outputTokens || 0),
                    finishReason: step.finishReason,
                });
            },
        });
        return {
            text: result.text,
            needsHuman: humanRequest,
            metrics: { modelCalls, toolCalls, inputTokens, outputTokens },
        };
    }
}
