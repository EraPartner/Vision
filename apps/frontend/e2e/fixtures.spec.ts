import { test } from "./fixtures";

test("automatic page-error fixture rejects an uncaught browser error", async ({
  page,
}) => {
  test.fail();
  const pageError = page.waitForEvent("pageerror");
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("fixture-contract-sentinel");
    }, 0);
  });
  await pageError;
});
