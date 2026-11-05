import { createReleasePlugin } from '@/domains/release/plugin';
import { mixedSourcePort } from './plugin';
export const mixedReleasePlugin = createReleasePlugin(mixedSourcePort);
export default mixedReleasePlugin;
