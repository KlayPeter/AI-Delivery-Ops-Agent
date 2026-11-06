import { z } from 'zod';
import { Elysia } from 'elysia';
import { isLocalWorkspaceRequest } from '@/platform/workspace/connections';

const pageSchema = z.object({
    path: z.string().regex(/^\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/).max(200),
    label: z.string().trim().min(1).max(80), section: z.enum(['workspace', 'team']), navigation: z.boolean().optional(),
    view: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('builtin'), id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(80), capability: z.string().trim().min(1).max(200).optional() }).strict(),
        z.object({ kind: z.literal('agent'), capability: z.string().trim().min(1).max(200) }).strict(),
    ]),
}).strict();
export type PluginPage = z.infer<typeof pageSchema>;
type ApiHandler = (request: Request) => Response | Promise<Response>;
const routeSchema = z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL']), path: z.string().regex(/^\/api(?:\/[A-Za-z0-9:_*-]+)+$/).max(300) }).strict();
export interface WebContribution {
    id: string;
    pages?: readonly PluginPage[];
    manualJobs?: readonly string[];
    api?: { prefix: string; routes: readonly { method: string; path: string }[]; handle: ApiHandler };
}
// Existing bundled routes stay reserved until their owning plugins migrate them.
const reservedPages = new Set(['/', '/runs', '/agents', '/plugins', '/connections', '/logs', '/debug', '/contexts', '/config']);
const reservedApis = ['/api/workspace', '/api/config', '/api/agents', '/api/agent-runs', '/api/bots', '/api/jobs', '/api/health', '/api/logs', '/api/contexts', '/api/feishu', '/api/swagger'];
const contains = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + '/');

export class PluginWebRegistry {
    private readonly entries = new Map<string, WebContribution>();

    register(value: WebContribution): () => void {
        const entry = z.object({
            id: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128), pages: z.array(pageSchema).max(20).optional(),
            manualJobs: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/).max(80)).max(30).optional(),
            api: z.object({ prefix: z.string().regex(/^\/api(?:\/[a-z][a-z0-9-]*)+$/).max(200), routes: z.array(routeSchema).min(1).max(100), handle: z.custom<ApiHandler>(value => typeof value === 'function') }).strict().optional(),
        }).strict().parse(value);
        if (this.entries.has(entry.id)) throw new Error(`Duplicate Web contribution: ${entry.id}`);
        const paths = (entry.pages || []).map(page => page.path), jobs = entry.manualJobs || [];
        if (new Set(paths).size !== paths.length || paths.some(path => reservedPages.has(path) || this.pages().some(page => page.path === path))) throw new Error('Duplicate or reserved plugin page path');
        if (new Set(jobs).size !== jobs.length || jobs.some(job => this.manualJobs().includes(job))) throw new Error('Duplicate plugin manual job');
        if (entry.api && (entry.api.routes.some(route => !contains(entry.api!.prefix, route.path)) || new Set(entry.api.routes.map(route => `${route.method}:${route.path}`)).size !== entry.api.routes.length)) throw new Error('Invalid plugin API route declarations');
        if (entry.api && (reservedApis.some(prefix => contains(prefix, entry.api!.prefix) || contains(entry.api!.prefix, prefix))
            || [...this.entries.values()].some(other => other.api && (contains(other.api.prefix, entry.api!.prefix) || contains(entry.api!.prefix, other.api.prefix))))) throw new Error('Overlapping or reserved plugin API prefix');
        if (entry.api) {
            const router = new Elysia(), handle = entry.api.handle;
            for (const route of entry.api.routes) router.route(route.method, route.path, ({ request }) => handle(request), { parse: 'none' });
            router.all('*', () => Response.json({ error: '当前插件未提供此接口' }, { status: 404 }), { parse: 'none' });
            entry.api.handle = request => router.handle(request);
        }
        this.entries.set(entry.id, entry);
        return () => { if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id); };
    }

    pages(): PluginPage[] { return structuredClone([...this.entries.values()].flatMap(entry => entry.pages || [])); }
    manualJobs(): string[] { return [...this.entries.values()].flatMap(entry => entry.manualJobs || []); }
    routes(): z.infer<typeof routeSchema>[] { return [...this.entries.values()].flatMap(entry => entry.api?.routes || []).map(route => routeSchema.parse(route)); }

    async handle(request: Request): Promise<Response> {
        if (!isLocalWorkspaceRequest(request)) return Response.json({ error: '插件 API 仅接受本机页面请求' }, { status: 403 });
        const pathname = new URL(request.url).pathname;
        const entry = [...this.entries.values()].find(entry => entry.api && contains(entry.api.prefix, pathname));
        return entry?.api ? entry.api.handle(request) : Response.json({ error: '当前插件未提供此接口' }, { status: 404 });
    }
}
