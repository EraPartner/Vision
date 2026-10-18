import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

// This suite writes synthetic fixtures. Only the disposable native-stack runner
// may opt in; an arbitrary local Vision URL is never a valid target.
const base = process.env.VISION_BROWSER_BASE;
if (
  process.env.VISION_DISPOSABLE_NATIVE_STACK !== "1" ||
  !base ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)
) {
  throw new Error(
    "Run browser tests through .github/scripts/with-native-stack.sh; an isolated synthetic database is required.",
  );
}
const modulePath = process.env.VISION_PLAYWRIGHT_MODULE;
if (!modulePath)
  throw new Error(
    "Set VISION_PLAYWRIGHT_MODULE to the installed playwright/index.mjs (pinned CI version: 1.62.1).",
  );
const { chromium } = await import(pathToFileURL(modulePath).href);
let browser;
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.ok, true);
  return envelope.data;
}
async function setting(key, value) {
  const current = await api("/settings?withBaselines=true");
  return api(`/settings/${key}`, "PUT", {
    value,
    expected: current.expected[key] ?? { exists: false },
  });
}
async function waitUntil(read, predicate, message) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}
async function pageAt(path, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({
    viewport,
    locale: "en-GB",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.goto(`${base}${path}`);
  return { context, page };
}
before(async () => {
  await setting("onboarding_complete", true);
  await setting("belgian_tax_profile", {});
  await setting("belgian_tax_profile_snapshots_v1", {});
  await setting("belgian_tax_profile_snapshot_meta_v1", {});
  const layoutAccount = await api("/accounts", "POST", {
    name: "Synthetic responsive statistics",
    currency: "EUR",
    type: "checking",
  });
  const layoutRecipient = await api("/recipients", "POST", {
    name: "Synthetic responsive recipient",
  });
  await api("/transactions", "POST", {
    transaction_date: new Date().toISOString().slice(0, 10),
    account_id: layoutAccount.id,
    recipient_id: layoutRecipient.id,
    currency: "EUR",
    amount: -12.34,
    memo: "Synthetic visible statistics fixture",
  });
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

test("closing an empty account persists after a fresh browser context", async () => {
  const account = await api("/accounts", "POST", {
    name: "Browser synthetic close",
    currency: "EUR",
    type: "checking",
  });
  let { context, page } = await pageAt(`/accounts/${account.id}`);
  try {
    await page.getByRole("button", { name: "Account actions" }).click();
    await page
      .getByRole("menuitem", { name: "Close account", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close account", exact: true })
      .click();
    await waitUntil(
      () => api(`/accounts/${account.id}`),
      (value) => value.is_active === false,
      "account closure was not persisted",
    );
  } finally {
    await context.close();
  }
  ({ context, page } = await pageAt(`/accounts/${account.id}`));
  try {
    await page.getByRole("button", { name: "Account actions" }).click();
    await page.getByRole("menuitem", { name: /reopen/i }).waitFor();
  } finally {
    await context.close();
  }
});

test("closing nonzero multicurrency cash conserves each currency after reopening", async () => {
  const account = await api("/accounts", "POST", {
    name: "Browser synthetic multicurrency close",
    currency: "EUR",
    type: "checking",
    multi_currency_cash: true,
  });
  const recipient = await api("/recipients", "POST", {
    name: "Browser close fixture",
  });
  for (const [currency, amount] of [
    ["EUR", 12.34],
    ["USD", -56.78],
  ]) {
    await api("/transactions", "POST", {
      transaction_date: "2025-06-01",
      account_id: account.id,
      recipient_id: recipient.id,
      currency,
      amount,
      memo: `Synthetic close ${currency}`,
    });
  }
  const readParts = async () =>
    (await api("/accounts")).items.find((row) => row.id === account.id);
  const before = await readParts();
  assert.deepEqual(
    before.balance_parts.map(({ currency, balance }) => [
      currency,
      Number(balance),
    ]),
    [
      ["EUR", 12.34],
      ["USD", -56.78],
    ],
  );
  const { context, page } = await pageAt(`/accounts/${account.id}`);
  try {
    await page.getByRole("button", { name: "Account actions" }).click();
    await page
      .getByRole("menuitem", { name: "Close account", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("checkbox", { name: /Zero the account balance/ })
      .check();
    await dialog
      .getByRole("button", { name: "Close account", exact: true })
      .click();
    await waitUntil(
      readParts,
      (row) => row.is_active === false,
      "multicurrency account not closed",
    );
  } finally {
    await context.close();
  }
  const reopened = await pageAt(`/accounts/${account.id}`);
  try {
    await reopened.page
      .getByRole("button", { name: "Account actions" })
      .click();
    await reopened.page.getByRole("menuitem", { name: /reopen/i }).waitFor();
    const after = await readParts();
    assert.ok(after.balance_parts.length >= 2);
    for (const part of after.balance_parts)
      assert.equal(
        Number(part.balance),
        0,
        `${part.currency} did not conserve`,
      );
    const rows = (await api(`/transactions?account_id=${account.id}`)).items;
    for (const currency of ["EUR", "USD"]) {
      const parts = rows.filter((row) => row.currency === currency);
      assert.equal(
        parts.length,
        2,
        "one original and one adjustment per currency",
      );
      assert.equal(
        parts.reduce(
          (sum, row) => sum + Math.round(Number(row.amount) * 100),
          0,
        ),
        0,
      );
    }
  } finally {
    await reopened.context.close();
  }
});

test("widget changes survive navigating away during the save debounce", async () => {
  await setting("widget_visibility", {
    dashboard: { recentTransactions: true },
  });
  let { context, page } = await pageAt("/");
  try {
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /customize/i }).click();
    const toggle = page.getByRole("switch", {
      name: "Recent transactions",
      exact: true,
    });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await page.keyboard.press("Escape");
    // Route change unmounts Dashboard; the app stays alive to finish its save.
    await page
      .getByRole("link", { name: "Accounts", exact: true })
      .first()
      .click();
    await waitUntil(
      () => api("/settings/widget_visibility"),
      (value) => value.value?.dashboard?.recentTransactions === false,
      "widget change lost on route navigation",
    );
  } finally {
    await context.close();
  }
  ({ context, page } = await pageAt("/"));
  try {
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /customize/i }).click();
    assert.equal(
      await page
        .getByRole("switch", { name: "Recent transactions", exact: true })
        .getAttribute("aria-checked"),
      "false",
    );
  } finally {
    await context.close();
  }
});

test("filing exposes prerequisites and cannot persist an unprepared year", async () => {
  const { context, page } = await pageAt("/tax");
  try {
    await page.getByRole("button", { name: /mark as filed/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByText(/does not submit anything to a tax authority/i)
      .waitFor();
    await dialog.getByText(/set up and review the tax profile/i).waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: /mark as filed/i }).isEnabled(),
      false,
    );
  } finally {
    await context.close();
  }
});

test("prepared filing keeps its reference and frozen calculation after reopening", async () => {
  const year = 2025;
  await setting("belgian_tax_profile", {
    taxYear: year,
    profileConfigured: true,
    grossAnnualIncome: 40000,
  });
  let { context, page } = await pageAt("/tax");
  let saved;
  try {
    await page.getByRole("button", { name: /mark as filed/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Reference", { exact: true })
      .fill("Synthetic browser filing 2025");
    await dialog
      .getByRole("button", { name: "Mark as filed", exact: true })
      .click();
    saved = await waitUntil(
      () => api("/settings/belgian_tax_profile_snapshot_meta_v1"),
      (value) =>
        value.value?.[year]?.filing?.reference ===
        "Synthetic browser filing 2025",
      "filing reference was not persisted",
    );
    assert.ok(saved.value[year].frozenCalculation);
    await waitUntil(
      () => api("/settings/belgian_tax_profile_snapshots_v1"),
      (value) => value.value?.[year]?.grossAnnualIncome === 40000,
      "as-filed profile was not persisted",
    );
  } finally {
    await context.close();
  }
  ({ context, page } = await pageAt("/tax"));
  try {
    await page.getByRole("button", { name: /export.*csv/i }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: /mark as filed/i }).count(),
      0,
    );
    const reopened = await api(
      "/settings/belgian_tax_profile_snapshot_meta_v1",
    );
    assert.deepEqual(reopened.value[year], saved.value[year]);
  } finally {
    await context.close();
  }
});

test("CSV upload, review and commit produce one persisted transaction", async () => {
  const recipient = "Browser synthetic import recipient";
  const { context, page } = await pageAt("/import");
  try {
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "synthetic-browser.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `Date,Recipient,Amount,Memo\n2025-06-01,${recipient},-12.34,Synthetic browser import\n`,
        ),
      });
    await page.locator("#bank-select").click();
    await page
      .getByRole("option", { name: "Custom or other", exact: true })
      .click();
    await page
      .getByLabel("Parser name", { exact: true })
      .fill("Browser synthetic bank");
    for (const [id, column] of [
      ["date-column", "Date"],
      ["recipient-column", "Recipient"],
      ["amount-column", "Amount"],
      ["memo-column", "Memo"],
    ]) {
      await page.locator(`#${id}`).click();
      await page.getByRole("option", { name: column, exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Import transactions", exact: true })
      .click();
    await page.waitForURL(/\/import\/\d+\/review/);
    const batchId = new URL(page.url()).pathname.split("/")[2];
    await page.getByText(recipient, { exact: true }).first().waitFor();
    await page
      .getByRole("button", { name: "Import 1 rows", exact: true })
      .click();
    await page.waitForURL(/\/import$/);
    const result = await api(
      `/transactions?search=${encodeURIComponent(recipient)}`,
    );
    assert.equal(result.total, 1);
    assert.equal(Number(result.items[0].amount), -12.34);
    const duplicate = await fetch(
      `${base}/api/import/batches/${batchId}/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(
      duplicate.ok,
      false,
      "committed batch must reject another commit",
    );
    assert.equal(
      (await api(`/transactions?search=${encodeURIComponent(recipient)}`))
        .total,
      1,
    );
    await page.goto(
      `${base}/transactions?search=${encodeURIComponent(recipient)}`,
    );
    await page.getByText(recipient, { exact: true }).first().waitFor();
  } finally {
    await context.close();
  }
});

for (const width of [390, 1280]) {
  test(`Settings renders without horizontal overflow at ${width}px and supports keyboard sections`, async () => {
    const { context, page } = await pageAt("/?settings=general", {
      width,
      height: 900,
    });
    try {
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.getByText("Default currency", { exact: true }).waitFor();
      const overflows = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return (
          document.documentElement.scrollWidth > innerWidth + 1 ||
          (dialog &&
            (dialog.getBoundingClientRect().right > innerWidth + 1 ||
              dialog.getBoundingClientRect().left < -1))
        );
      });
      assert.equal(overflows, false, "Settings exceeds the real viewport");
      const general = dialog.getByRole("tab", { name: "General", exact: true });
      await general.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await dialog
        .getByRole("tab", { name: "Appearance", exact: true })
        .waitFor();
      assert.equal(
        await dialog
          .getByRole("tab", { name: "Appearance", exact: true })
          .getAttribute("aria-selected"),
        "true",
      );
    } finally {
      await context.close();
    }
  });
}

// These assertions inspect rendered geometry, not Tailwind spellings or grid counts.
for (const width of [390, 1280]) {
  test(`Add account dialog fits ${width}px and the geometry oracle rejects overflow`, async () => {
    const { context, page } = await pageAt("/accounts", { width, height: 900 });
    try {
      await page
        .getByRole("button", { name: "Add account", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const fits = () =>
        dialog.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= -1 &&
            rect.right <= innerWidth + 1 &&
            node.scrollWidth <= node.clientWidth + 1
          );
        });
      assert.equal(await fits(), true);
      const original = await dialog.getAttribute("style");
      try {
        // Equivalent style representation: spell the computed border sizing inline.
        await dialog.evaluate((node) => {
          node.style.boxSizing = getComputedStyle(node).boxSizing;
        });
        assert.equal(
          await fits(),
          true,
          "equivalent styling must remain accepted",
        );
        // Controlled regression: the oracle must catch a dialog wider than the viewport.
        await dialog.evaluate((node) => {
          node.style.minWidth = `${innerWidth + 200}px`;
        });
        assert.equal(
          await fits(),
          false,
          "geometry oracle failed to detect injected overflow",
        );
      } finally {
        await dialog.evaluate(
          (node, style) =>
            style === null
              ? node.removeAttribute("style")
              : node.setAttribute("style", style),
          original,
        );
      }
      assert.equal(await fits(), true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await context.close();
    }
  });
}

// Test the visible form boundary, including every visible input, instead of a
// particular grid implementation. Vertical scrolling is intentionally allowed.
async function assertFormFits(dialog, name) {
  await dialog.waitFor();
  const result = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const visible = [
      ...node.querySelectorAll(
        'input, textarea, select, button, [role="combobox"]',
      ),
    ].filter(
      (field) =>
        field.getClientRects().length &&
        getComputedStyle(field).visibility !== "hidden",
    );
    const escaped = visible.filter((field) => {
      const box = field.getBoundingClientRect();
      return (
        box.left < Math.max(0, rect.left) - 1 ||
        box.right > Math.min(innerWidth, rect.right) + 1
      );
    });
    return {
      controls: visible.length,
      fits:
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        node.scrollWidth <= node.clientWidth + 1,
      escaped: escaped.map(
        (field) =>
          field.getAttribute("aria-label") || field.id || field.textContent,
      ),
    };
  });
  assert.ok(result.controls > 0, `${name} has no visible controls`);
  assert.equal(result.fits, true, `${name} exceeds its viewport`);
  assert.deepEqual(
    result.escaped,
    [],
    `${name} contains clipped or overflowing controls`,
  );
}

const formJourneys = [
  {
    name: "Add transaction sheet",
    path: "/transactions",
    open: async (page) =>
      page
        .getByRole("button", { name: "Add transaction", exact: true })
        .first()
        .click(),
  },
  {
    name: "Planned payment form",
    path: "/planned",
    open: async (page) =>
      page
        .getByRole("button", { name: "Add payment", exact: true })
        .first()
        .click(),
  },
  {
    name: "Tax income step",
    path: "/tax",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Tax profile", exact: true })
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("radio", { name: "Income", exact: true })
        .click();
    },
  },
  {
    name: "Investment and price provider fields",
    path: "/portfolio/crypto",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Add investment", exact: true })
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("combobox", { name: "Live price source", exact: true })
        .click();
      await page.getByRole("option", { name: /^Custom JSON/ }).click();
      await page
        .getByRole("dialog")
        .locator('input[id$="-latest-url"]')
        .waitFor();
    },
  },
  {
    name: "Custom chart builder",
    path: "/statistics",
    open: async (page) => {
      await page
        .getByRole("tab", { name: "Custom charts", exact: true })
        .click();
      await page
        .getByRole("button", { name: "New chart", exact: true })
        .click();
    },
  },
  {
    name: "Appearance settings",
    path: "/?settings=appearance",
    open: async (page) =>
      page
        .getByRole("dialog")
        .getByRole("tab", { name: "Appearance", exact: true })
        .waitFor(),
  },
];
for (const width of [390, 1280]) {
  for (const journey of formJourneys) {
    test(`${journey.name} fields fit ${width}px without inspecting CSS source`, async () => {
      const { context, page } = await pageAt(journey.path, {
        width,
        height: 900,
      });
      try {
        await journey.open(page);
        const dialog = page.getByRole("dialog").last();
        await assertFormFits(dialog, journey.name);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
      } finally {
        await context.close();
      }
    });
  }
  test(`Reconcile fields fit ${width}px`, async () => {
    const account = await api("/accounts", "POST", {
      name: `Synthetic responsive reconcile ${width}`,
      currency: "EUR",
      type: "checking",
    });
    const { context, page } = await pageAt(`/accounts/${account.id}`, {
      width,
      height: 900,
    });
    try {
      await page
        .getByRole("button", { name: "Reconcile balance", exact: true })
        .click();
      await assertFormFits(
        page.getByRole("dialog").last(),
        "Reconcile balance",
      );
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    } finally {
      await context.close();
    }
  });
  test(`Import workspace and reference column fit ${width}px`, async () => {
    const { context, page } = await pageAt("/import", { width, height: 900 });
    try {
      const aside = page.locator("main aside");
      await aside.waitFor();
      const geometry = await aside.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        };
      });
      assert.ok(geometry.left >= -1 && geometry.right <= width + 1);
      assert.ok(geometry.scrollWidth <= geometry.viewport + 1);
      // The reference panel must remain in document flow when the user scrolls.
      const before = await aside.boundingBox();
      await page.evaluate(() => window.scrollBy(0, 150));
      const scrolled = await page.evaluate(() => scrollY);
      const after = await aside.boundingBox();
      assert.ok(before && after);
      assert.ok(
        Math.abs(before.y - after.y - scrolled) <= 2,
        "reference column sticks instead of following document scroll",
      );
    } finally {
      await context.close();
    }
  });
}

for (const width of [390, 1280]) {
  test(`Portfolio transaction, edit and export fields fit ${width}px`, async () => {
    const name = `Synthetic layout holding ${width}`;
    await api("/investments", "POST", {
      name,
      symbol: `LAYOUT${width}`,
      asset_class: "crypto",
      currency: "EUR",
      price_provider: "manual",
      current_price: 10,
    });
    const { context, page } = await pageAt("/portfolio/crypto", {
      width,
      height: 900,
    });
    try {
      const actions = () =>
        page
          .getByRole("button", { name: `Actions for ${name}`, exact: true })
          .first();
      await actions().click();
      await page
        .getByRole("menuitem", { name: "Add transaction", exact: true })
        .click();
      await assertFormFits(
        page.getByRole("dialog").last(),
        "Portfolio transaction",
      );
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await actions().click();
      await page
        .getByRole("menuitem", { name: "Details", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: `Edit: ${name}`, exact: true })
        .click();
      const edit = page.getByRole("dialog", {
        name: "Edit investment",
        exact: true,
      });
      await assertFormFits(edit, "Edit investment");
      await page.keyboard.press("Escape");
      await edit.waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "More actions", exact: true })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "Export PDF…", exact: true })
        .click();
      const exportDialog = page.getByRole("dialog").last();
      await assertFormFits(exportDialog, "Export PDF report");
      await page.keyboard.press("Escape");
      await exportDialog.waitFor({ state: "hidden" });
      const unchanged = (
        await api("/investments?asset_class=crypto")
      ).items.find((holding) => holding.name === name);
      assert.ok(
        unchanged,
        "read-only geometry interactions removed the holding",
      );
      assert.equal(Number(unchanged.current_price), 10);
      assert.equal(
        (await api(`/investments/${unchanged.id}/transactions`)).items.length,
        0,
        "opening forms must not record a purchase",
      );
    } finally {
      await context.close();
    }
  });
}

const loneWidgets = [
  {
    path: "/",
    scope: "dashboard",
    ids: [
      "hero",
      "attention",
      "netWorth",
      "upcoming",
      "accounts",
      "statCards",
      "bankBalances",
      "monthlyTrends",
      "categoryPie",
      "cashflowComparison",
      "recentTransactions",
    ],
    enabled: "monthlyTrends",
    heading: "Last 6 months",
  },
  {
    path: "/statistics",
    scope: "statistics",
    ids: [
      "summaryCards",
      "monthly",
      "netTrend",
      "categoryPie",
      "categoryTrend",
      "pivotTable",
      "topRecipients",
      "yearlyComparison",
      "yearlySummary",
    ],
    enabled: "categoryPie",
    heading: "Spending by category",
    tab: "Categories",
  },
  {
    path: "/portfolio",
    scope: "portfolio",
    ids: [
      "ticker",
      "investments",
      "allocation",
      "performance",
      "exposure",
      "valueChart",
      "brokerChart",
      "relativeChart",
      "breakdown",
      "news",
      "archived",
    ],
    enabled: "investments",
    heading: "Holdings",
  },
  {
    path: "/portfolio",
    scope: "portfolio",
    ids: [
      "ticker",
      "investments",
      "allocation",
      "performance",
      "exposure",
      "valueChart",
      "brokerChart",
      "relativeChart",
      "breakdown",
      "news",
      "archived",
    ],
    enabled: "performance",
    heading: "Gains, income and costs",
  },
];
for (const widget of loneWidgets) {
  test(`A lone ${widget.scope}/${widget.enabled} widget fills its desktop row`, async () => {
    await setting("widget_visibility", {
      [widget.scope]: Object.fromEntries(
        widget.ids.map((id) => [id, id === widget.enabled]),
      ),
    });
    const { context, page } = await pageAt(widget.path);
    try {
      if (widget.tab)
        await page.getByRole("tab", { name: widget.tab, exact: true }).click();
      const heading = page
        .getByRole("heading", { name: widget.heading, exact: true })
        .first();
      await heading.scrollIntoViewIfNeeded();
      const geometry = await heading.evaluate((node) => {
        let child = node;
        for (
          let parent = child.parentElement;
          parent;
          child = parent, parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          if (
            style.display !== "grid" ||
            style.gridTemplateColumns.split(" ").length < 2
          )
            continue;
          const children = [...parent.children].filter(
            (element) => element.getClientRects().length,
          );
          const box = child.getBoundingClientRect();
          const row = parent.getBoundingClientRect();
          return {
            count: children.length,
            left: box.left - row.left,
            right: row.right - box.right,
            width: box.width,
          };
        }
        return null;
      });
      assert.ok(geometry, "widget has no rendered desktop grid");
      assert.equal(geometry.count, 1, "fixture must leave exactly one widget");
      assert.ok(
        geometry.width > 0 &&
          Math.abs(geometry.left) <= 2 &&
          Math.abs(geometry.right) <= 2,
        "lone widget leaves unused columns",
      );
    } finally {
      await context.close();
    }
  });
}

for (const width of [390, 1280]) {
  for (const assetClass of [
    "Stock",
    "ETF",
    "Cryptocurrency",
    "Metals",
    "Real estate",
    "Savings account",
    "Bond",
  ]) {
    test(`${assetClass} investment branch fields fit ${width}px`, async () => {
      const { context, page } = await pageAt("/portfolio", {
        width,
        height: 900,
      });
      try {
        await page
          .getByRole("button", { name: "Add investment", exact: true })
          .first()
          .click();
        const dialog = page.getByRole("dialog").last();
        await dialog
          .getByRole("button", { name: new RegExp(`^${assetClass}`) })
          .click();
        await dialog.locator("form").waitFor();
        await assertFormFits(dialog, `${assetClass} investment`);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
      } finally {
        await context.close();
      }
    });
  }
}

for (const width of [390, 1280]) {
  test(`Market investment currency fields fit ${width}px through a controlled external provider`, async () => {
    assert.equal(
      process.env.VISION_BROWSER_PROVIDER_FIXTURES,
      "1",
      "market journeys require the runner-owned provider fixture",
    );
    const { context, page } = await pageAt(
      "/research/market?symbol=LAYOUTQUOTE",
      { width, height: 900 },
    );
    try {
      await page
        .getByRole("heading", { name: "LAYOUTQUOTE", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: /^(Add investment|Add transaction)$/ })
        .first()
        .click();
      const dialog = page.getByRole("dialog").last();
      await dialog
        .getByRole("button", { name: /^Create new investment/ })
        .click();
      await dialog.locator("form").waitFor();
      await assertFormFits(dialog, "Market investment");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await context.close();
    }
  });
  test(`Watchlist search and selected asset fields fit ${width}px through the real API`, async () => {
    assert.equal(process.env.VISION_BROWSER_PROVIDER_FIXTURES, "1");
    const { context, page } = await pageAt("/research/watchlist", {
      width,
      height: 900,
    });
    try {
      await page
        .getByRole("button", { name: "Add to watchlist", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog").last();
      await assertFormFits(dialog, "Watchlist search");
      await dialog
        .getByRole("textbox", {
          name: "Search for a stock, ETF, or crypto",
          exact: true,
        })
        .fill("LAYOUTQUOTE");
      await dialog
        .getByRole("button", { name: /Synthetic market layout/ })
        .click();
      await dialog
        .getByRole("textbox", { name: "Target buy price", exact: true })
        .waitFor();
      await assertFormFits(dialog, "Selected watchlist asset");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await context.close();
    }
  });
}
