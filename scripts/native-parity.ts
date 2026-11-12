#!/usr/bin/env bun
/**
 * Records the parity corpus of the Swift backend (ADR-270 decision 5): for each
 * area, a fixed sequence of requests sent to the TypeScript backend's real
 * routers on a freshly migrated database with a small seed, and the status and
 * JSON body each one answered.
 *
 *   bun run native:parity            # rewrite apps/native/parity/*.json
 *   bun run native:parity -- tags    # one area
 *
 * The Swift tests (VisionBackendTests/ParityTests.swift) build the same
 * database from db/migrations and the seed, replay the steps in order through
 * RoutingAPITransport and compare the JSON semantically. `meta.requestId` is
 * left out, and timestamps the run created (any not written in the seed) are
 * compared by form only.
 *
 * Requests stay within what the generated client can send: a JSON object body
 * (or none), never a JSON scalar, whose body-parser message is the JavaScript
 * engine's own.
 *
 * The routers run behind the middleware main.ts mounts on the data plane
 * (request id, JSON body parser, CSRF guard, envelope, 404 and the error
 * handler in production mode); rate limiters and security headers are left
 * out, as tests/helpers/routeApp.ts explains.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import { REPO_ROOT, repoPath } from "./lib/nativeCodegen.ts";
import {
  Random,
  mutatedSteps,
  randomEcbXml,
  randomErApi,
  randomQuery,
  randomText,
  randomValue,
} from "./lib/nativeParityMutations.ts";

export const PARITY_DIR = repoPath("apps/native/parity");

interface ParityStep {
  /** The generated client's operationId the request belongs to. */
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path and query, as the client sends them. */
  path: string;
  /** JSON body; absent for none. */
  body?: unknown;
  /** Provider answers from this step on, replacing the area's `fetch`. */
  fetch?: Record<string, { status: number; body: string }>;
}

interface ParityArea {
  /** The router module (relative to apps/node-backend/src/routes) and its mount path. */
  router: { module: string; mountPath: string };
  /** SQL run after the migrations, before the first step. */
  seed: string[];
  steps: ParityStep[];
  /**
   * Answers to the backend's outbound `fetch` by URL (providers such as ECB); any other URL
   * fails like an unreachable host. The Swift replay serves the same answers.
   */
  fetch?: Record<string, { status: number; body: string }>;
}

/** Recorded in place of today's date (APP_TIMEZONE Europe/Brussels): the replay substitutes its own. */
export const TODAY_TOKEN = "{{today}}";

const SEED_TIME = "2025-03-01T09:00:00.000000Z";

/** A complete, valid Belgian tax household (ADR-200) for the settings corpus. */
function household(
  taxYear: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const reductions = {
    personalPensionContributions: 0,
    lifeInsurancePremiums: 0,
    charitableDonations: 0,
    childcareCosts: 0,
    medicalExpenses: 0,
  };
  return {
    version: 2,
    taxYear,
    profileConfigured: true,
    region: "flanders",
    communalSurchargePercent: 7,
    partners: [
      {
        id: "A",
        isDisabled: false,
        activities: [
          {
            id: "act_main",
            kind: "employee",
            grossIncome: 52000,
            startDate: "2024-02-29",
          },
        ],
        professionalExpenses: {
          remuneration: { method: "lump_sum", actualAmount: 0 },
        },
        unionDues: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        reductions,
      },
    ],
    relationship: { events: [] },
    dependents: { children: 0, otherPersons: 0 },
    home: { cadastralIncome: 0, mortgageInterestPaid: 0 },
    ...overrides,
  };
}

/** A partner of `household` with the given id and activities. */
function partner(
  id: string,
  activities: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = (household(2024).partners as Record<string, unknown>[])[0] ?? {};
  return { ...base, id, activities, ...extra };
}

const NEW = { exists: false };
/** A single-key save of `value` against an absent baseline (validation runs first). */
const save = (
  key: string,
  value: unknown,
  expected: unknown = NEW,
): ParityStep => ({
  operationId: "saveSetting",
  method: "PUT",
  path: `/api/settings/${key}`,
  body: { value, expected },
});
const bulk = (body: unknown): ParityStep => ({
  operationId: "saveSettings",
  method: "PUT",
  path: "/api/settings",
  body,
});
const read = (key: string): ParityStep => ({
  operationId: "getSetting",
  method: "GET",
  path: `/api/settings/${key}`,
});
const list = (query = ""): ParityStep => ({
  operationId: "getSettings",
  method: "GET",
  path: `/api/settings${query}`,
});
const LONG_KEY = "k".repeat(101);
const jsonText = (text: string): unknown => JSON.parse(text);

const ECB_DAILY =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ER_API_LATEST = "https://open.er-api.com/v6/latest/EUR";
const RATE_ROW = (
  code: string,
  rate: string,
  date: string,
  latest: number,
  fetched = SEED_TIME,
) =>
  `('${code}', vision_numeric('${rate}', 20, 10), '${date}', ${latest}, '${fetched}', '${SEED_TIME}')`;
const ratesList = (query = ""): ParityStep => ({
  operationId: "getExchangeRates",
  method: "GET",
  path: `/api/info/exchange-rates${query}`,
});
const accounts = (query = ""): ParityStep => ({
  operationId: "getAccounts",
  method: "GET",
  path: `/api/accounts${query}`,
});
const accountCreate = (body: unknown): ParityStep => ({
  operationId: "createAccount",
  method: "POST",
  path: "/api/accounts",
  body,
});
const accountUpdate = (id: string, body: unknown): ParityStep => ({
  operationId: "updateAccount",
  method: "PATCH",
  path: `/api/accounts/${id}`,
  body,
});
const statementPut = (
  id: string,
  currency: string,
  body?: unknown,
): ParityStep => ({
  operationId: "setAccountStatementBalance",
  method: "PUT",
  path: `/api/accounts/${id}/statement-balances/${currency}`,
  ...(body === undefined ? {} : { body }),
});
const accountDelete = (id: string): ParityStep => ({
  operationId: "deleteAccount",
  method: "DELETE",
  path: `/api/accounts/${id}`,
});
const ratesRefresh: ParityStep = {
  operationId: "refreshExchangeRates",
  method: "POST",
  path: "/api/info/exchange-rates/refresh",
};

export const AREAS: Record<string, ParityArea> = {
  tags: {
    router: { module: "tags.ts", mountPath: "/api/tags" },
    seed: [
      `INSERT INTO tags (slug, color, is_active, created_at, updated_at) VALUES
        ('holiday', '#00aaff', 1, '${SEED_TIME}', '${SEED_TIME}'),
        ('rome-2020', NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        ('archived', '#999999', 0, '${SEED_TIME}', '${SEED_TIME}'),
        ('business', NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      { operationId: "getTags", method: "GET", path: "/api/tags" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=all" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=false" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=0" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=bogus" },
      {
        operationId: "getTags",
        method: "GET",
        path: "/api/tags?active=all&limit=2&offset=1",
      },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=2" },
      { operationId: "getTags", method: "GET", path: "/api/tags?offset=1" },
      {
        operationId: "getTags",
        method: "GET",
        path: "/api/tags?limit=abc&offset=-3",
      },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=5000" },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=" },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "  Groceries   Weekly!! ", color: "#ff0000" },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "groceries-weekly", color: "#00ff00" },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "Archived" },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "rome 2020", color: "#123456" },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "Café İstanbul", color: null },
      },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: {} },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "" },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "!!!" },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: 5 },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "x", color: 5 },
      },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: true, color: [] },
      },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: [] },
      { operationId: "createTag", method: "POST", path: "/api/tags" },
      {
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body: { slug: "extra", unknown: 1 },
      },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=all" },
    ],
  },
  settings: {
    router: { module: "settings.ts", mountPath: "/api/settings" },
    seed: [
      `INSERT INTO user_settings (key, value, updated_at) VALUES
        ('app_settings', vision_jsonb('{"defaultCurrency":"USD","defaultPageSize":25,"adminMode":true}'), '${SEED_TIME}'),
        ('theme_settings', vision_jsonb('{"mode":"light"}'), '${SEED_TIME}'),
        ('cost_basis_method', vision_jsonb('"fifo"'), '${SEED_TIME}'),
        ('onboarding_complete', vision_jsonb('"true"'), '${SEED_TIME}'),
        ('legacy_blob', vision_jsonb('"{\\"a\\":[1,2.5,null]}"'), '${SEED_TIME}'),
        ('legacy_text', vision_jsonb('"not json {"'), '${SEED_TIME}'),
        ('widget_visibility', vision_jsonb('{"a":true,"b":false}'), '${SEED_TIME}'),
        ('10', vision_jsonb('1.50'), '${SEED_TIME}'),
        ('9', vision_jsonb('[{"z":1,"a":{"y":null}}]'), '${SEED_TIME}')`,
    ],
    steps: [
      list(),
      list("?withBaselines=true"),
      list("?withBaselines=false"),
      list("?withBaselines=yes"),
      list("?withBaselines=TRUE"),
      list("?withBaselines="),
      list("?withBaselines=true&withBaselines=false"),
      read("app_settings"),
      read("onboarding_complete"),
      read("cost_basis_method"),
      read("legacy_blob"),
      read("legacy_text"),
      read("10"),
      read("includeTransfers"),
      read("dashboard_settings"),
      read("brokerage_cash_category_ids"),
      read("nope"),
      read("constructor"),
      read("a%20b"),
      // Conditional single-key saves.
      save("includeTransfers", true),
      save("includeTransfers", true),
      save("includeTransfers", false, { exists: true, value: true }),
      save("includeTransfers", true, { exists: true, value: true }),
      save(
        "app_settings",
        { defaultCurrency: "EUR", nested: { b: 1, a: [2, { c: 3 }] } },
        {
          exists: true,
          value: {
            adminMode: true,
            defaultPageSize: 25.0,
            defaultCurrency: "USD",
          },
        },
      ),
      read("app_settings"),
      save("onboarding_complete", true, { exists: true, value: "true" }),
      read("onboarding_complete"),
      save("cost_basis_method", "lifo", { exists: true, value: "fifo" }),
      save(
        "widget_visibility",
        jsonText('{"__proto__":{"x":1},"c":true,"2":false}'),
        {
          exists: true,
          value: { b: false, a: true },
        },
      ),
      read("widget_visibility"),
      save(
        "portfolio_tax_adjustments_v1",
        jsonText('{"__proto__":{},"2024:1":{"amount":5},"7":{}}'),
      ),
      read("portfolio_tax_adjustments_v1"),
      // Key and body guards.
      save("bogus_key", 1),
      save("constructor", 1),
      save("prototype", 1),
      save(LONG_KEY, 1),
      {
        operationId: "saveSetting",
        method: "PUT",
        path: "/api/settings/includeTransfers",
        body: { expected: NEW },
      },
      {
        operationId: "saveSetting",
        method: "PUT",
        path: "/api/settings/includeTransfers",
        body: {},
      },
      {
        operationId: "saveSetting",
        method: "PUT",
        path: "/api/settings/includeTransfers",
        body: [],
      },
      {
        operationId: "saveSetting",
        method: "PUT",
        path: "/api/settings/includeTransfers",
      },
      {
        operationId: "saveSetting",
        method: "PUT",
        path: "/api/settings/bogus",
        body: {},
      },
      save("includeTransfers", true, { exists: true }),
      save("includeTransfers", true, { exists: false, value: true }),
      save("includeTransfers", true, { exists: "yes" }),
      save("includeTransfers", true, { exists: false, extra: 1 }),
      save("includeTransfers", true, null),
      save("includeTransfers", true, [NEW]),
      save("includeTransfers", null),
      // Value schemas.
      save("dashboard_settings", { excludedCategoryIds: "1" }),
      save("dashboard_settings", { excludedCategoryIds: [1, "2", "x"] }),
      save("dashboard_settings", { excludedCategoryIds: [1, [2, [3, null]]] }),
      save("dashboard_settings", { excludedCategoryIds: [{}] }),
      save("dashboard_settings", { excludedCategoryIds: [null] }),
      save("dashboard_settings", { excludedCategoryIds: [0] }),
      save("dashboard_settings", { excludedCategoryIds: [2147483648] }),
      save("dashboard_settings", { excludedCategoryIds: [1.5] }),
      save("dashboard_settings", { excludedCategoryIds: ["1e3"] }),
      save("dashboard_settings", { excludedCategoryIds: [true] }),
      save("dashboard_settings", {
        excludedRecipientIds: 7,
        excludeHiddenCategories: "yes",
        exclusionScope: "x",
      }),
      save("dashboard_settings", []),
      save("dashboard_settings", {
        excludedCategoryIds: ["03", 4, "2147483647"],
        extra: { keep: [true] },
      }),
      read("dashboard_settings"),
      save("theme_settings", {
        mode: "dim",
        schedule: { lightFrom: "7:00", darkFrom: "24:00" },
        variant: 5,
      }),
      save("theme_settings", { schedule: null }),
      save("theme_settings", {
        schedule: { lightFrom: "23:59", darkFrom: "19:60" },
      }),
      save("theme_settings", "dark"),
      save("cost_basis_method", "avg"),
      save("cost_basis_method", 5),
      save("includeTransfers", "true"),
      save("onboarding_complete", 1),
      save("fx_full_history_repair_done", []),
      save("app_settings", []),
      save("backup_settings", null),
      save("services_settings", "x"),
      save("dismissed_recurring_patterns", {}),
      save("dismissed_recurring_patterns", [1, "a", null, { b: 2 }]),
      save("brokerage_cash_category_ids", {
        dividend: 1.5,
        interest: 0,
        fee: null,
        tax: 2147483648,
        extra: 1,
      }),
      save("brokerage_cash_category_ids", { dividend: null }),
      save("brokerage_cash_category_ids", {
        dividend: 9007199254740993,
        interest: -9007199254740993,
        fee: "1",
        tax: true,
      }),
      save(
        "brokerage_cash_category_ids",
        jsonText(
          '{"dividend":1,"interest":2,"fee":3,"tax":4,"__proto__":5,"z":6}',
        ),
      ),
      save("brokerage_cash_category_ids", {
        dividend: 1,
        interest: null,
        fee: 3,
        tax: null,
      }),
      save("rebalance_plans", [
        { id: "", name: "   ", targetWeights: {}, cashCap: -1 },
      ]),
      save("rebalance_plans", [
        { id: "p1", name: "x".repeat(81), targetWeights: { a: "abc", b: 1 } },
      ]),
      save("rebalance_plans", [
        { id: "p1", name: "ok", targetWeights: { a: 0, b: "0", c: null } },
      ]),
      save("rebalance_plans", [{ id: "p1", name: "ok", targetWeights: [1] }]),
      save("rebalance_plans", [
        { id: "p1", name: "  ﻿", targetWeights: { a: [2] }, cashCap: "x" },
      ]),
      save("rebalance_plans", [{ id: 1, name: null }]),
      save("rebalance_plans", [
        { name: "n", targetWeights: { a: "Infinity" } },
      ]),
      save("rebalance_plans", [
        { id: "p", name: "n", targetWeights: { a: "-0x10", b: "0x10" } },
      ]),
      save(
        "rebalance_plans",
        Array.from({ length: 51 }, () => ({ id: "" })),
      ),
      save("rebalance_plans", [
        {
          id: "p1",
          name: "Core 🚀",
          targetWeights: { "2": "0.5", "10": 0.5, eq: [1], bond: " 1e-1 " },
          cashCap: "100",
          note: { keep: true },
        },
      ]),
      read("rebalance_plans"),
      save("belgian_tax_profile", {
        communalSurchargePercent: 70,
        grossAnnualIncome: -1,
        unionDues: 1e13,
        dependentChildren: 1.5,
        serviceVoucherCount: 1001,
        taxYear: 1800,
        cadastralCentimesOverride: 100001,
        selfEmployedIncomeKind: "wages",
        additionalResidences: [
          { cadastralIncome: "x", centimesOverride: null },
          3,
        ],
        unknownField: "kept",
      }),
      save("belgian_tax_profile", {
        grossAnnualIncome: null,
        taxYear: 2024,
        selfEmployedIncomeKind: "fees",
        extra: "keep",
      }),
      save("belgian_tax_profile", null),
      save("belgian_tax_profile_snapshots_v1", {
        "2024": { taxYear: "x" },
        abc: 5,
        "1": { mortgageStartYear: 2201 },
      }),
      save("belgian_tax_profile_snapshots_v1", []),
      save("belgian_tax_profile_snapshot_meta_v1", {
        "2024": { frozenCalculation: { federalPITTotal: 1 } },
        "2023": { frozenCalculation: 5 },
        x: { frozenHouseholdResult: null },
        y: [],
      }),
      save("belgian_tax_profile_snapshot_meta_v1", {
        "2024": { frozenCalculation: { federalPITBeforeExemption: 1 } },
      }),
      save("portfolio_tax_classifications_v1", { "12": 5, "13": {} }),
      // Household (ADR-200).
      save("belgian_tax_household_v2", household(2024)),
      read("belgian_tax_household_v2"),
      save("belgian_tax_household_v2", {}),
      save("belgian_tax_household_v2", []),
      save(
        "belgian_tax_household_v2",
        household(2024.5, {
          version: 3,
          region: "x",
          communalSurchargePercent: 10,
        }),
      ),
      save("belgian_tax_household_v2", household(2024, { partners: [] })),
      save(
        "belgian_tax_household_v2",
        household(2024, {
          partners: [partner("A", []), partner("B", []), partner("B", [])],
        }),
      ),
      save(
        "belgian_tax_household_v2",
        household(2024, {
          partners: [
            partner("B", [
              {
                id: "act_x",
                kind: "employee",
                grossIncome: 1,
                netProfessionalIncome: 5,
                pensionKind: "other",
              },
              {
                id: "act_x",
                kind: "pension",
                grossIncome: 1,
                pensionKind: "other",
              },
            ]),
            partner("B", [
              {
                id: "act_y",
                kind: "net_professional_amount",
                grossIncome: 1,
                netProfessionalIncome: 1,
              },
            ]),
          ],
          relationship: {
            events: [
              { id: "e1", kind: "death", date: "2024-01-01" },
              {
                id: "e2",
                kind: "marriage",
                date: "2024-01-02",
                partnerId: "A",
              },
            ],
          },
          dependents: { children: 1, otherPersons: 0, claimantPartnerId: "A" },
          home: {
            cadastralIncome: 0,
            mortgageInterestPaid: 0,
            mortgageCreditPartnerId: "A",
          },
        }),
      ),
      save(
        "belgian_tax_household_v2",
        household(2024, {
          partners: [
            partner(
              "A",
              [
                {
                  id: "bad",
                  kind: "employee",
                  grossIncome: 1,
                  startDate: "2024-02-30",
                  endDate: "2023-02-29",
                  label: "é".repeat(201),
                  sourceRefs: Array.from({ length: 101 }, () => 5),
                },
                {
                  id: `act_${"a".repeat(65)}`,
                  kind: "wizard",
                  grossIncome: -1,
                  startDate: "2000-02-29",
                },
              ],
              {
                professionalExpenses: {
                  remuneration: { method: "actual", actualAmount: 5 },
                  bogus: {},
                  fees: { method: "x" },
                },
                reductions: {
                  personalPensionContributions: 1,
                  pensionScheme: "1000",
                },
                displayName: "n".repeat(81),
                birthYear: 1899,
              },
            ),
          ],
          relationship: {
            events: Array.from({ length: 51 }, () => 1),
            deathYearElection: "x",
          },
          dependents: { children: -1 },
          home: {
            cadastralIncome: 0,
            mortgageInterestPaid: 0,
            additionalResidences: [
              { cadastralIncome: 1, region: "mars", label: 5 },
            ],
            mortgageSharePartnerB: 101,
          },
          taxIncomeCategoryIds: [1, 0, 2.5],
          migratedFrom: {
            fromVersion: 2,
            unmappedFields: [
              { field: "x" },
              { field: "y", note: "n", value: { any: 1 } },
            ],
          },
        }),
      ),
      save(
        "belgian_tax_household_v2",
        household(2024, { partners: Array.from({ length: 3 }, () => 1) }),
      ),
      save("belgian_tax_household_snapshots_v2", {
        "2024": household(2025),
        "24": household(24),
      }),
      save("belgian_tax_household_snapshots_v2", {
        "2024": household(2025),
        "2023": household(2023),
      }),
      save("belgian_tax_household_snapshots_v2", {
        "2025": household(2025, { partners: [] }),
        "2026": household(2027),
      }),
      save("belgian_tax_household_snapshots_v2", { "2024": household(2024) }),
      // Bulk saves.
      bulk({}),
      { operationId: "saveSettings", method: "PUT", path: "/api/settings" },
      bulk([]),
      bulk({ settings: [], expected: [] }),
      bulk({ settings: { nope: 1, includeTransfers: true }, expected: {} }),
      bulk(jsonText('{"settings":{"__proto__":1}}')),
      bulk({
        settings: { includeTransfers: true, constructor: 1 },
        expected: {},
      }),
      bulk({ settings: { [LONG_KEY]: 1 }, expected: {} }),
      bulk({ settings: { includeTransfers: true }, expected: {} }),
      bulk({
        settings: { includeTransfers: true },
        expected: { includeTransfers: { exists: true } },
      }),
      bulk({
        settings: { onboarding_complete: 1, includeTransfers: "x" },
        expected: { includeTransfers: NEW, onboarding_complete: NEW },
      }),
      bulk({ settings: {}, expected: {} }),
      bulk({
        settings: {
          widget_visibility: { d: 1 },
          services_settings: { keepServicesOnQuit: true },
        },
        expected: {
          services_settings: NEW,
          widget_visibility: { exists: true, value: { c: true, "2": false } },
          extra: 1,
        },
      }),
      bulk({
        settings: {
          theme_settings: { mode: "dark" },
          backup_settings: { backupDir: "/x" },
        },
        expected: {
          backup_settings: NEW,
          theme_settings: { exists: true, value: { mode: "dark" } },
        },
      }),
      read("backup_settings"),
      read("services_settings"),
      list("?withBaselines=true"),
    ],
  },
  "exchange-rates": {
    router: { module: "info/rates.ts", mountPath: "/api/info" },
    seed: [
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
        ${RATE_ROW("AUD", "0.61", "2099-01-01", 1, "2025-03-02T10:00:00.123456Z")},
        ${RATE_ROW("USD", "0.9123456789", "2025-01-02", 1)},
        ${RATE_ROW("USD", "0.95", "2024-12-31", 0)},
        ${RATE_ROW("GBP", "1.18", "2025-01-02", 1)},
        ${RATE_ROW("XYZ", "123.4567", "2025-01-02", 1)}`,
    ],
    fetch: {
      [ECB_DAILY]: {
        status: 200,
        body: [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<gesmes:Envelope><Cube><Cube time='2025-03-03'>`,
          `<Cube currency='USD' rate='1.0812'/>`,
          `<Cube currency="GBP" rate="0.83465" />`,
          `<Cube\tcurrency='JPY'\nrate="162.2.5"/>`,
          `<Cube currency='CHF' rate='0.00001'/>`,
          `<Cube currency='SEK' rate='.'/>`,
          `<Cube currency='usd' rate='1'/>`,
          `<Cube currency='NOK' rate='11.5'/><Cube currency='NOK' rate='11.75'/>`,
          `</Cube></Cube></gesmes:Envelope>`,
        ].join("\n"),
      },
      [ER_API_LATEST]: {
        status: 200,
        body: JSON.stringify({
          result: "success",
          rates: {
            EUR: 1,
            USD: 1.09,
            AED: 3.97,
            "123": 2,
            KWD: "0.33",
            ZWL: 1e6,
            XAU: 0.00005,
            QAR: 3.93,
          },
        }),
      },
    },
    steps: [
      ratesList(),
      ratesList("?db_only=true"),
      ratesList("?db_only=1"),
      ratesList("?db_only=yes"),
      ratesList("?db_only=FALSE"),
      ratesList("?db_only=true&db_only=false"),
      ratesRefresh,
      ratesList("?db_only=true"),
    ],
  },
  accounts: {
    router: { module: "accounts.ts", mountPath: "/api/accounts" },
    seed: [
      `INSERT INTO recipients (id, name, normalized_name, created_at, updated_at) VALUES
        (1, 'Shop', 'shop', '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO accounts (id, name, display_name, institution, currency, type, liquidity_class, spendable,
         in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active,
         closed_at, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'Main account', 'KBC', 'EUR', 'checking', 'liquid', 1, 1, 'none', 'me', 0, 1, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000001'),
        (2, 'Travel', NULL, NULL, 'USD', 'savings', 'semi_liquid', 0, 1, 'none', 'joint', 1, 1, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000002'),
        (3, 'Old', NULL, NULL, 'EUR', 'checking', 'liquid', 1, 0, 'none', 'partner', 0, 1, NULL, 0,
         '2025-02-01T08:00:00.000000Z', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000003'),
        (4, 'Broker', NULL, 'Bolero', 'EUR', 'brokerage', 'liquid', 1, 1, 'tax_advantaged', 'me', 0, 1, 1, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000004'),
        (5, 'Empty', NULL, NULL, 'GBP', 'wallet', 'illiquid', 0, 1, 'none', 'me', 0, 0, 4, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000005'),
        (6, 'Loan', NULL, NULL, 'EUR', 'liability', 'illiquid', 0, 1, 'pension', 'me', 0, 1, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000006')`,
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
        ${RATE_ROW("USD", "0.9", "2025-01-02", 1)},
        ${RATE_ROW("GBP", "1.15", "2025-01-02", 1)},
        ${RATE_ROW("JPY", "0", "2025-01-02", 1)}`,
      `INSERT INTO transactions (id, date, amount, currency, balance, recipient_id, account_id, is_active, bank_sequence,
         created_at, updated_at) VALUES
        (1, '2024-01-05', vision_numeric('100', 18, 4), 'EUR', NULL, 1, 1, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (2, '2024-01-10', vision_numeric('-20.125', 18, 4), 'EUR', vision_numeric('1000', 18, 4), 1, 1, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (3, '2024-01-10', vision_numeric('5.005', 18, 4), 'EUR', NULL, 1, 1, 1, vision_numeric('7', 18, 0),
         '${SEED_TIME}', '${SEED_TIME}'),
        (4, '2024-02-01', vision_numeric('-0.015', 18, 4), 'EUR', NULL, 1, 1, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (5, '2024-02-02', vision_numeric('999', 18, 4), 'EUR', NULL, 1, 1, 0, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (6, '2099-01-01', vision_numeric('50', 18, 4), 'EUR', NULL, 1, 1, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (7, '2024-03-01', vision_numeric('250.5', 18, 4), 'USD', NULL, 1, 2, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (8, '2024-03-02', vision_numeric('40', 18, 4), 'EUR', NULL, 1, 2, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (9, '2024-03-03', vision_numeric('12', 18, 4), 'CHF', NULL, 1, 2, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (10, '2024-03-04', vision_numeric('-3.3333', 18, 4), 'GBP', vision_numeric('77.7777', 18, 4), 1, 2, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (11, '2024-03-05', vision_numeric('8', 18, 4), 'JPY', NULL, 1, 2, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (12, '2024-04-01', vision_numeric('-1500', 18, 4), 'EUR', NULL, 1, 6, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (13, '2024-05-01', vision_numeric('0', 18, 4), 'EUR', NULL, 1, 3, 1, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (14, '2024-05-02', vision_numeric('0.004', 18, 4), 'USD', NULL, 1, 4, 1, NULL, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO account_statement_balances (account_id, currency, balance, balance_date) VALUES
        (1, 'EUR', vision_numeric('1100.5', 18, 4), '2024-03-31'),
        (1, 'USD', vision_numeric('3', 18, 4), '2024-03-30'),
        (6, 'USD', vision_numeric('-10', 18, 4), '2024-04-30')`,
    ],
    steps: [
      accounts(),
      accounts("?active=all"),
      accounts("?active=false"),
      accounts("?active=all&limit=2&offset=1"),
      accounts("?offset=4"),
      accounts("?limit=0"),
      accountCreate({
        name: "  Savings Two  ",
        currency: "usd",
        type: "savings",
        owner: "partner",
        spendable: false,
      }),
      accountCreate({ name: "main" }),
      accountCreate({ name: " MAIN " }),
      accountCreate({}),
      accountCreate({ name: "   " }),
      accountCreate({ name: 5 }),
      accountCreate({
        name: "Bad",
        type: "stock",
        owner: "kids",
        liquidity_class: 1,
        tax_wrapper: null,
      }),
      accountCreate({ name: "Cur", currency: null }),
      accountCreate({ name: "Cur", currency: "EURO" }),
      accountCreate({ name: "Cur", currency: "" }),
      accountCreate({ name: "Fund", funding_account_id: "1e3" }),
      accountCreate({ name: "Fund", funding_account_id: true }),
      accountCreate({ name: "Fund", funding_account_id: 999 }),
      accountCreate({
        name: "Fund",
        funding_account_id: "4",
        display_name: null,
        institution: "  ING ",
      }),
      accountCreate({
        name: "Stmt",
        statement_balance: 1,
        statement_balance_date: "2024-01-01",
      }),
      accountCreate({
        name: "Flags",
        spendable: "yes",
        in_net_worth: 1,
        is_active: false,
        extra: { a: 1 },
      }),
      accountCreate({ name: "Clear", display_name: 5, institution: [] }),
      accountCreate([]),
      { operationId: "createAccount", method: "POST", path: "/api/accounts" },
      accountUpdate("2", {
        name: "Travel USD",
        display_name: "  ",
        institution: null,
      }),
      accountUpdate("2", { is_active: false }),
      accountUpdate("2", { is_active: false, in_net_worth: true }),
      accountUpdate("2", { is_active: true }),
      accountUpdate("1", { funding_account_id: 5 }),
      accountUpdate("1", { funding_account_id: 1 }),
      accountUpdate("1", { funding_account_id: "abc" }),
      accountUpdate("5", { funding_account_id: null, owner: "joint" }),
      accountUpdate("4", { name: "travel usd" }),
      accountUpdate("4", {}),
      accountUpdate("999", { name: "Nobody" }),
      accountUpdate("999", {}),
      accountUpdate("999", { is_active: true }),
      accountUpdate("abc", { name: "x" }),
      accountUpdate("0", { name: "x" }),
      accountUpdate("6", { statement_balance: 5 }),
      accountUpdate("6", {
        type: "checking",
        currency: "gbp",
        has_cash_sleeve: false,
        multi_currency_cash: true,
      }),
      accountDelete("1"),
      accountDelete("3"),
      accountDelete("5"),
      accountDelete("5"),
      accountDelete("abc"),
      accountDelete("1.5"),
      statementPut("1", "EUR", { balance: 1200.25, date: "2024-04-30" }),
      statementPut("1", "usd", { balance: "-3.33335", date: "2024-02-29" }),
      statementPut("1", "gbp%20", {
        balance: 0,
        date: "2024-01-01",
        extra: true,
      }),
      statementPut("2", "JPY", { balance: "1e3", date: ["2024-05-01"] }),
      statementPut("2", "CHF", { balance: true, date: "2024-05-01" }),
      statementPut("2", "CHF", { balance: "", date: "2024-05-01" }),
      statementPut("2", "CHF", { balance: [7], date: "2024-05-01" }),
      statementPut("2", "CHF", { balance: 1e-7, date: "2024-05-01" }),
      statementPut("2", "CHF", { balance: 123456.78905, date: "2024-05-01" }),
      statementPut("6", "EUR", { balance: null, date: "2024-05-01" }),
      statementPut("6", "EUR", { balance: 5, date: null }),
      statementPut("6", "EUR", { balance: 5 }),
      statementPut("6", "EUR", { date: "2024-05-01" }),
      statementPut("6", "EUR", {}),
      statementPut("6", "EUR", []),
      statementPut("6", "EUR"),
      statementPut("6", "EUR", { balance: "abc", date: "2024-02-30" }),
      statementPut("6", "EUR", { balance: 1e12, date: "0050-01-01" }),
      statementPut("6", "EUR", { balance: 1e12 + 1, date: "2024-13-01" }),
      statementPut("6", "EUR", { balance: -1e12, date: " 2024-01-01" }),
      statementPut("6", "EUR", { balance: "Infinity", date: 20240101 }),
      statementPut("6", "EURO", { balance: 1, date: "2024-01-01" }),
      statementPut("6", "E1R", { balance: 1, date: "2024-01-01" }),
      statementPut("999", "EUR", { balance: 1, date: "2024-01-01" }),
      statementPut("999", "EURO", { balance: 1, date: "2024-01-01" }),
      statementPut("abc", "EUR", { balance: 1, date: "2024-01-01" }),
      statementPut("6", "%C3%A9ur", { balance: 1, date: "2024-01-01" }),
      accounts("?active=all"),
    ],
  },
  "exchange-rates-empty": {
    router: { module: "info/rates.ts", mountPath: "/api/info" },
    seed: [],
    fetch: {
      [ECB_DAILY]: { status: 503, body: "unavailable" },
      [ER_API_LATEST]: { status: 200, body: "{not json" },
    },
    steps: [ratesList("?db_only=true"), ratesRefresh, ratesList("?db_only=1")],
  },
};

/** Steps as the corpus stores them: JSON round-tripped, so `-0` and dropped keys compare equal. */
const asRecorded = (steps: ParityStep[]): ParityStep[] =>
  JSON.parse(JSON.stringify(steps)) as ParityStep[];

/** A seeded run of mutated requests per area (scripts/lib/nativeParityMutations.ts). */
function mutationAreas(): Record<string, ParityArea> {
  const tags = AREAS.tags;
  const settings = AREAS.settings;
  const rates = AREAS["exchange-rates"];
  const accountArea = AREAS.accounts;
  if (
    tags === undefined ||
    settings === undefined ||
    rates === undefined ||
    accountArea === undefined
  )
    throw new Error("missing base area");

  const tagRandom = new Random(0x7a65);
  const colors = [
    "#00aaff",
    "#FFF",
    "#12345g",
    "red",
    "",
    null,
    5,
    [],
    {},
    "#123456 ",
    "#abcdef",
  ];
  const tagSteps: ParityStep[] = [];
  for (let i = 0; i < 160; i++) {
    if (tagRandom.chance(0.65)) {
      const body: Record<string, unknown> = {};
      if (tagRandom.chance(0.92))
        body.slug = tagRandom.chance(0.85)
          ? randomText(tagRandom)
          : randomValue(tagRandom, 1);
      if (tagRandom.chance(0.6)) body.color = tagRandom.pick(colors);
      if (tagRandom.chance(0.1))
        body[tagRandom.pick(["extra", "is_active", "id"])] = randomValue(
          tagRandom,
          0,
        );
      tagSteps.push({
        operationId: "createTag",
        method: "POST",
        path: "/api/tags",
        body,
      });
    } else {
      const query = randomQuery(tagRandom, ["active", "limit", "offset"]);
      tagSteps.push({
        operationId: "getTags",
        method: "GET",
        path: `/api/tags${query}`,
      });
    }
  }
  tagSteps.push({
    operationId: "getTags",
    method: "GET",
    path: "/api/tags?active=all&limit=1000",
  });

  const settingRandom = new Random(0x5e77);
  const settingSteps: ParityStep[] = [];
  const keys = [
    ...new Set(
      settings.steps.map((step) =>
        decodeURIComponent(step.path.split("/")[3] ?? ""),
      ),
    ),
  ].filter((key) => key !== "" && !key.startsWith("?"));
  for (const step of mutatedSteps(settingRandom, settings.steps, 3)) {
    settingSteps.push(step);
    if (settingRandom.chance(0.15)) {
      const key = settingRandom.chance(0.8)
        ? settingRandom.pick(keys)
        : randomText(settingRandom, 3);
      settingSteps.push(read(encodeURIComponent(key)));
    }
    if (settingRandom.chance(0.03))
      settingSteps.push(list(randomQuery(settingRandom, ["withBaselines"])));
  }
  settingSteps.push(list("?withBaselines=true"));

  const rateRandom = new Random(0xfe);
  const ecbStatus = [200, 200, 200, 200, 404, 500];
  if (rates.fetch === undefined)
    throw new Error("exchange-rates has no provider answers");
  const rateSteps: ParityStep[] = [
    { ...ratesRefresh, fetch: rates.fetch },
    ratesList("?db_only=true"),
  ];
  for (let i = 0; i < 80; i++) {
    rateSteps.push({
      ...ratesRefresh,
      fetch: {
        [ECB_DAILY]: {
          status: rateRandom.pick(ecbStatus),
          body: randomEcbXml(rateRandom),
        },
        [ER_API_LATEST]: {
          status: rateRandom.pick(ecbStatus),
          body: randomErApi(rateRandom),
        },
      },
    });
    rateSteps.push(
      ratesList(
        rateRandom.chance(0.8)
          ? "?db_only=true"
          : randomQuery(rateRandom, ["db_only"]),
      ),
    );
  }

  // The create and update bodies mutated, between random list queries and
  // updates or deletes of random ids, so later steps meet what earlier ones wrote.
  const accountRandom = new Random(0xacc7);
  const ids = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "0",
    "999",
    "abc",
    "1.5",
    "01",
    "2147483648",
  ];
  const accountSteps: ParityStep[] = [];
  for (const step of mutatedSteps(accountRandom, accountArea.steps, 3)) {
    accountSteps.push(
      step.method === "PATCH" && accountRandom.chance(0.3)
        ? accountUpdate(accountRandom.pick(ids), step.body)
        : step,
    );
    if (accountRandom.chance(0.15))
      accountSteps.push(
        accounts(randomQuery(accountRandom, ["active", "limit", "offset"])),
      );
    if (accountRandom.chance(0.04))
      accountSteps.push(accountDelete(accountRandom.pick(ids)));
  }
  accountSteps.push(accounts("?active=all"));

  return {
    "accounts-mutations": { ...accountArea, steps: asRecorded(accountSteps) },
    "tags-mutations": { ...tags, steps: asRecorded(tagSteps) },
    "settings-mutations": { ...settings, steps: asRecorded(settingSteps) },
    "exchange-rates-mutations": { ...rates, steps: asRecorded(rateSteps) },
  };
}

Object.assign(AREAS, mutationAreas());

interface RecordedStep extends ParityStep {
  status: number;
  response: unknown;
}

/** Drops `meta.requestId`, and `meta` itself when nothing else is in it. */
function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return body;
  const { meta, ...rest } = body as { meta?: Record<string, unknown> };
  if (meta === undefined) return rest;
  const { requestId: _requestId, ...otherMeta } = meta;
  return Object.keys(otherMeta).length > 0
    ? { ...rest, meta: otherMeta }
    : rest;
}

/** The parts of the backend's route-test helpers the recorder uses. */
interface AgentRequest extends PromiseLike<{ status: number; body: unknown }> {
  set(name: string, value: string): AgentRequest;
  send(body: string): AgentRequest;
}
type Agent = Record<
  "get" | "post" | "put" | "patch" | "delete",
  (url: string) => AgentRequest
>;
interface RouteAppModule {
  createRouteApp: (
    router: unknown,
    options: { mountPath: string; isProduction: () => boolean },
  ) => unknown;
}
interface HttpAgentModule {
  httpAgent: (app: unknown) => Agent;
}

async function recordArea(
  name: string,
  area: ParityArea,
): Promise<RecordedStep[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vision-parity-${name}-`));
  const file = path.join(dir, "vision.sqlite3");
  // Before any backend module loads its settings.
  process.env.VISION_DATABASE_PATH = file;
  process.env.NODE_ENV = "test";
  process.env.APP_TIMEZONE = "Europe/Brussels";
  // The routes' rate limiters guard a network listener; the in-process Swift backend has
  // none (ADR-270), so a long corpus must not record their 429s.
  process.env.VISION_DEV = "true";
  let stubs = area.fetch ?? {};
  if (
    area.fetch !== undefined ||
    area.steps.some((step) => step.fetch !== undefined)
  ) {
    globalThis.fetch = (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const stub = stubs[url];
      if (stub === undefined)
        return Promise.reject(new TypeError(`fetch failed: ${url}`));
      return Promise.resolve(new Response(stub.body, { status: stub.status }));
    };
  }
  const { runMigrations } =
    await import("../apps/node-backend/src/database/migrate.ts");
  await runMigrations(file, { skipBackup: true });
  const { openDatabase } =
    await import("../apps/node-backend/src/database/connection.ts");
  const seedDb = openDatabase(file, "writer");
  for (const statement of area.seed) seedDb.exec(statement);
  seedDb.close();

  // The test helpers and routers load by path: routeApp.ts also holds vitest helpers,
  // which this script's program does not type.
  const backendModule = (...parts: string[]) =>
    repoPath("apps/node-backend", ...parts);
  const { createRouteApp } = (await import(
    backendModule("tests/helpers/routeApp.ts")
  )) as RouteAppModule;
  const { httpAgent } = (await import(
    backendModule("tests/helpers/httpAgent.ts")
  )) as HttpAgentModule;
  const { default: router } = (await import(
    backendModule("src/routes", area.router.module)
  )) as {
    default: unknown;
  };
  // The packaged backend runs in production, which masks 5xx messages.
  const agent = httpAgent(
    createRouteApp(router, {
      mountPath: area.router.mountPath,
      isProduction: () => true,
    }),
  );
  const { todayAppDateString } = (await import(
    backendModule("src/lib/timezone.ts")
  )) as {
    todayAppDateString: () => string;
  };
  const recorded: RecordedStep[] = [];
  for (const step of area.steps) {
    if (step.fetch !== undefined) stubs = step.fetch;
    const method = step.method.toLowerCase() as
      "get" | "post" | "put" | "patch" | "delete";
    const request = agent[method](step.path);
    if ("body" in step)
      request
        .set("Content-Type", "application/json")
        .send(JSON.stringify(step.body));
    const res = await request;
    const today = todayAppDateString();
    const response = JSON.parse(
      JSON.stringify(withoutRequestId(res.body), (_key, value: unknown) =>
        value === today ? TODAY_TOKEN : value,
      ),
    ) as unknown;
    recorded.push({ ...step, status: res.status, response });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return recorded;
}

/** The corpus file of one area: the seed and the recorded steps. */
function corpusText(area: ParityArea, steps: RecordedStep[]): string {
  const corpus = {
    generatedBy: "bun run native:parity",
    seed: area.seed,
    fetch: area.fetch,
    steps,
  };
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

/**
 * Each area records in its own process: the backend reads its database path
 * once, when its settings module first loads.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--record") {
    const name = args[1] ?? "";
    const area = AREAS[name];
    if (area === undefined) throw new Error(`unknown parity area: ${name}`);
    const steps = await recordArea(name, area);
    fs.mkdirSync(PARITY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PARITY_DIR, `${name}.json`),
      corpusText(area, steps),
    );
    console.log(`${name}: ${steps.length} steps`);
    // The routers' modules keep timers and connections open.
    process.exit(0);
  }
  for (const name of Object.keys(AREAS)) {
    if (args.length > 0 && !args.includes(name)) continue;
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--record", name],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );
    if (child.status !== 0) throw new Error(`recording ${name} failed`);
  }
}

if (isEntrypoint(import.meta)) await main();
