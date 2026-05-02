import { defineConfig, devices } from "@playwright/test";

const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ??
    (process.env.CI ? "http://localhost:3002" : "http://localhost:8080");

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "html",

    use: {
        baseURL,
        trace: "on-first-retry",
    },

    snapshotDir: "./e2e/__screenshots__",
    expect: {
        toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
    },

    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],

    // In CI the Docker Compose stack is already running; locally, boot the full
    // dev stack (frontend + backend) from the workspace root so vite's API proxy
    // to :3002 works out of the box.
    ...(!process.env.CI && {
        webServer: {
            command: "cd ../.. && bun run dev",
            url: "http://localhost:8080",
            reuseExistingServer: true,
            timeout: 120_000,
        },
    }),
});
