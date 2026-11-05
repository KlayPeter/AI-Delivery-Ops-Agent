import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
    API_DOCUMENTATION_PATH,
    API_OPENAPI_PATH,
    createApiDocumentation,
} from '../src/platform/observability/apiDocumentation';

describe('API documentation', () => {
    const app = new Elysia()
        .use(createApiDocumentation())
        .get('/api/example', () => ({ ok: true }));

    test('serves Swagger UI below the proxied /api prefix', async () => {
        const response = await app.handle(new Request(`http://localhost${API_DOCUMENTATION_PATH}`));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(await response.text()).toContain('Demo Project AI 中台 API');
    });

    test('serves an OpenAPI document containing registered API routes', async () => {
        const response = await app.handle(new Request(`http://localhost${API_OPENAPI_PATH}`));
        const document = await response.json() as any;

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(document.info).toMatchObject({
            title: 'Demo Project AI 中台 API',
            version: '1.0.0',
        });
        expect(document.paths['/api/example']?.get).toBeDefined();
    });
});
