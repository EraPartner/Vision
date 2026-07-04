import type { FullConfig } from "@playwright/test";

/**
 * Global setup for the e2e suite.
 *
 * The app shows a first-run OnboardingWizard modal until onboarding is marked
 * complete. Completion is persisted as a BACKEND setting
 * (`apiClient.saveSetting('onboarding_complete', true)`), not localStorage — so
 * on the fresh Docker stack the wizard covers every page and every page-content
 * assertion fails. Mark it complete once, up-front, via the settings API so the
 * suite exercises the real pages.
 *
 * The backend is always reachable at :3002 (in CI it is the whole stack; in
 * local dev it is the API behind Vite). PLAYWRIGHT_BASE_URL is :3002 in CI.
 */
async function globalSetup(_config: FullConfig): Promise<void> {
    const apiBase = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3002";
    const res = await fetch(`${apiBase}/api/settings/onboarding_complete`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: true }),
    });
    if (!res.ok) {
        throw new Error(
            `global-setup: could not mark onboarding complete (HTTP ${res.status} from ${apiBase})`,
        );
    }
}

export default globalSetup;
