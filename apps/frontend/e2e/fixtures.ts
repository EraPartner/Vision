import { expect, test as base } from "@playwright/test";

type AutomaticFixtures = {
  assertNoPageErrors: void;
};

export const test = base.extend<AutomaticFixtures>({
  assertNoPageErrors: [
    async ({ page }, runTest) => {
      const errors: string[] = [];
      const collect = (error: Error) => errors.push(error.message);
      page.on("pageerror", collect);
      try {
        await runTest();
      } finally {
        page.off("pageerror", collect);
        expect(errors, "uncaught browser page errors").toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
