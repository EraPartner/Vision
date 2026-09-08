import { test, expect } from "./fixtures";

test.describe("keyboard and reduced-motion acceptance", () => {
  test("skip link is the first app tab stop and targets main content", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await page.evaluate(() => document.body.removeAttribute("tabindex"));
    await expect(skipLink).toHaveAttribute("href", "#main");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("main")).toBeFocused();
  });

  test("transaction rows support arrow navigation, details, and focus return", async ({
    page,
  }) => {
    await page.goto("/transactions");
    await expect(
      page.getByRole("heading", { level: 1, name: "Transactions" }),
    ).toBeVisible();

    const rows = page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Transaction info" }) });
    const first = rows.nth(0);
    const second = rows.nth(1);
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();

    await page.keyboard.press("Enter");
    const quickLook = page.getByRole("dialog");
    await expect(quickLook).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(quickLook).not.toBeVisible();
    await expect(first).toBeFocused();

    await page.keyboard.press("Space");
    await expect(quickLook).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(quickLook).not.toBeVisible();
    await expect(first).toBeFocused();
  });

  test("account combobox closes with Escape and returns focus", async ({
    page,
  }) => {
    await page.goto("/transactions");
    const addButton = page.getByRole("button", { name: "Add transaction" });
    await addButton.click();

    const dialog = page.getByRole("dialog");
    const accountTrigger = dialog.getByLabel("Bank Account");
    await accountTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).not.toBeVisible();
    await expect(accountTrigger).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(addButton).toBeFocused();
  });

  test("reduced-motion media disables dialog animation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/transactions");
    await page.getByRole("button", { name: "Add transaction" }).click();

    await expect
      .poll(() =>
        page.evaluate(
          () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.getByRole("dialog").evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.animationName, style.transitionDuration];
        }),
      )
      .toEqual(["none", "0s"]);
  });
});
