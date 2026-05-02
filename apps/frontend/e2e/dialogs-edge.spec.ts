/**
 * Playwright E2E — dialog edge cases that jsdom can't reliably test.
 *
 * Covers:
 *   - True backdrop / overlay click closes Radix dialogs
 *   - Tab focus traversal stays inside dialog (focus trap)
 *   - Escape key closes (in real browser, not jsdom polyfill)
 *   - First focusable element receives autofocus on open
 *
 * Each test opens a real dialog, performs the user gesture, asserts the
 * dialog closes (or focus moves) — exactly what a user would do.
 */
import { test, expect, Page } from "@playwright/test";

async function openAddTransactionDialog(page: Page) {
    await page.goto("/transactions");
    await page.getByRole("button", { name: /add transaction/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
}

async function openAddCategoryDialog(page: Page) {
    await page.goto("/categories");
    await page.getByRole("button", { name: /add category/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
}

async function openAddRecipientDialog(page: Page) {
    await page.goto("/recipients");
    await page.getByRole("button", { name: /add recipient/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
}

async function openWidgetVisibilityDialog(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /widgets/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("Dialog backdrop click", () => {
    test("AddTransaction backdrop click closes dialog", async ({ page }) => {
        await openAddTransactionDialog(page);
        // Click far outside the dialog content (top-left corner)
        await page.mouse.click(5, 5);
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
    });

    test("AddCategory backdrop click closes dialog", async ({ page }) => {
        await openAddCategoryDialog(page);
        await page.mouse.click(5, 5);
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
    });

    test("AddRecipient backdrop click closes dialog", async ({ page }) => {
        await openAddRecipientDialog(page);
        await page.mouse.click(5, 5);
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
    });

    test("WidgetVisibility backdrop click closes dialog", async ({ page }) => {
        await openWidgetVisibilityDialog(page);
        await page.mouse.click(5, 5);
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
    });
});

test.describe("Dialog Escape key (real browser)", () => {
    test("AddTransaction Escape closes dialog", async ({ page }) => {
        await openAddTransactionDialog(page);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
    });

    test("AddCategory Escape closes dialog", async ({ page }) => {
        await openAddCategoryDialog(page);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
    });
});

test.describe("Dialog focus trap (Tab keyboard nav)", () => {
    test("AddTransaction Tab key cycles focus inside dialog", async ({ page }) => {
        await openAddTransactionDialog(page);
        // Press Tab a few times. Active element must always be inside the dialog.
        const dialogHandle = await page.getByRole("dialog").elementHandle();
        for (let i = 0; i < 8; i++) {
            await page.keyboard.press("Tab");
            const isInsideDialog = await page.evaluate((dialog) => {
                const active = document.activeElement;
                return dialog?.contains(active) ?? false;
            }, dialogHandle);
            expect(isInsideDialog).toBe(true);
        }
    });

    test("AddCategory Tab key cycles focus inside dialog", async ({ page }) => {
        await openAddCategoryDialog(page);
        const dialogHandle = await page.getByRole("dialog").elementHandle();
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press("Tab");
            const isInsideDialog = await page.evaluate((dialog) => {
                const active = document.activeElement;
                return dialog?.contains(active) ?? false;
            }, dialogHandle);
            expect(isInsideDialog).toBe(true);
        }
    });

    test("AddRecipient Shift+Tab reverses focus inside dialog", async ({ page }) => {
        await openAddRecipientDialog(page);
        const dialogHandle = await page.getByRole("dialog").elementHandle();
        for (let i = 0; i < 4; i++) {
            await page.keyboard.press("Shift+Tab");
            const isInsideDialog = await page.evaluate((dialog) => {
                const active = document.activeElement;
                return dialog?.contains(active) ?? false;
            }, dialogHandle);
            expect(isInsideDialog).toBe(true);
        }
    });
});

test.describe("Dialog autofocus on open", () => {
    test("AddTransaction places initial focus inside dialog", async ({ page }) => {
        await openAddTransactionDialog(page);
        // Radix focuses the first focusable element by default
        const dialogHandle = await page.getByRole("dialog").elementHandle();
        const focusInside = await page.evaluate(
            (dialog) => dialog?.contains(document.activeElement) ?? false,
            dialogHandle,
        );
        expect(focusInside).toBe(true);
    });
});
