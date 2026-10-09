/**
 * Settings route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.ts";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

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

import type { IRoute } from "express";
import { ConflictError } from "../../src/middleware/errorHandler.ts";
import rawSettingsRepository from "../../src/repositories/settingsRepository.ts";

const settingsRepository = vi.mocked(rawSettingsRepository);

/** Express's Route keeps its verb map at runtime; @types/express omits it. */
type RouteWithMethods = IRoute & { methods: Record<string, boolean> };

const { default: settingsRouter } =
  await import("../../src/routes/settings.ts");

const api = routeAgent(settingsRouter, { mountPath: "/api/settings" });
const BASE = "/api/settings";

type ReplaceResult = Awaited<
  ReturnType<typeof rawSettingsRepository.replace<unknown>>
>;
/** `replace` result without the echoed `expected`, which the route ignores. */
const replaced = (fields: Omit<ReplaceResult, "expected">) =>
  fields as ReplaceResult;

/** A route's final handler, called directly with partial req/res stand-ins. */
type DirectHandler = (req: object, res: object) => Promise<unknown>;

function registeredHandler(path: string, method: string): DirectHandler {
  const layer = settingsRouter.stack.find(
    (entry) =>
      entry.route?.path === path &&
      (entry.route as RouteWithMethods).methods[method],
  );
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${path} route`);
  return layer.route!.stack.at(-1)!.handle as unknown as DirectHandler;
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
      settingsRepository.replace.mockResolvedValue(
        replaced({
          key: "brokerage_cash_category_ids",
          value,
        }),
      );
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
      settingsRepository.replace.mockResolvedValue(
        replaced({
          key: "dashboard_settings",
          value: stored,
        }),
      );
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
      settingsRepository.replace.mockResolvedValue(
        replaced({
          key: "theme_settings",
          value: { theme: "dark" },
        }),
      );

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
      settingsRepository.replace.mockResolvedValue(
        replaced({
          key: "theme_settings",
          value: {
            mode: "schedule",
            schedule: { lightFrom: "07:00", darkFrom: "20:00" },
            variant: "dracula",
          },
        }),
      );

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
      settingsRepository.replace.mockResolvedValue(
        replaced({
          key: "dismissed_recurring_patterns",
          value: [3, 7],
        }),
      );

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
      settingsRepository.replace.mockResolvedValue(
        replaced({
          key: "portfolio_tax_adjustments_v1",
          value,
        }),
      );

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
  describe("request validation (ADR-193)", () => {
    const validationError = (message: string) =>
      errEnvelope({ code: "VALIDATION_ERROR", message });

    it("serves the plain map for withBaselines=false", async () => {
      settingsRepository.getAll.mockResolvedValue({});
      await api.get(`${BASE}?withBaselines=false`).expect(200);
      expect(settingsRepository.getAll).toHaveBeenCalled();
    });

    it.each(["yes", "TRUE"])(
      "rejects withBaselines=%s instead of silently dropping the baselines",
      async (value) => {
        const res = await api
          .get(BASE)
          .query({ withBaselines: value })
          .expect(400);
        expect(res.body).toEqual(
          validationError("withBaselines must be true or false"),
        );
        expect(settingsRepository.getAll).not.toHaveBeenCalled();
      },
    );

    it("names the missing value on a single-key write", async () => {
      const res = await api
        .put(`${BASE}/includeTransfers`)
        .send(singleBody({}))
        .expect(400);
      expect(res.body).toEqual(
        validationError('Missing "value" in request body'),
      );
    });

    it("keeps the per-key prefix on a rejected value", async () => {
      const res = await api
        .put(`${BASE}/cost_basis_method`)
        .send(singleBody({ value: "average" }))
        .expect(400);
      expect(res.body.error.message).toMatch(/^Invalid cost_basis_method: /);
    });

    it("rejects a single-key write without its baseline", async () => {
      const res = await api
        .put(`${BASE}/includeTransfers`)
        .send({ value: true })
        .expect(400);
      expect(res.body).toEqual(
        validationError("Missing or invalid expected setting baseline"),
      );
      expect(settingsRepository.replace).not.toHaveBeenCalled();
    });

    it("rejects a bulk write whose baseline map lacks a key", async () => {
      const res = await api
        .put(BASE)
        .send({
          settings: { includeTransfers: true, onboarding_complete: true },
          expected: { includeTransfers: { exists: false } },
        })
        .expect(400);
      expect(res.body).toEqual(
        validationError("Missing or invalid expected setting baseline"),
      );
      expect(settingsRepository.replaceMany).not.toHaveBeenCalled();
    });

    it("rejects a bulk write without a baseline map", async () => {
      const res = await api
        .put(BASE)
        .send({ settings: { includeTransfers: true } })
        .expect(400);
      expect(res.body).toEqual(
        validationError("Missing expected settings baselines"),
      );
    });

    // zod's object/record parsing drops a `__proto__` key, so the bulk key
    // checks must see the raw map or this write would be silently ignored.
    it("rejects a bulk __proto__ key rather than dropping it", async () => {
      const res = await api
        .put(BASE)
        .set("Content-Type", "application/json")
        .send(
          '{"settings":{"__proto__":{"x":1}},"expected":{"__proto__":{"exists":false}}}',
        )
        .expect(400);
      expect(res.body).toEqual(
        validationError("Setting key '__proto__' is not allowed"),
      );
      expect(settingsRepository.replaceMany).not.toHaveBeenCalled();
    });

    it("rejects a delete without its baseline", async () => {
      const res = await api.delete(`${BASE}/theme_settings`).expect(400);
      expect(res.body).toEqual(
        validationError("Missing or invalid expected setting baseline"),
      );
      expect(settingsRepository.deleteExpected).not.toHaveBeenCalled();
    });

    it("rejects an over-long key on delete", async () => {
      const res = await api
        .delete(`${BASE}/${"k".repeat(101)}`)
        .send({ expected: { exists: true, value: {} } })
        .expect(400);
      expect(res.body).toEqual(
        validationError("Setting key too long (max 100 chars)"),
      );
    });
  });
});

function singleBody(body: Record<string, unknown>) {
  return { ...body, expected: { exists: false } };
}
function bulkBody(settings: Record<string, unknown>) {
  return {
    settings,
    expected: Object.fromEntries(
      Object.keys(settings).map((key) => [key, { exists: false }]),
    ),
  };
}

function record(
  value: unknown,
): Awaited<ReturnType<typeof rawSettingsRepository.getRecord>> {
  return value === null
    ? { expected: { exists: false } }
    : { value, expected: { exists: true, value } };
}
