/**
 * Settings routes.
 *
 * GET  /api/settings          — get all settings
 * GET  /api/settings/:key     — get a single setting
 * PUT  /api/settings/:key     — upsert a single setting
 * PUT  /api/settings          — bulk upsert settings
 * DELETE /api/settings/:key   — delete a setting
 */

import { Router } from "express";
import { z } from "zod";
import settingsService from "../services/settingsService.js";
import { validateIntArray } from "../middleware/validation.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

/* ── Zod schemas ─────────────────────────────────────────────────────────────
 * All object schemas are LOOSE: settings blobs carry frontend-owned fields the
 * backend doesn't model, and unknown keys must be stored, not stripped. */

// ── belgian_tax_profile validation ───────────────────────────────────────────
// The PIT engine multiplies these fields unclamped (frontend pit.ts): a
// negative communal surcharge flipped into a tax credit, a fat-fingered 70
// ("7.0") multiplied it 10×, and negative money fields produced negative
// social security — the load side blind-casts, so whatever is stored flows
// straight into the math. Field lists mirror BelgianTaxProfile in
// apps/frontend/src/lib/belgianTax/types.ts; the profile steps always send
// numbers (parseDecimal), so strict number checks reject only garbage.
const TAX_PROFILE_MONEY_FIELDS = [
  "grossAnnualIncome",
  "actualProfessionalExpenses",
  "cadastralIncome",
  "otherTaxableIncome",
  "alimonyPaid",
  "personalPensionContributions",
  "lifeInsurancePremiums",
  "mortgageInterestPaid",
  "mortgageCapitalRepaid",
  "charitableDonations",
  "childcareCosts",
  "employeeGroupInsuranceContributions",
  "unionDues",
  "medicalExpenses",
  "domesticHelpCosts",
  "spouseProfessionalIncome",
  "annualDividendIncome",
  "annualSavingsInterest",
];
const TAX_PROFILE_COUNT_FIELDS = [
  "dependentChildren",
  "dependentChildrenUnder3",
  "dependentChildrenDisabled",
  "dependentOtherPersons",
  "dependentOtherPersonsDisabled",
  "childcareEligibleDays",
  "serviceVoucherCount",
];
const TAX_PROFILE_MONEY_MAX = 1e12;
const TAX_PROFILE_CENTIMES_MAX = 100000;

// The profile steps always send numbers (parseDecimal) or omit/null the field,
// so `.nullish()` + strict z.number() rejects only garbage (NaN/Infinity/strings
// included — zod 4's z.number() is finite-only).
const money = z.number().min(0).max(TAX_PROFILE_MONEY_MAX).nullish();
const count = z.number().int().min(0).max(1000).nullish();
const yearNum = z.number().int().min(1900).max(2200).nullish();
const centimes = z.number().min(0).max(TAX_PROFILE_CENTIMES_MAX).nullish();

const belgianTaxProfileSchema = z.looseObject({
  // % on federal PIT — Belgian municipalities levy 0-9% (matches the UI hint).
  communalSurchargePercent: z.number().min(0).max(9).nullish(),
  ...Object.fromEntries(
    TAX_PROFILE_MONEY_FIELDS.map((field) => [field, money]),
  ),
  ...Object.fromEntries(
    TAX_PROFILE_COUNT_FIELDS.map((field) => [field, count]),
  ),
  taxYear: yearNum,
  mortgageStartYear: yearNum,
  cadastralCentimesOverride: centimes,
  additionalResidences: z
    .array(
      z.looseObject({
        cadastralIncome: money,
        centimesOverride: centimes,
      }),
    )
    .nullish(),
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM_RE, "must be HH:MM");

const themeSettingsSchema = z.looseObject({
  variant: z
    .enum(["default", "dracula", "solarized", "nord", "high-contrast"])
    .optional(),
  mode: z.enum(["light", "dark", "system", "schedule"]).optional(),
  schedule: z
    .looseObject({
      lightFrom: hhmm.optional(),
      darkFrom: hhmm.optional(),
    })
    .optional(),
});

// Shares validateIntArray with savedCharts.js's chart filter lists for element
// validation, but settings keep their documented array shape instead of
// accepting the helper's scalar-to-array convenience. The coerced ints replace
// the raw input in the stored value.
/** @param {string} field */
const intArrayField = (field) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (!Array.isArray(value)) {
        ctx.addIssue({ code: "custom", message: `${field} must be an array` });
        return z.NEVER;
      }
      const result = validateIntArray(value, field);
      if (!result.valid) {
        ctx.addIssue({ code: "custom", message: result.error });
        return z.NEVER;
      }
      return result.value;
    })
    .optional();

const dashboardSettingsSchema = z.looseObject({
  excludedCategoryIds: intArrayField("excludedCategoryIds"),
  excludedRecipientIds: intArrayField("excludedRecipientIds"),
  excludeHiddenCategories: z.boolean().optional(),
  exclusionScope: z.enum(["everywhere", "dashboard", "statistics"]).optional(),
});

// Saved cash-aware rebalancing plans (ADR-098): a list of user-defined target
// allocations the rebalance page deploys spendable cash toward. Stored here (not
// a dedicated table) since they are small, per-install config — same key-value
// store as the other settings.
const MAX_REBALANCE_PLANS = 50;

const rebalancePlanSchema = z.looseObject({
  id: z.string().min(1).max(100),
  name: z
    .string()
    .max(80)
    .refine((s) => s.trim().length > 0, "name must not be blank"),
  // Weights and cashCap are validated through Number() coercion but stored as
  // sent (numeric strings are accepted, not rewritten) — pre-zod behavior.
  // Deliberately not shared with portfolio/rebalanceTargets.js's request schema,
  // which COERCES weights for computation and handles {} differently.
  targetWeights: z
    .record(z.string(), z.unknown())
    .superRefine((weights, ctx) => {
      const entries = Object.entries(weights);
      if (entries.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "targetWeights must have at least one sleeve",
        });
        return;
      }
      let weightSum = 0;
      for (const [sleeve, weight] of entries) {
        const n = Number(weight);
        if (!Number.isFinite(n) || n < 0) {
          ctx.addIssue({
            code: "custom",
            path: [sleeve],
            message: "must be a non-negative number",
          });
          return;
        }
        weightSum += n;
      }
      // An all-zero plan would silently deploy nothing when applied. Reject it at
      // save time so the user gets immediate feedback rather than a dead plan.
      if (!(weightSum > 0)) {
        ctx.addIssue({
          code: "custom",
          message: "targetWeights must include at least one positive weight",
        });
      }
    }),
  cashCap: z
    .unknown()
    .refine((cap) => {
      const n = Number(cap);
      return Number.isFinite(n) && n >= 0;
    }, "cashCap must be a non-negative number")
    .optional(),
});

const rebalancePlansSchema = z
  .array(rebalancePlanSchema)
  .max(MAX_REBALANCE_PLANS);
const nullableCategoryIdSchema = z
  .number()
  .int()
  .min(1)
  .max(2147483647)
  .nullable();
const brokerageCashCategoryIdsSchema = z.strictObject({
  dividend: nullableCategoryIdSchema,
  interest: nullableCategoryIdSchema,
  fee: nullableCategoryIdSchema,
  tax: nullableCategoryIdSchema,
});

// Any plain JSON object (null/array/scalar rejected, all keys passed through).
const jsonObjectSchema = z.looseObject({});

const SETTING_SCHEMAS = {
  dashboard_settings: dashboardSettingsSchema,
  theme_settings: themeSettingsSchema,
  cost_basis_method: z.enum(["weighted_avg", "fifo", "lifo"]),
  includeTransfers: z.boolean(),
  brokerage_cash_category_ids: brokerageCashCategoryIdsSchema,
  // Structural guards for the remaining first-party blob keys that previously
  // accepted arbitrary JSON. Conservative: only reject values whose top-level
  // type is plainly wrong (a scalar where the frontend always stores an object,
  // or a non-boolean flag), so a malformed `defaultPageSize:"abc"` blob can no
  // longer masquerade as a valid settings object.
  onboarding_complete: z.boolean(),
  app_settings: jsonObjectSchema,
  backup_settings: jsonObjectSchema,
  services_settings: jsonObjectSchema,
  widget_visibility: jsonObjectSchema,
  rebalance_plans: rebalancePlansSchema,
  belgian_tax_profile: belgianTaxProfileSchema,
  // Year-keyed maps: snapshots get the full profile validation per entry.
  belgian_tax_profile_snapshots_v1: z.record(
    z.string(),
    belgianTaxProfileSchema,
  ),
  belgian_tax_profile_snapshot_meta_v1: z.record(z.string(), jsonObjectSchema),
  // Remaining first-party keys, same conservative top-level-shape guards.
  // RecurringDetectionPanel stores an array of dismissed recipient ids (top-
  // level shape only — entries stay unvalidated, matching the blob guards).
  dismissed_recurring_patterns: z.array(z.unknown()),
  // usePortfolioTaxAdjustments / usePortfolioTaxClassifications store
  // "<year>:<investmentId>" / "<investmentId>"-keyed entry maps.
  portfolio_tax_adjustments_v1: z.record(z.string(), jsonObjectSchema),
  portfolio_tax_classifications_v1: z.record(z.string(), jsonObjectSchema),
  // Internal one-shot FX-repair flag (written repository-side; guarded here so
  // an API write can't corrupt its type).
  fx_full_history_repair_done: z.boolean(),
};

const FORBIDDEN_SETTING_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * @param {string} key
 * @param {boolean} [includeKeyInMessage]
 */
function assertSettingKeyLength(key, includeKeyInMessage = false) {
  if (FORBIDDEN_SETTING_KEYS.has(key)) {
    throw new ValidationError(`Setting key '${key}' is not allowed`);
  }
  if (key.length > 100) {
    const msg = includeKeyInMessage
      ? `Setting key '${key}' too long (max 100 chars)`
      : "Setting key too long (max 100 chars)";
    throw new ValidationError(msg);
  }
}

router.get(
  "/",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const settings = await settingsService.getAll();
    res.ok(settings);
  },
);

// Heterogeneous per-key default shapes (booleans, arrays, nested config
// objects) read only via `SETTING_DEFAULTS[key]` (a runtime string) below —
// a closed union would buy nothing a lookup table doesn't already need.
/** @type {Record<string, any>} */
const SETTING_DEFAULTS = {
  onboarding_complete: false,
  dismissed_recurring_patterns: [],
  // Mirror DEFAULT_APP_SETTINGS in apps/frontend/src/stores/settingsStore.ts so
  // a fresh GET returns the same defaults the frontend store applies.
  app_settings: {
    defaultCurrency: "EUR",
    dateFormat: "DD/MM/YYYY",
    numberFormat: "eu",
    defaultPageSize: 50,
    startOfWeek: "monday",
    showDecimalPlaces: 2,
    language: "en",
    autoClearPlannedOnMatch: true,
    costBasisMethod: "weighted_avg",
    adminMode: false,
    visualEffects: "standard",
    autoAdaptDisplay: true,
    startupSection: "budgeting",
    colorblindGainLoss: false,
  },
  // Mirror DEFAULT_DASHBOARD_SETTINGS in the same frontend store.
  dashboard_settings: {
    excludedCategoryIds: [],
    excludedRecipientIds: [],
    excludeHiddenCategories: true,
    exclusionScope: "everywhere",
  },
  theme_settings: {
    mode: "system",
    schedule: { lightFrom: "07:00", darkFrom: "20:00" },
    variant: "default",
  },
  backup_settings: {
    backupDir: "",
    backupOnQuit: false,
  },
  // Opt-in "keep services running on quit" toggle (packaging/electron/main.js
  // will-quit handler) — leaving containers up puts the next launch on the
  // hot-boot path instead of a warm restart.
  services_settings: {
    keepServicesOnQuit: false,
  },
  widget_visibility: {},
  cost_basis_method: "weighted_avg",
  rebalance_plans: [],
  // Matches getIncludeTransfers' `=== true` read default — without this entry
  // the GET 404'd until the first toggle and react-query retried on every visit.
  includeTransfers: false,
  brokerage_cash_category_ids: {
    dividend: null,
    interest: null,
    fee: null,
    tax: null,
  },
};

/* ── Unknown-key policy ──────────────────────────────────────────────────────
 * Every settings writer in the repo uses a fixed key (grep: frontend
 * `saveSetting(` call sites, packaging/electron/main.js backup_settings, and
 * the repository-side fx flag) — there is NO dynamic-key writer. So writes to
 * a key outside the known set are typos/garbage and are rejected with a 400
 * naming the known keys, instead of storing arbitrary JSON forever. Reads and
 * DELETE stay unrestricted so legacy keys from restored backups can still be
 * listed and cleaned up. */
const KNOWN_SETTING_KEYS = new Set([
  ...Object.keys(SETTING_SCHEMAS),
  ...Object.keys(SETTING_DEFAULTS),
]);

/** @param {string} key */
function assertKnownSettingKey(key) {
  if (!KNOWN_SETTING_KEYS.has(key)) {
    throw new ValidationError(
      `Unknown setting key '${key}'. Known keys: ${[...KNOWN_SETTING_KEYS].sort().join(", ")}`,
    );
  }
}

router.get(
  "/:key",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { key } = req.params;
    const value = await settingsService.get(key);
    if (value === null) {
      if (key in SETTING_DEFAULTS) {
        res.ok({ key, value: SETTING_DEFAULTS[key] });
        return;
      }
      throw new NotFoundError(`Setting '${key}' not found`);
    }
    res.ok({ key, value });
  },
);

// Per-key value validation shared by the single-key and bulk handlers so the
// bulk endpoint can't bypass the rules the single-key endpoint enforces.
// Returns the value to store (zod parse output for schema'd keys — identical to
// the input except dashboard int-array coercion — the input as-is otherwise).
/**
 * @param {string} key
 * @param {any} value
 * @returns {any}
 */
function validateSettingValue(key, value) {
  const schema = Object.hasOwn(SETTING_SCHEMAS, key)
    ? SETTING_SCHEMAS[/** @type {keyof typeof SETTING_SCHEMAS} */ (key)]
    : undefined;
  if (!schema) return value;
  const result = schema.safeParse(value);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new ValidationError(`Invalid ${key}: ${msg}`);
  }
  return result.data;
}

router.put(
  "/:key",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { key } = req.params;
    const { value } = req.body;

    assertSettingKeyLength(key);
    assertKnownSettingKey(key);
    if (value === undefined)
      throw new ValidationError('Missing "value" in request body');

    const result = await settingsService.set(
      key,
      validateSettingValue(key, value),
    );
    res.ok(result);
  },
);

router.put(
  "/",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const settings = req.body;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new ValidationError(
        "Body must be a JSON object of key→value pairs",
      );
    }

    for (const key of Object.keys(settings)) {
      assertSettingKeyLength(key, true);
      assertKnownSettingKey(key);
    }

    const validatedEntries = new Map();
    for (const [key, value] of Object.entries(settings)) {
      validatedEntries.set(key, validateSettingValue(key, value));
    }
    const validated = Object.fromEntries(validatedEntries);

    await settingsService.setMany(validated);
    res.ok({ saved: Object.keys(validated).length });
  },
);

router.delete(
  "/:key",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { key } = req.params;
    const deleted = await settingsService.delete(key);
    if (!deleted) throw new NotFoundError(`Setting '${key}' not found`);
    // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
    res.status(204).send();
  },
);

export default router;
