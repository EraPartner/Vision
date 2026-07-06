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

    async function putSetting(key: string, value: unknown): Promise<void> {
        const res = await fetch(`${apiBase}/api/settings/${key}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
        });
        if (!res.ok) {
            throw new Error(
                `global-setup: could not set ${key} (HTTP ${res.status} from ${apiBase})`,
            );
        }
    }

    // Dismiss the first-run onboarding wizard (a backend setting, not localStorage).
    await putSetting("onboarding_complete", true);

    // Enable adminMode so RequireAdmin lets the /admin* routes render (the Admin
    // overview + exchange-rates specs navigate there). adminMode lives in the
    // app_settings blob; the store merges a stored blob over defaults, so a
    // minimal { adminMode: true } is enough for the suite.
    await putSetting("app_settings", { adminMode: true });
}

export default globalSetup;
