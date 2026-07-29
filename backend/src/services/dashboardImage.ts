import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

interface DashboardImageOptions {
    launcher?: typeof chromium;
    executablePath?: string;
}

export class DashboardImageService {
    private readonly launcher: typeof chromium;
    private readonly executablePath?: string;

    constructor(options: DashboardImageOptions = {}) {
        this.launcher = options.launcher || chromium;
        this.executablePath = options.executablePath;
    }

    async render(htmlPath: string): Promise<string> {
        const imagePath = htmlPath.replace(/\.html$/i, '.png');
        const browser = await this.launcher.launch({
            headless: true,
            executablePath: this.executablePath || this.resolveExecutablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        try {
            const page = await browser.newPage({
                viewport: { width: 1600, height: 900 },
                deviceScaleFactor: 1,
            });
            await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
            await page.screenshot({ path: imagePath, fullPage: true, type: 'png' });
            return imagePath;
        } finally {
            await browser.close();
        }
    }

    private resolveExecutablePath(): string {
        const configured = process.env.CHROMIUM_EXECUTABLE_PATH;
        const candidates = [
            configured,
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ].filter((value): value is string => !!value);
        const executable = candidates.find(candidate => existsSync(candidate));
        if (!executable) {
            throw new Error('Chromium executable not found; set CHROMIUM_EXECUTABLE_PATH');
        }
        return executable;
    }
}
