import { describe, expect, test } from "bun:test";
import { DashboardImageService } from "@/services/dashboardImage";

describe("DashboardImageService", () => {
    test("uses a real browser page contract to capture the complete HTML document", async () => {
        const calls: any = {};
        const launcher = {
            launch: async (options: any) => {
                calls.launch = options;
                return {
                    newPage: async (options: any) => {
                        calls.page = options;
                        return {
                            goto: async (url: string, options: any) => { calls.goto = { url, options }; },
                            screenshot: async (options: any) => { calls.screenshot = options; },
                        };
                    },
                    close: async () => { calls.closed = true; },
                };
            },
        };
        const service = new DashboardImageService({ launcher: launcher as any, executablePath: "/fake/chromium" });

        const imagePath = await service.render("/tmp/dashboard snapshot.html");

        expect(imagePath).toBe("/tmp/dashboard snapshot.png");
        expect(calls.launch).toMatchObject({ headless: true, executablePath: "/fake/chromium" });
        expect(calls.page).toMatchObject({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
        expect(calls.goto.url).toBe("file:///tmp/dashboard%20snapshot.html");
        expect(calls.screenshot).toMatchObject({ path: imagePath, fullPage: true, type: "png" });
        expect(calls.closed).toBe(true);
    });
});
