import { test, expect } from "./fixtures";

test.describe("high-risk write journeys", () => {
  test("Vision CSV upload reaches review, commits, and appears in Transactions", async ({
    page,
  }) => {
    const unique = Date.now();
    const recipient = `E2E IMPORT ${unique}`;
    const memo = `E2E CSV ${unique}`;
    const csv = [
      "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment",
      `2026-09-04,E2E IMPORT ACCOUNT,${recipient},${memo},-12.34,EUR,987.66,,`,
    ].join("\n");

    await page.goto("/import");
    await expect(
      page.getByRole("heading", { level: 1, name: /import & export/i }),
    ).toBeVisible();

    await page.getByLabel("Bank Source").click();
    await page.getByRole("option", { name: "Vision", exact: true }).click();
    await page.locator('input[type="file"][accept=".csv"]').setInputFiles({
      name: `vision-e2e-${unique}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await expect(page.getByText(`vision-e2e-${unique}.csv`)).toBeVisible();

    await page
      .getByRole("button", { name: "Import transactions", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Review Import" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: `new ${recipient}` }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: /Approve & Import \(1 rows\)/i })
      .click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Import complete" }),
    ).toBeVisible({ timeout: 30_000 });

    await page.goto(`/transactions?search=${encodeURIComponent(memo)}`);
    await expect(
      page.getByRole("row").filter({ hasText: recipient }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("transaction can be created, edited, and deleted through the UI", async ({
    page,
  }) => {
    const unique = Date.now();
    const recipient = `E2E TX RECIPIENT ${unique}`;
    const memo = `E2E TX ${unique}`;
    const editedMemo = `${memo} EDITED`;
    const account = `E2E TX ACCOUNT ${unique}`;

    await page.goto("/recipients");
    await page
      .getByRole("button", { name: /add recipient/i })
      .first()
      .click();
    await page.getByLabel(/^name$/i).fill(recipient);
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(
      page.getByText(recipient, { exact: true }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    await page.goto("/transactions");
    await page
      .getByRole("button", { name: /add transaction/i })
      .first()
      .click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel(/amount/i).fill("42.50");
    await createDialog.getByLabel(/bank account/i).click();
    await page.getByPlaceholder(/search or type a new account/i).fill(account);
    await page.getByRole("option", { name: /create account/i }).click();
    await createDialog.getByLabel(/^recipient$/i).click();
    await page.getByPlaceholder("Search recipients…").fill(recipient);
    await page.getByRole("option", { name: recipient, exact: true }).click();
    await createDialog.getByLabel(/description.*memo/i).fill(memo);
    await createDialog.getByRole("button", { name: /^create$/i }).click();

    const createdRow = page
      .getByRole("row")
      .filter({ hasText: recipient })
      .first();
    await expect(createdRow).toBeVisible({ timeout: 15_000 });
    await createdRow.getByLabel(/transaction info/i).click();

    const infoDialog = page.getByRole("dialog");
    await infoDialog
      .getByText(memo, { exact: true })
      .locator("..")
      .getByTitle("Edit")
      .click();
    await infoDialog.getByLabel("Description").fill(editedMemo);
    await infoDialog.getByRole("button", { name: "Save" }).click();
    await expect(
      infoDialog.getByText(editedMemo, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(`/transactions?search=${encodeURIComponent(editedMemo)}`);

    const editedRow = page
      .getByRole("row")
      .filter({ hasText: recipient })
      .first();
    await expect(editedRow).toBeVisible();
    await editedRow.getByLabel("Delete transaction").click();
    const confirmDialog = page.getByRole("alertdialog", {
      name: "Delete transaction",
    });
    await confirmDialog.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("row").filter({ hasText: recipient }),
    ).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: recipient }),
    ).toHaveCount(0, { timeout: 15_000 });
  });
});
