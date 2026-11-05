import { createMeetingSummaryApi } from '@/services/messageHandler/meeting-summary/api';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { MeetingSummaryHandler } from '@/services/messageHandler/handlers/MeetingSummaryHandler';

export const meetingSummaryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.meeting-summary', name: 'Meeting summary', version: '1.0.0', description: 'Meeting message routing, subject to the existing module switch.' },
    messageRoutes: [{
        id: 'builtin.meeting-summary', priority: 500, sources: ['group', 'private'], requiresProjectMember: true,
        handle: ({ ctx, message, source }) => MeetingSummaryHandler.maybeHandle(ctx, message, source),
    }],
    apply(ctx) {
        const api = createMeetingSummaryApi(ctx.delivery.getContext);
        ctx.delivery.web.register({ id: 'builtin.meeting-summary',
            pages: [{ path: '/meeting-summaries', label: '会议纪要', section: 'team', navigation: false, view: { kind: 'builtin', id: 'meeting-summaries' } }],
            api: { prefix: '/api/meeting-summaries', routes: api.routes.map(route => ({ method: route.method, path: route.path })), handle: request => api.handle(request) },
        });
    },
};
