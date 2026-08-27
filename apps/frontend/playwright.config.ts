import { defineConfig, devices } from "@playwright/test";

const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ??
    (process.env.CI ? "http://localhost:3002" : "http://localhost:8080");

export default defineConfig({
    testDir: "./e2e",
    // Mark first-run onboarding complete before any test so the OnboardingWizard
    // modal doesn't cover every page (see e2e/global-setup.ts).
    globalSetup: "./e2e/global-setup.ts",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI
        ? [["html", { open: "never" }], ["github"], ["list"]]
        : "html",

    timeout: 90_000,

    use: {
        baseURL,
        trace: "on-first-retry",
        navigationTimeout: 60_000,
        actionTimeout: 30_000,
    },

    snapshotDir: "./e2e/__screenshots__",
    expect: {
        toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
    },

    projects: [
        {
            name: "chromium",
            testIgnore: "**/visual.spec.ts",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "visual-chromium",
            testMatch: "**/visual.spec.ts",
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
