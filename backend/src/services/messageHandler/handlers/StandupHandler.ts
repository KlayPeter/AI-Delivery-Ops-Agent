import { HandlerContext } from '../types';
import { SourceMessage } from '@/models/types';
import { StandupService } from '@/services/standupService';

export class StandupHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        return StandupService.handlePrivateMessage(ctx, message, source, replyContext);
    }
}
