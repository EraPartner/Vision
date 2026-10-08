/**
 * Settings route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, errEnvelope } from "../helpers/routeApp.js";

// The route imports its repository through services/settingsService.js, which
// re-exports the default from this module — mocking the repository here
// intercepts that same binding.
vi.mock("../../src/repositories/settingsRepository.ts", () => ({
  default: {
    getAll: vi.fn(),
    getRecord: vi.fn(),
    replace: vi.fn(),
    replaceMany: vi.fn(),
    deleteExpected: vi.fn(),
  },
}));

vi.mock("../../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

import { ConflictError } from "../../src/middleware/errorHandler.ts";
import settingsRepository from "../../src/repositories/settingsRepository.ts";

const { default: settingsRouter } =
  await import("../../src/routes/settings.ts");

const api = routeAgent(settingsRouter, { mountPath: "/api/settings" });
const BASE = "/api/settings";

function registeredHandler(path, method) {
  const layer = settingsRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.at(-1).handle;
}

const putSingleSetting = registeredHandler("/:key", "put");
const getSingleSetting = registeredHandler("/:key", "get");
const putSettings = registeredHandler("/", "put");

describe("Settings Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /", () => {
    it("returns all settings", async () => {
      settingsRepository.getAll.mockResolvedValue({
        app_settings: { defaultCurrency: "EUR" },
      });

      const res = await api.get(BASE).expect(200);

      expect(res.body.data).toEqual({
        app_settings: { defaultCurrency: "EUR" },
      });
    });

    it("answers a 500 when fetching all settings fails", async () => {
      settingsRepository.getAll.mockRejectedValue(new Error("boom"));

      const res = await api.get(BASE).expect(500);
      expect(res.body.error.message).toBe("boom");
    });
  });

  describe("GET /:key", () => {
    it("returns the all-null brokerage category default without prior storage", async () => {
      settingsRepository.getRecord.mockResolvedValue(record(null));
      const res = { ok: vi.fn() };

      await getSingleSetting(
        { params: { key: "brokerage_cash_category_ids" } },
        res,
      );

      expect(res.ok).toHaveBeenCalledWith({
        key: "brokerage_cash_category_ids",
        value: { dividend: null, interest: null, fee: null, tax: null },
        expected: { exists: false },
      });
    });

    it("returns stored setting value when present", async () => {
      settingsRepository.getRecord.mockResolvedValue(
        record({ defaultCurrency: "USD" }),
      );

      const res = await api.get(`${BASE}/app_settings`).expect(200);

      expect(res.body.data).toEqual({
        key: "app_settings",
        value: { defaultCurrency: "USD" },
        expected: { exists: true, value: { defaultCurrency: "USD" } },
      });
    });

    it("returns default for known key when missing", async () => {
      settingsRepository.getRecord.mockResolvedValue(record(null));

      const res = await api.get(`${BASE}/onboarding_complete`).expect(200);

      expect(res.body.data).toEqual({
        key: "onboarding_complete",
        value: false,
        expected: { exists: false },
      });
    });

    it("app_settings default mirrors the frontend store (no default-copy drift)", async () => {
      settingsRepository.getRecord.mockResolvedValue(record(null));

      const res = await api.get(`${BASE}/app_settings`).expect(200);

      const { value } = res.body.data;
      // Keys that had drifted from DEFAULT_APP_SETTINGS.
      expect(value).toMatchObject({
        costBasisMethod: "weighted_avg",
        adminMode: false,
        visualEffects: "standard",
        autoAdaptDisplay: true,
        startupSection: "budgeting",
        colorblindGainLoss: false,
      });
    });

    it("dashboard_settings default includes exclusionScope", async () => {
      settingsRepository.getRecord.mockResolvedValue(record(null));

      const res = await api.get(`${BASE}/dashboard_settings`).expect(200);

      expect(res.body.data.value.exclusionScope).toBe("everywhere");
    });

    it("returns false default for includeTransfers when unset", async () => {
      // Missing from SETTING_DEFAULTS this GET 404'd until the first toggle.
      settingsRepository.getRecord.mockResolvedValue(record(null));

      const res = await api.get(`${BASE}/includeTransfers`).expect(200);

      expect(res.body.data).toEqual({
        key: "includeTransfers",
        value: false,
        expected: { exists: false },
      });
    });

    it("returns a 404 NOT_FOUND envelope for unknown missing key", async () => {
      settingsRepository.getRecord.mockResolvedValue(record(null));

      const res = await api.get(`${BASE}/unknown_key`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("answers a 500 when fetching setting fails", async () => {
      settingsRepository.getRecord.mockRejectedValue(new Error("boom"));

      const res = await api.get(`${BASE}/app_settings`).expect(500);
      expect(res.body.error.message).toBe("boom");
    });
  });

  describe("PUT /:key", () => {
    it("accepts the complete brokerage cash category ID mapping", async () => {
      const value = { dividend: 7, interest: null, fee: 8, tax: 9 };
      settingsRepository.replace.mockResolvedValue({
        key: "brokerage_cash_category_ids",
        value,
      });
      const res = { ok: vi.fn() };

      await putSingleSetting(
        {
          params: { key: "brokerage_cash_category_ids" },
          body: singleBody({ value }),
        },
        res,
      );

      expect(settingsRepository.replace).toHaveBeenCalledWith(
        "brokerage_cash_category_ids",
        value,
        { exists: false },
      );
    });

    it.each(["7", 1.5, 0, -1, 2147483648])(
      "rejects invalid brokerage cash category ID %s",
      async (invalidId) => {
        await expect(
          putSingleSetting(
            {
              params: { key: "brokerage_cash_category_ids" },
              body: singleBody({
                value: {
                  dividend: invalidId,
                  interest: null,
                  fee: null,
                  tax: null,
                },
              }),
            },
            { ok: vi.fn() },
          ),
        ).rejects.toThrow();
        expect(settingsRepository.replace).not.toHaveBeenCalled();
      },
    );

    it("passes coerced exclusion ids from the registered route handler to the single writer", async () => {
      const stored = {
        excludedCategoryIds: [7],
        excludedRecipientIds: [8],
      };
      settingsRepository.replace.mockResolvedValue({
        key: "dashboard_settings",
        value: stored,
      });
      const res = { ok: vi.fn() };

      await putSingleSetting(
        {
          params: { key: "dashboard_settings" },
          body: singleBody({
            value: { excludedCategoryIds: ["7"], excludedRecipientIds: ["8"] },
          }),
        },
        res,
      );

      expect(settingsRepository.replace).toHaveBeenCalledWith(
        "dashboard_settings",
        stored,
        { exists: false },
      );
      expect(res.ok).toHaveBeenCalledWith({
        key: "dashboard_settings",
        value: stored,
      });
    });

    it.each([
      ["excludedCategoryIds", ["abc"]],
      ["excludedRecipientIds", ["abc"]],
      ["excludedCategoryIds", "7"],
    ])(
      "rejects malformed %s before the single writer runs",
      async (field, value) => {
        await expect(
          putSingleSetting(
            {
              params: { key: "dashboard_settings" },
              body: singleBody({ value: { [field]: value } }),
            },
            { ok: vi.fn() },
          ),
        ).rejects.toThrow();

        expect(settingsRepository.replace).not.toHaveBeenCalled();
      },
    );

    it("returns a 400 VALIDATION_ERROR envelope when key length exceeds maximum", async () => {
      const res = await api
        .put(`${BASE}/${"k".repeat(101)}`)
        .send(singleBody({ value: true }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope when value is missing from request body", async () => {
      const res = await api
        .put(`${BASE}/dashboard_settings`)
        .send(singleBody({}))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "returns a 400 VALIDATION_ERROR envelope for forbidden key %s",
      async (key) => {
        const res = await api
          .put(`${BASE}/${key}`)
          .send(singleBody({ value: { polluted: true } }))
          .expect(400);
        expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      },
    );

    it("returns a 400 VALIDATION_ERROR (not a 500) for dashboard_settings with value null", async () => {
      // typeof null === 'object' — a missing null check made this a 500.
      const res = await api
        .put(`${BASE}/dashboard_settings`)
        .send(singleBody({ value: null }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope for dashboard_settings with invalid exclusionScope", async () => {
      const res = await api
        .put(`${BASE}/dashboard_settings`)
        .send(singleBody({ value: { exclusionScope: "invalid-scope" } }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope for dashboard_settings when excludedCategoryIds contains invalid value", async () => {
      const res = await api
        .put(`${BASE}/dashboard_settings`)
        .send(singleBody({ value: { excludedCategoryIds: [1, "abc"] } }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("saves setting when payload is valid", async () => {
      settingsRepository.replace.mockResolvedValue({
        key: "theme_settings",
        value: { theme: "dark" },
      });

      const res = await api
        .put(`${BASE}/theme_settings`)
        .send(singleBody({ value: { theme: "dark" } }))
        .expect(200);

      expect(settingsRepository.replace).toHaveBeenCalledWith(
        "theme_settings",
        {
          theme: "dark",
        },
        { exists: false },
      );
      expect(res.body.data).toEqual({
        key: "theme_settings",
        value: { theme: "dark" },
      });
    });

    it("returns a 400 VALIDATION_ERROR envelope for theme_settings with unknown variant", async () => {
      const res = await api
        .put(`${BASE}/theme_settings`)
        .send(singleBody({ value: { variant: "matrix-green" } }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope for theme_settings with unknown mode", async () => {
      const res = await api
        .put(`${BASE}/theme_settings`)
        .send(singleBody({ value: { mode: "sepia" } }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope for theme_settings with malformed schedule time", async () => {
      const res = await api
        .put(`${BASE}/theme_settings`)
        .send(
          singleBody({
            value: { schedule: { lightFrom: "25:00", darkFrom: "20:00" } },
          }),
        )
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("accepts theme_settings with known variant, mode, and schedule", async () => {
      settingsRepository.replace.mockResolvedValue({
        key: "theme_settings",
        value: {
          mode: "schedule",
          schedule: { lightFrom: "07:00", darkFrom: "20:00" },
          variant: "dracula",
        },
      });

      await api
        .put(`${BASE}/theme_settings`)
        .send(
          singleBody({
            value: {
              mode: "schedule",
              schedule: { lightFrom: "07:00", darkFrom: "20:00" },
              variant: "dracula",
            },
          }),
        )
        .expect(200);

      expect(settingsRepository.replace).toHaveBeenCalledWith(
        "theme_settings",
        {
          mode: "schedule",
          schedule: { lightFrom: "07:00", darkFrom: "20:00" },
          variant: "dracula",
        },
        { exists: false },
      );
    });

    it("rejects an unknown setting key with a 400 naming the known keys", async () => {
      const res = await api
        .put(`${BASE}/totally_unknown_key`)
        .send(singleBody({ value: { any: "json" } }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(res.body.error.message).toMatch(
        /Unknown setting key 'totally_unknown_key'.*Known keys:/,
      );
      expect(settingsRepository.replace).not.toHaveBeenCalled();
    });

    it("accepts dismissed_recurring_patterns as an array (RecurringDetectionPanel payload)", async () => {
      settingsRepository.replace.mockResolvedValue({
        key: "dismissed_recurring_patterns",
        value: [3, 7],
      });

      await api
        .put(`${BASE}/dismissed_recurring_patterns`)
        .send(singleBody({ value: [3, 7] }))
        .expect(200);

      expect(settingsRepository.replace).toHaveBeenCalledWith(
        "dismissed_recurring_patterns",
        [3, 7],
        { exists: false },
      );
    });

    it("rejects a non-array dismissed_recurring_patterns", async () => {
      const res = await api
        .put(`${BASE}/dismissed_recurring_patterns`)
        .send(singleBody({ value: "weekly" }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("accepts a portfolio_tax_adjustments_v1 entry map (usePortfolioTaxAdjustments payload)", async () => {
      const value = { "2026:4": { taxes: 12.5, fees: 3 } };
      settingsRepository.replace.mockResolvedValue({
        key: "portfolio_tax_adjustments_v1",
        value,
      });

      await api
        .put(`${BASE}/portfolio_tax_adjustments_v1`)
        .send(singleBody({ value }))
        .expect(200);

      expect(settingsRepository.replace).toHaveBeenCalledWith(
        "portfolio_tax_adjustments_v1",
        value,
        { exists: false },
      );
    });

    it("answers a 500 when single setting save fails", async () => {
      settingsRepository.replace.mockRejectedValue(new Error("boom"));

      const res = await api
        .put(`${BASE}/theme_settings`)
        .send(singleBody({ value: { theme: "dark" } }))
        .expect(500);
      expect(res.body.error.message).toBe("boom");
    });
  });

  describe("PUT /", () => {
    it("does not let bulk writes bypass brokerage category validation", async () => {
      await expect(
        putSettings(
          {
            body: bulkBody({
              brokerage_cash_category_ids: {
                dividend: null,
                interest: null,
                fee: 0,
                tax: null,
              },
            }),
          },
          { ok: vi.fn() },
        ),
      ).rejects.toThrow();
      expect(settingsRepository.replaceMany).not.toHaveBeenCalled();
    });

    it("passes coerced exclusion ids from the registered route handler to the bulk writer", async () => {
      settingsRepository.replaceMany.mockResolvedValue(undefined);
      const res = { ok: vi.fn() };

      await putSettings(
        {
          body: bulkBody({
            dashboard_settings: {
              excludedCategoryIds: ["7"],
              excludedRecipientIds: ["8"],
            },
          }),
        },
        res,
      );

      expect(settingsRepository.replaceMany).toHaveBeenCalledWith(
        {
          dashboard_settings: {
            excludedCategoryIds: [7],
            excludedRecipientIds: [8],
          },
        },
        bulkBody({
          dashboard_settings: {
            excludedCategoryIds: [7],
            excludedRecipientIds: [8],
          },
        }).expected,
      );
      expect(res.ok).toHaveBeenCalledWith({ saved: 1 });
    });

    it("rejects malformed exclusions before the bulk writer runs", async () => {
      await expect(
        putSettings(
          {
            body: bulkBody({
              dashboard_settings: { excludedRecipientIds: ["abc"] },
            }),
          },
          { ok: vi.fn() },
        ),
      ).rejects.toThrow();

      expect(settingsRepository.replaceMany).not.toHaveBeenCalled();
    });

    it("returns a 400 VALIDATION_ERROR envelope when body is an array", async () => {
      const res = await api.put(BASE).send([]).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope when body is not an object", async () => {
      const res = await api
        .put(BASE)
        .set("Content-Type", "application/json")
        .send('"invalid"')
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope when a key exceeds max length", async () => {
      const longKey = "x".repeat(101);
      const res = await api
        .put(BASE)
        .send(bulkBody({ [longKey]: true }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("returns a 400 VALIDATION_ERROR envelope when dashboard_settings payload is not an object", async () => {
      const res = await api
        .put(BASE)
        .send(bulkBody({ dashboard_settings: "invalid" }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("bulk saves settings when payload is valid", async () => {
      settingsRepository.replaceMany.mockResolvedValue(undefined);

      const res = await api
        .put(BASE)
        .send(
          bulkBody({
            onboarding_complete: true,
            dashboard_settings: { excludedCategoryIds: [1, 2] },
          }),
        )
        .expect(200);

      expect(settingsRepository.replaceMany).toHaveBeenCalledWith(
        {
          onboarding_complete: true,
          dashboard_settings: { excludedCategoryIds: [1, 2] },
        },
        bulkBody({
          onboarding_complete: true,
          dashboard_settings: { excludedCategoryIds: [1, 2] },
        }).expected,
      );
      expect(res.body.data).toEqual({ saved: 2 });
    });

    it("answers a 500 when bulk save fails", async () => {
      settingsRepository.replaceMany.mockRejectedValue(new Error("boom"));

      const res = await api
        .put(BASE)
        .send(bulkBody({ onboarding_complete: true }))
        .expect(500);
      expect(res.body.error.message).toBe("boom");
    });

    it("rejects an unknown key via bulk (no unknown-key bypass)", async () => {
      const res = await api
        .put(BASE)
        .send(
          bulkBody({ onboarding_complete: true, mystery_key: { any: "json" } }),
        )
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(settingsRepository.replaceMany).not.toHaveBeenCalled();
    });

    it("rejects an invalid cost_basis_method via bulk (no validation bypass)", async () => {
      const res = await api
        .put(BASE)
        .send(bulkBody({ cost_basis_method: "bogus" }))
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(settingsRepository.replaceMany).not.toHaveBeenCalled();
    });

    it("accepts a valid cost_basis_method via bulk", async () => {
      settingsRepository.replaceMany.mockResolvedValue(undefined);
      await api
        .put(BASE)
        .send(bulkBody({ cost_basis_method: "fifo" }))
        .expect(200);
      expect(settingsRepository.replaceMany).toHaveBeenCalledWith(
        {
          cost_basis_method: "fifo",
        },
        bulkBody({
          cost_basis_method: "fifo",
        }).expected,
      );
    });
  });

  describe("DELETE /:key", () => {
    it("returns a 409 CONFLICT envelope when a previously read setting disappeared", async () => {
      settingsRepository.deleteExpected.mockRejectedValue(
        new ConflictError("Settings changed"),
      );

      const res = await api
        .delete(`${BASE}/missing_key`)
        .send({ expected: { exists: true, value: {} } })
        .expect(409);
      expect(res.body).toEqual(errEnvelope({ code: "CONFLICT" }));
    });

    it("returns 204 with no body when setting exists", async () => {
      settingsRepository.deleteExpected.mockResolvedValue(true);

      const res = await api
        .delete(`${BASE}/theme_settings`)
        .send({ expected: { exists: true, value: {} } })
        .expect(204);
      expect(res.text).toBe("");
    });

    it("answers a 500 when deleting setting fails", async () => {
      settingsRepository.deleteExpected.mockRejectedValue(new Error("boom"));

      const res = await api
        .delete(`${BASE}/theme_settings`)
        .send({ expected: { exists: true, value: {} } })
        .expect(500);
      expect(res.body.error.message).toBe("boom");
    });
  });
});

function singleBody(body) {
  return { ...body, expected: { exists: false } };
}
function bulkBody(settings) {
  return {
    settings,
    expected: Object.fromEntries(
      Object.keys(settings).map((key) => [key, { exists: false }]),
    ),
  };
}

function record(value) {
  return value === null
    ? { expected: { exists: false } }
    : { value, expected: { exists: true, value } };
}
