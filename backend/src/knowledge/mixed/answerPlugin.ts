import { createKnowledgeAnswerPlugin } from '../answer/plugin';
import { mixedSourcePort } from './plugin';
export const knowledgeMixedAnswerPlugin = createKnowledgeAnswerPlugin(mixedSourcePort);
export default knowledgeMixedAnswerPlugin;
