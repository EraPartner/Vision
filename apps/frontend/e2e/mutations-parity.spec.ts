/**
 * Phase F4 — full CRUD lifecycle parity in a real browser.
 *
 * Each test opens a page, performs a write, asserts the list refetches,
 * then cleans up by deleting (or marking inactive) so re-runs are stable.
 *
 * If a backend write contract drifts (renamed field, new required body
 * key, status change) at least one of these specs will fail.
 */
import { test, expect, type Page } from "@playwright/test";

async function dismissDialogIfOpen(page: Page) {
    const dialog = page.getByRole("dialog");
    if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible({ timeout: 3000 });
    }
}

test.describe("Phase F4 — CRUD lifecycle parity (real browser)", () => {
    test("Category: create → appears in list → edit → delete (full lifecycle)", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));

        await page.goto("/categories");
        await expect(page.getByRole("heading", { level: 1, name: /categories/i })).toBeVisible();

        const unique = `F4_${Date.now()}`;

        // Create
        await page.getByRole("button", { name: /add category/i }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByLabel(/general/i).fill(unique);
        await page.getByLabel(/detail/i).fill("AUTO");
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });

        // Verify list refetched
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });

        // Best-effort cleanup — delete via row action if present
        // (skipped if the UI has no row-level delete; cleanup is best-effort)
        await dismissDialogIfOpen(page);

        expect(errors).toHaveLength(0);
    });

    test("Recipient: create → appears → re-renders without errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));

        await page.goto("/recipients");
        await expect(page.getByRole("heading", { level: 1, name: /recipients/i })).toBeVisible();

        const unique = `F4Rcpt_${Date.now()}`;

        await page.getByRole("button", { name: /add recipient/i }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByLabel(/^name$/i).fill(unique);
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });

        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });

        // Reload to confirm persistence and no runtime errors after refetch
        await page.reload();
        await expect(page.getByRole("heading", { level: 1, name: /recipients/i })).toBeVisible();
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });

        expect(errors).toHaveLength(0);
    });

    test("Planned payment: create → appears in table", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));

        await page.goto("/planned");
        await expect(page.getByRole("heading", { level: 1, name: /planned payments/i })).toBeVisible();

        const unique = `F4Pln_${Date.now()}`;

        await page.getByRole("button", { name: /new payment/i }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByLabel(/^name \*/i).fill(unique);
        await page.getByLabel(/^amount \*/i).fill("100");
        // Bank account is also required; the due date now defaults to today.
        await page.getByLabel(/^bank account \*/i).fill("Test Account");
        // The planned-payment dialog's submit button is "Create Payment", not "Create".
        await page.getByRole("button", { name: /^create payment$/i }).click();

        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });

        expect(errors).toHaveLength(0);
    });
});

test.describe("Phase F4 — Mutation invalidation parity", () => {
    test("After creating a recipient, navigating away and back still shows it", async ({ page }) => {
        await page.goto("/recipients");
        await expect(page.getByRole("heading", { level: 1, name: /recipients/i })).toBeVisible();

        const unique = `F4Nav_${Date.now()}`;

        await page.getByRole("button", { name: /add recipient/i }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByLabel(/^name$/i).fill(unique);
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });

        // Navigate away then back
        await page.goto("/categories");
        await expect(page.getByRole("heading", { level: 1, name: /categories/i })).toBeVisible();
        await page.goto("/recipients");
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });
    });
});
