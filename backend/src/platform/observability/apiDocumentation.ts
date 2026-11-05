import { swagger } from '@elysiajs/swagger';

export const API_DOCUMENTATION_PATH = '/api/swagger';
export const API_OPENAPI_PATH = `${API_DOCUMENTATION_PATH}/json`;

export function createApiDocumentation() {
    return swagger({
        path: API_DOCUMENTATION_PATH,
        documentation: {
            info: {
                title: 'Demo Project AI 中台 API',
                version: '1.0.0',
                description: 'AI Delivery Ops Agent 后端 HTTP API 文档。',
            },
        },
    });
}
