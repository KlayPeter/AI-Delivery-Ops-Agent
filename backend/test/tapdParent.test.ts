import { describe, test } from 'bun:test';
import { TapdAdapter } from '../src/adapters/tapd';
import { loadConfig } from '../src/core/config';

describe('TapdParent Script', () => {
    test.skip('should create parent and child story', async () => {
        const config = loadConfig();
        const tapd = new TapdAdapter(config.tapd, false);
        console.log("Creating parent...");
        const parent = await tapd.createStory("API自动化测试", "吴经理", "Middle", undefined, "这是个父任务");
        console.log("Parent:", parent);

        if (parent.ok && parent.story_id) {
            console.log("Creating child...");
            const child = await tapd.createStory("子任务：自动化测试", "吴经理", "Middle", undefined, "这是个子任务", parent.story_id);
            console.log("Child:", child);
        }
    });
});
