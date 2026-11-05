import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { MeetingSummaryHandler } from '@/services/messageHandler/handlers/MeetingSummaryHandler';

export const meetingSummaryPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.meeting-summary', name: 'Meeting summary', version: '1.0.0', description: 'Meeting message routing, subject to the existing module switch.' },
    messageRoutes: [{
        id: 'builtin.meeting-summary', priority: 500, sources: ['group', 'private'], requiresProjectMember: true,
        handle: ({ ctx, message, source }) => MeetingSummaryHandler.maybeHandle(ctx, message, source),
    }],
    apply() {},
};
