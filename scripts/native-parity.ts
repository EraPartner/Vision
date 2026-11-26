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

/** One file part of a multipart upload, as the client's `MultipartFormData` sends it. */
interface MultipartFilePart {
  /** The form field the file travels under (`file` for the upload routes). */
  name: string;
  /** What the part's `filename=` carries: `originalname` to multer. */
  filename: string;
  /** The part's own `Content-Type`; absent parts are sent by busboy's default. */
  contentType?: string;
  /** The file's bytes (`octet-stream`-safe encoding, as the corpus holds them). */
  base64: string;
}

interface ParityStep {
  /** The generated client's operationId the request belongs to. */
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path and query, as the client sends them. */
  path: string;
  /** JSON body; absent for none. Never combined with `multipart`. */
  body?: unknown;
  /**
   * A multipart/form-data body instead of a JSON one: the hand-written upload routes'
   * file parts and text fields (`MultipartFormData` on the client, busboy's parse on the
   * server). Absent for the JSON bodies the generated client sends.
   */
  multipart?: {
    fields?: Record<string, string>;
    files: MultipartFilePart[];
  };
  /** Provider answers from this step on, replacing the area's `fetch`. */
  fetch?: Record<string, { status: number; body: string }>;
  /** Headers the route set itself (such as `Idempotent-Replay`). */
  headers?: Record<string, string>;
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
  /**
   * The fixed clock the whole area records under, as an ISO instant: today-dependent
   * answers stay the same on every replay day. Set before any backend module loads, via
   * `setSystemTime`; the Swift replay passes it to `BackendDatabase` as its wall clock.
   */
  now?: string;
}

/** Recorded in place of today's date (APP_TIMEZONE Europe/Brussels): the replay substitutes its own. */
export const TODAY_TOKEN = "{{today}}";

/**
 * Recorded in place of the random UUID an upload's `stored_path` carries: the replay checks
 * the recorded value has the UUID form, as it checks a written timestamp's form only.
 */
export const UUID_TOKEN = "{{uuid}}";

/** Bytes of a text payload, for a file part whose content is plain text. */
const textBytes = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0));

/** One multipart `file` part carrying `contentType` and `filename`. */
function filePart(
  bytes: number[],
  filename: string,
  contentType: string,
): MultipartFilePart {
  return {
    name: "file",
    filename,
    contentType,
    base64: Buffer.from(bytes).toString("base64"),
  };
}

/** The `file` part of an `uploadAttachment` to `path`. */
function upload(
  path: string,
  [bytes, filename, contentType]: [number[], string, string],
): ParityStep {
  return {
    operationId: "uploadAttachment",
    method: "POST",
    path,
    multipart: { files: [filePart(bytes, filename, contentType)] },
  };
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

// The yahoo chart payloads of the prices corpus: schema-valid for yahoo-finance2's
// runtime validation (chart.schema), so the per-symbol close fallback and the
// price-history backfill succeed against the stubbed endpoints.
const CHART_ACME_RECENT = {"chart":{"result":[{"meta":{"currency":"USD","symbol":"ACME","exchangeName":"NMS","instrumentType":"EQUITY","firstTradeDate":1637971200,"regularMarketTime":1795435200,"gmtoffset":3600,"timezone":"CET","exchangeTimezoneName":"Europe/Brussels","regularMarketPrice":151.4,"priceHint":2,"currentTradingPeriod":{"pre":{"timezone":"CET","start":1795262400,"end":1795298400,"gmtoffset":3600},"regular":{"timezone":"CET","start":1795348800,"end":1795384800,"gmtoffset":3600},"post":{"timezone":"CET","start":1795435200,"end":1795471200,"gmtoffset":3600}},"dataGranularity":"1d","range":"5d","validRanges":["1d","5d","1mo","3mo","6mo","1y","2y","5y","10y","ytd","max"]},"timestamp":[1795262400,1795348800,1795435200],"indicators":{"quote":[{"high":[151.25,151.6,151.9],"low":[150.25,150.6,150.9],"open":[150.5,150.85,151.15],"close":[150.75,151.1,151.4],"volume":[1000,1100,900]}]}}],"error":null}};
const CHART_ACME_WINDOW = {"chart":{"result":[{"meta":{"currency":"USD","symbol":"ACME","exchangeName":"NMS","instrumentType":"EQUITY","firstTradeDate":1637971200,"regularMarketTime":1638662400,"gmtoffset":3600,"timezone":"CET","exchangeTimezoneName":"Europe/Brussels","regularMarketPrice":121.25,"priceHint":2,"currentTradingPeriod":{"pre":{"timezone":"CET","start":1637971200,"end":1638007200,"gmtoffset":3600},"regular":{"timezone":"CET","start":1638316800,"end":1638352800,"gmtoffset":3600},"post":{"timezone":"CET","start":1638662400,"end":1638698400,"gmtoffset":3600}},"dataGranularity":"1d","range":"5d","validRanges":["1d","5d","1mo","3mo","6mo","1y","2y","5y","10y","ytd","max"]},"timestamp":[1637971200,1638316800,1638662400],"indicators":{"quote":[{"high":[121.0,122.5,121.75],"low":[120.0,121.5,120.75],"open":[120.25,121.75,121.0],"close":[120.5,122,121.25],"volume":[1000,1100,900]}]}}],"error":null}};

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
const categories = (query = ""): ParityStep => ({
  operationId: "getCategories",
  method: "GET",
  path: `/api/categories${query}`,
});
const categoryCreate = (body?: unknown): ParityStep => ({
  operationId: "createCategory",
  method: "POST",
  path: "/api/categories",
  ...(body === undefined ? {} : { body }),
});
const categoryTree: ParityStep = {
  operationId: "getCategoryTree",
  method: "GET",
  path: "/api/categories/tree",
};
const nodeCreate = (body: unknown): ParityStep => ({
  operationId: "createCategoryNode",
  method: "POST",
  path: "/api/categories/tree",
  body,
});
const nodeUpdate = (id: string, body: unknown): ParityStep => ({
  operationId: "updateCategoryNode",
  method: "PATCH",
  path: `/api/categories/tree/${id}`,
  body,
});
const nodeDelete = (id: string): ParityStep => ({
  operationId: "deleteCategoryNode",
  method: "DELETE",
  path: `/api/categories/tree/${id}`,
});
const nodeMerge = (id: string, body: unknown): ParityStep => ({
  operationId: "mergeCategoryNode",
  method: "POST",
  path: `/api/categories/tree/${id}/merge`,
  body,
});
const recipients = (query = ""): ParityStep => ({
  operationId: "getRecipients",
  method: "GET",
  path: `/api/recipients${query}`,
});
const recipientRead = (id: string): ParityStep => ({
  operationId: "getRecipient",
  method: "GET",
  path: `/api/recipients/${id}`,
});
const recipientCreate = (body?: unknown): ParityStep => ({
  operationId: "createRecipient",
  method: "POST",
  path: "/api/recipients",
  ...(body === undefined ? {} : { body }),
});
const recipientUpdate = (id: string, body: unknown): ParityStep => ({
  operationId: "updateRecipient",
  method: "PATCH",
  path: `/api/recipients/${id}`,
  body,
});
const recipientDelete = (id: string): ParityStep => ({
  operationId: "deleteRecipient",
  method: "DELETE",
  path: `/api/recipients/${id}`,
});
const recipientMerge = (id: string, body: unknown): ParityStep => ({
  operationId: "mergeRecipient",
  method: "POST",
  path: `/api/recipients/${id}/merge`,
  body,
});
const recipientUnmerge = (id: string): ParityStep => ({
  operationId: "unmergeRecipient",
  method: "POST",
  path: `/api/recipients/${id}/unmerge`,
});
const patternList = (id: string): ParityStep => ({
  operationId: "getRecipientPatterns",
  method: "GET",
  path: `/api/recipients/${id}/patterns`,
});
const patternCreate = (id: string, body: unknown): ParityStep => ({
  operationId: "createRecipientPattern",
  method: "POST",
  path: `/api/recipients/${id}/patterns`,
  body,
});
const patternPreview = (id: string, body: unknown): ParityStep => ({
  operationId: "previewRecipientPattern",
  method: "POST",
  path: `/api/recipients/${id}/patterns/preview`,
  body,
});
const patternUpdate = (
  id: string,
  patternId: string,
  body: unknown,
): ParityStep => ({
  operationId: "updateRecipientPattern",
  method: "PATCH",
  path: `/api/recipients/${id}/patterns/${patternId}`,
  body,
});
const patternDelete = (id: string, patternId: string): ParityStep => ({
  operationId: "deleteRecipientPattern",
  method: "DELETE",
  path: `/api/recipients/${id}/patterns/${patternId}`,
});
const accountDelete = (id: string): ParityStep => ({
  operationId: "deleteAccount",
  method: "DELETE",
  path: `/api/accounts/${id}`,
});
const accountLotPreview = (id: string): ParityStep => ({
  operationId: "previewAccountPortfolioLots",
  method: "GET",
  path: `/api/accounts/${id}/portfolio-lot-retag-preview`,
});
const accountClose = (id: string, body: unknown): ParityStep => ({
  operationId: "closeAccount",
  method: "POST",
  path: `/api/accounts/${id}/close`,
  body,
});
const accountMergePreview = (id: string, query = ""): ParityStep => ({
  operationId: "previewAccountMerge",
  method: "GET",
  path: `/api/accounts/${id}/merge-preview${query}`,
});
const accountMerge = (id: string, body: unknown): ParityStep => ({
  operationId: "mergeAccounts",
  method: "POST",
  path: `/api/accounts/${id}/merge`,
  body,
});
const accountOpeningBalance = (id: string, body: unknown): ParityStep => ({
  operationId: "setAccountOpeningBalance",
  method: "POST",
  path: `/api/accounts/${id}/opening-balance`,
  body,
});
const accountReconcile = (id: string, body: unknown): ParityStep => ({
  operationId: "reconcileAccount",
  method: "POST",
  path: `/api/accounts/${id}/reconcile`,
  body,
});
const splitsOwed = (query = ""): ParityStep => ({
  operationId: "getSplitsOwed",
  method: "GET",
  path: `/api/splits/owed${query}`,
});
const splitsOwedBy = (id: string, query = ""): ParityStep => ({
  operationId: "getSplitOwedByRecipient",
  method: "GET",
  path: `/api/splits/owed/${id}${query}`,
});
const splitsOwedExport = (id: string): ParityStep => ({
  operationId: "exportSplitsOwedCsv",
  method: "GET",
  path: `/api/splits/owed/${id}/export/csv`,
});
const splitsOfTransaction = (id: string, query = ""): ParityStep => ({
  operationId: "getSplitsByTransaction",
  method: "GET",
  path: `/api/splits/transaction/${id}${query}`,
});
const splitCreate = (body: unknown): ParityStep => ({
  operationId: "createSplit",
  method: "POST",
  path: "/api/splits",
  body,
});
const splitBatch = (body: unknown): ParityStep => ({
  operationId: "createSplitBatch",
  method: "POST",
  path: "/api/splits/batch",
  body,
});
const splitBulk = (body: unknown): ParityStep => ({
  operationId: "createBulkSplits",
  method: "POST",
  path: "/api/splits/bulk",
  body,
});
const splitPay = (id: string, body: unknown): ParityStep => ({
  operationId: "paySplit",
  method: "POST",
  path: `/api/splits/${id}/pay`,
  body,
});
const splitPayments = (id: string, query = ""): ParityStep => ({
  operationId: "getSplitPayments",
  method: "GET",
  path: `/api/splits/${id}/payments${query}`,
});
const splitSettle = (id: string): ParityStep => ({
  operationId: "settleSplit",
  method: "POST",
  path: `/api/splits/${id}/settle`,
});
const splitSettleAll = (id: string): ParityStep => ({
  operationId: "settleAllSplitsForRecipient",
  method: "POST",
  path: `/api/splits/owed/${id}/settle-all`,
});
const splitDelete = (id: string): ParityStep => ({
  operationId: "deleteSplit",
  method: "DELETE",
  path: `/api/splits/${id}`,
});
const parserList = (): ParityStep => ({
  operationId: "getCustomParsers",
  method: "GET",
  path: "/api/import/parsers",
});
const parserCreate = (body: unknown): ParityStep => ({
  operationId: "createCustomParser",
  method: "POST",
  path: "/api/import/parsers",
  body,
});
const parserUpdate = (id: string, body: unknown): ParityStep => ({
  operationId: "updateCustomParser",
  method: "PATCH",
  path: `/api/import/parsers/${id}`,
  body,
});
const batches = (query = ""): ParityStep => ({
  operationId: "getImportBatches",
  method: "GET",
  path: `/api/import/batches${query}`,
});
const batchDelete = (id: string): ParityStep => ({
  operationId: "deleteImportBatch",
  method: "DELETE",
  path: `/api/import/batches/${id}`,
});
const batchPreview = (id: string): ParityStep => ({
  operationId: "previewImportBatch",
  method: "GET",
  path: `/api/import/batches/${id}/preview`,
});
const batchCommit = (id: string): ParityStep => ({
  operationId: "commitImportBatch",
  method: "POST",
  path: `/api/import/batches/${id}/commit`,
});
const csvUploadStep = (
  operationId: string,
  path: string,
  {
    filename,
    contentType,
    content,
    fields,
  }: {
    filename: string;
    contentType?: string;
    content: string;
    fields?: Record<string, string>;
  },
): ParityStep => ({
  operationId,
  method: "POST",
  path,
  multipart: {
    ...(fields !== undefined ? { fields } : {}),
    files:
      filename === ""
        ? []
        : [
            {
              name: "file",
              filename,
              contentType: contentType ?? "text/csv",
              base64: Buffer.from(content).toString("base64"),
            },
          ],
  },
});
const kbcLine = (
  date: string,
  amount: string,
  balance: string,
  credit: string,
  debit: string,
  counterparty: string,
): string =>
  `BE31001122334455;KBCAUTOTEST;BE;EUR;STMT01;${date};OPN;${date};${amount};${balance};${credit};${debit};BE99123456789012;BICBEB22XXX;${counterparty};Importerslaan 1;+++123/4567/89012;;;`;
const batchOverrideRecipient = (
  id: string,
  rowId: string,
  body?: unknown,
): ParityStep =>
  body === undefined
    ? {
        operationId: "overrideImportRow",
        method: "POST",
        path: `/api/import/batches/${id}/rows/${rowId}/override`,
      }
    : {
        operationId: "overrideImportRow",
        method: "POST",
        path: `/api/import/batches/${id}/rows/${rowId}/override`,
        body,
      };
const batchOverrideCategory = (
  id: string,
  rowId: string,
  body?: unknown,
): ParityStep =>
  body === undefined
    ? {
        operationId: "overrideImportRowCategory",
        method: "POST",
        path: `/api/import/batches/${id}/rows/${rowId}/category-override`,
      }
    : {
        operationId: "overrideImportRowCategory",
        method: "POST",
        path: `/api/import/batches/${id}/rows/${rowId}/category-override`,
        body,
      };
const parserDelete = (id: string): ParityStep => ({
  operationId: "deleteCustomParser",
  method: "DELETE",
  path: `/api/import/parsers/${id}`,
});
const PARSER_CONFIG = {
  dateColumn: "Date",
  recipientColumn: "Name",
  amountColumn: "Amount",
  memoColumn: " memo ",
  dateFormat: "%d/%m/%Y",
  separator: ";",
  encoding: "utf-8",
  number_format: "decimal_comma",
  skipRows: 2,
};
const transactions = (query = ""): ParityStep => ({
  operationId: "getTransactions",
  method: "GET",
  path: `/api/transactions${query}`,
});
const transactionRead = (id: string): ParityStep => ({
  operationId: "getTransaction",
  method: "GET",
  path: `/api/transactions/${id}`,
});
const TRANSACTION_QUERY_KEYS = [
  "transaction_id",
  "start_date",
  "end_date",
  "account_id",
  "bank_account",
  "category_id",
  "category_ids",
  "recipient_id",
  "recipient_group_id",
  "recipient_name",
  "search",
  "active",
  "sort_by",
  "sort_dir",
  "include_balance",
  "transaction_type",
  "amount_min",
  "amount_max",
  "amount_exact",
  "amount_signed",
  "tags",
  "uncategorised",
  "normalize_to_eur",
  "target_currency",
  "limit",
  "offset",
] as const;
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

      // P14 — the remaining account operations: portfolio-lot preview, close,
      // merge preview/merge, opening-balance anchors and reconcile. The steps
      // run on the state the earlier steps left: accounts 1, 2, 3, 4 and 6
      // exist (5 was deleted), 3 is inactive, and the statement puts above
      // rewrote the seeded readings.
      accountLotPreview("4"),
      accountLotPreview("999"),
      accountClose("3", {}),
      accountClose("3", { balance_handling: "closer" }),
      accountClose("3", { balance_handling: "preserve" }),
      accountMergePreview("2"),
      accountMergePreview("2", "?into=2"),
      accountMergePreview("2", "?into=1e3"),
      accountMergePreview("2", "?into=999"),
      accountMergePreview("999", "?into=1"),
      accountMergePreview("2", "?into=1"),
      accountOpeningBalance("4", {
        balance: "800.125",
        date: "2024-06-01",
      }),
      accountOpeningBalance("4", {
        balance: 850,
        date: "2024-01-01",
      }),
      accountOpeningBalance("6", {
        balance: 5,
        date: "2024-04-01",
        currency: "eur",
      }),
      accountOpeningBalance("1", {}),
      accountOpeningBalance("1", { balance: "abc", date: "2024-13-01" }),
      accountOpeningBalance("1", {
        balance: 5,
        date: "2024-01-01",
        currency: "EURO",
      }),
      accountOpeningBalance("999", { balance: 5, date: "2024-01-01" }),
      accountMerge("1", { source_ids: [1] }),
      accountMerge("1", {}),
      accountMerge("1", []),
      accountMerge("1", { source_ids: ["abc"] }),
      accountMerge("1", { source_ids: [3] }),
      accountMerge("4", { source_ids: [1] }),
      accountMerge("4", { source_ids: [6] }),
      accountCreate({ name: "Depend", funding_account_id: 4 }),
      accountMerge("1", { source_ids: [4] }),
      accountReconcile("999", { mode: "accept" }),
      accountReconcile("2", {}),
      accountReconcile("2", { mode: "accept" }),
      accountReconcile("2", { mode: "accept", currency: "CHF" }),
      accountReconcile("1", { mode: "bogus", currency: "EURO" }),
      accountReconcile("1", { mode: "adjustment" }),
      accountReconcile("1", { mode: "accept" }),
      accountReconcile("6", { mode: "adjustment", currency: "usd" }),
      accountClose("2", { balance_handling: "adjustment" }),
      accountClose("2", { balance_handling: "adjustment" }),
      accounts("?active=all"),
    ],
  },
  splits: {
    router: { module: "splits.ts", mountPath: "/api/splits" },
    seed: [
      `INSERT INTO recipients (id, name, normalized_name, primary_recipient_id, notes, is_active, created_at, updated_at) VALUES
        (1, 'Alice', 'alice', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'Alicia', 'alicia', 1, 'alias', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'Bob', 'bob', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'Carol', 'carol', 3, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, 'Dora', 'dora', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO accounts (id, name, display_name, institution, currency, type, liquidity_class, spendable,
         in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active,
         closed_at, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'Main account', 'KBC', 'EUR', 'checking', 'liquid', 1, 1, 'none', 'me', 0, 1, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000011'),
        (2, 'Travel', NULL, NULL, 'USD', 'savings', 'semi_liquid', 0, 1, 'none', 'joint', 1, 1, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000012')`,
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
        ${RATE_ROW("USD", "0.9", "2025-01-02", 1)},
        ${RATE_ROW("GBP", "1.15", "2025-01-02", 1)}`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active, created_at,
         updated_at) VALUES
        (1, '2024-01-05', vision_numeric('100', 18, 4), 'EUR', 'Groceries', 1, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, '2024-01-20', vision_numeric('-60', 18, 4), 'EUR', 'Concert', 3, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, '2024-01-25', vision_numeric('250.5', 18, 4), 'USD', 'Hotel', 4, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, '2024-02-01', vision_numeric('30', 18, 4), 'CHF', 'Ski pass', 3, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, '2024-02-10', vision_numeric('0', 18, 4), 'EUR', 'Free', 5, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (6, '2024-02-15', vision_numeric('80', 18, 4), 'EUR', 'Dinner', 1, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (7, '2024-02-20', vision_numeric('100', 18, 4), 'EUR', 'Tickets', 5, 1, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transaction_splits (id, transaction_id, recipient_id, amount, note, is_settled, created_at, updated_at) VALUES
        (1, 1, 1, vision_numeric('40', 18, 4), NULL, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 2, 3, vision_numeric('60', 18, 4), 'full share', 0, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 3, 4, vision_numeric('100', 18, 4), NULL, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 4, 3, vision_numeric('20', 18, 4), NULL, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (5, 1, 2, vision_numeric('10', 18, 4), 'part', 0, '${SEED_TIME}', '${SEED_TIME}'),
        (6, 3, 3, vision_numeric('50', 18, 4), NULL, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (7, 6, 5, vision_numeric('80', 18, 4), 'already settled', 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO split_payments (id, split_id, amount, paid_at, note, created_at) VALUES
        (1, 3, vision_numeric('40', 18, 4), '2024-01-26', 'first', '${SEED_TIME}'),
        (2, 4, vision_numeric('5', 18, 4), '2024-02-02', NULL, '${SEED_TIME}')`,
    ],
    steps: [
      splitsOwed(),
      splitsOwed("?currency=usd"),
      splitsOwed("?currency=EURO"),
      splitsOwed("?limit=1&offset=1"),
      splitsOwedBy("1"),
      splitsOwedBy("1", "?limit=1"),
      splitsOwedBy("abc"),
      splitsOwedBy("999", "?currency=USD"),
      splitsOwedExport("3"),
      splitsOwedExport("5"),
      splitsOwedExport("999"),
      splitsOfTransaction("1"),
      splitsOfTransaction("1", "?limit=1&offset=1"),
      splitsOfTransaction("999"),
      splitsOfTransaction("abc"),
      splitCreate({
        transaction_id: 6,
        recipient_id: 5,
        amount: 25,
        note: "half",
      }),
      splitCreate({ transaction_id: 6, recipient_id: 5, amount: 100 }),
      splitCreate({ transaction_id: 6, recipient_id: 5, amount: 0 }),
      splitCreate({}),
      splitCreate({ transaction_id: "abc", recipient_id: 1, amount: 5 }),
      splitCreate({ transaction_id: 1, recipient_id: 1, amount: "abc" }),
      splitCreate({ transaction_id: 0, recipient_id: 1, amount: 5 }),
      splitCreate({ transaction_id: 999, recipient_id: 1, amount: 5 }),
      splitCreate([]),
      splitBatch({
        transaction_id: 1,
        splits: [
          { recipient_id: 5, amount: 20 },
          { recipient_id: 2, amount: "12.5", note: "batch part" },
        ],
      }),
      splitBatch({ transaction_id: 6, splits: [] }),
      splitBatch({
        transaction_id: "abc",
        splits: [{ recipient_id: 5, amount: 1 }],
      }),
      splitBatch({
        transaction_id: 1,
        splits: [{ recipient_id: 1, amount: "x" }],
      }),
      splitBatch({
        transaction_id: 1,
        splits: [
          { recipient_id: 1, amount: 1 },
          { recipient_id: 4, amount: "zz" },
        ],
      }),
      splitBatch({
        transaction_id: 1,
        splits: [{ recipient_id: 5, amount: 999999 }],
      }),
      splitBatch({
        transaction_id: 999,
        splits: [{ recipient_id: 5, amount: 1 }],
      }),
      splitBulk({
        transaction_ids: [7, 6, 5, 999],
        recipient_id: 5,
        mode: "equal",
        note: "bulk",
      }),
      splitBulk({ transaction_ids: [7], recipient_id: 999, mode: "full" }),
      splitBulk({ transaction_ids: [], recipient_id: 5, mode: "full" }),
      splitBulk({ transaction_ids: "123", recipient_id: 5, mode: "full" }),
      splitBulk({ transaction_ids: [999], recipient_id: 5, mode: "half" }),
      splitBulk({
        transaction_ids: ["abc", "1.5"],
        recipient_id: 5,
        mode: "equal",
      }),
      splitBulk({ transaction_ids: [7], recipient_id: "x", mode: "equal" }),
      splitBulk({
        transaction_ids: [7],
        recipient_id: 5,
        mode: "equal",
        note: "x".repeat(501),
      }),
      splitPay("1", { amount: 10, note: "cash" }),
      splitPay("1", { amount: 100 }),
      splitPay("2", { amount: 60, paid_at: "2024-03-01" }),
      splitPay("2", { amount: 1 }),
      splitPay("1", { amount: 0 }),
      splitPay("999", { amount: 1 }),
      splitPayments("1"),
      splitPayments("1", "?limit=1&offset=1"),
      splitPayments("999"),
      splitSettle("6"),
      splitSettle("999"),
      splitSettleAll("3"),
      splitDelete("4"),
      splitDelete("4"),
      splitsOwed(),
      splitsOwedBy("1"),
    ],
  },
  importParsers: {
    router: { module: "importRoutes.ts", mountPath: "/api/import" },
    seed: [
      `INSERT INTO custom_parser_configs (id, name, kind, config_json, created_at, updated_at) VALUES
        (1, 'KBC main', 'transaction', vision_jsonb('{"dateColumn":"Datum","recipientColumn":"Naam","amountColumn":"Bedrag","memoColumn":"","dateFormat":"%d/%m/%Y","separator":";","encoding":"latin1","number_format":"decimal_comma","skipRows":1}'), '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'Betaalloverzicht', 'transaction', vision_jsonb('{"dateColumn":"Date","recipientColumn":"Name","amountColumn":"Amount","dateFormat":"%Y-%m-%d","separator":",","encoding":"utf-8","number_format":"auto","skipRows":0}'), '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      parserList(),
      parserCreate({ name: "  Key trade  ", config: PARSER_CONFIG }),
      parserCreate({ name: "KBC main", config: PARSER_CONFIG }),
      parserCreate({ name: "Empty", config: {} }),
      parserCreate({ name: "No config" }),
      parserCreate({ name: 7, config: PARSER_CONFIG }),
      parserCreate({ name: "", config: PARSER_CONFIG }),
      parserCreate({ config: PARSER_CONFIG }),
      parserCreate({ name: "   ", config: PARSER_CONFIG }),
      parserCreate({ name: "Array", config: [] }),
      parserCreate({
        name: "Bare minimum",
        config: { dateColumn: "D", recipientColumn: "R", amountColumn: "A" },
      }),
      parserCreate({
        name: "Zeroes",
        config: { ...PARSER_CONFIG, skipRows: "0", memoColumn: "" },
      }),
      // `parserCreate("text")` (a scalar JSON body) is not recorded: the answer is
      // body-parser strict mode's own, which the Swift side cannot model.
      parserCreate([]),
      parserList(),
      parserUpdate("1", { name: "KBC renamed" }),
      parserUpdate("1", {
        config: { ...PARSER_CONFIG, encoding: "utf8" },
      }),
      parserUpdate("1", {}),
      parserUpdate("999", { name: "Ghost" }),
      parserUpdate("abc", { name: "Bad id" }),
      parserUpdate("1.5", { name: "Bad id" }),
      parserUpdate("1e3", { name: "Bad id" }),
      parserUpdate("-1", { name: "Bad id" }),
      parserUpdate("0", { name: "Bad id" }),
      parserUpdate("1", { name: "Betaalloverzicht" }),
      parserUpdate("1", { name: 5 }),
      parserUpdate("1", { name: "  ", config: [] }),
      parserUpdate("1", { config: { dateColumn: "D", memoColumn: "m" } }),
      parserUpdate("1", { config: { ...PARSER_CONFIG, number_format: "dot" } }),
      parserUpdate("1", { config: { ...PARSER_CONFIG, encoding: "bogus" } }),
      parserUpdate("1", { config: { ...PARSER_CONFIG, skipRows: "abc" } }),
      parserList(),
      parserDelete("1"),
      parserDelete("1"),
      parserDelete("999"),
      parserDelete("abc"),
      parserDelete("2.5"),
      parserDelete("bogus"),
      parserList(),
    ],
  },
  importBatches: {
    router: { module: "importRoutes.ts", mountPath: "/api/import" },
    seed: [
      `INSERT INTO accounts (id, name, display_name, institution, currency, type, liquidity_class, spendable,
         in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active,
         closed_at, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'Main account', 'KBC', 'EUR', 'checking', 'liquid', 1, 1, 'none', 'me', 0, 1, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000021')`,
      `INSERT INTO recipients (id, name, normalized_name, is_active, notes, created_at, updated_at) VALUES
        (10, 'ImportedOne', 'importedone', 1, 'auto-created during the import',
         '2024-06-01T10:00:01.000000Z', '2024-06-01T10:00:01.000000Z'),
        (11, 'KeptOldRef', 'keptoldref', 1, NULL, '2024-05-01T09:00:00.000000Z', '2024-05-01T09:00:00.000000Z')`,
      `INSERT INTO import_batches (id, adapter_name, source_filename, source_size_bytes, status, rows_total,
         rows_imported, rows_duplicate, rows_error, error_summary, started_at, completed_at) VALUES
        (1, 'KBC adapter', 'kbc.csv', 312, 'complete', 3, 2, 1, 0, NULL,
         '2024-06-01T10:00:00.000000Z', '2024-06-01T10:00:05.000000Z'),
        (2, 'BeKey', 'bekey.xlsx', NULL, 'aborted', 2, 1, 0, 1, 'boom',
         '2024-06-02T10:00:00.000000Z', '2024-06-02T10:00:02.000000Z'),
        (3, 'ING', 'ing.csv', 10, 'staging', 10, 0, 0, 0, NULL,
         '2024-06-03T09:00:00.000000Z', NULL),
        (4, 'KBC adapter', 'kbc2.csv', 8, 'awaiting_review', 8, 6, 2, 0, NULL,
         '2024-06-04T09:00:00.000000Z', NULL),
        (5, 'Belfius', NULL, NULL, 'failed', 4, 0, 0, 4, 'could not parse the header',
         '2024-06-05T09:00:00.000000Z', '2024-06-05T09:00:01.000000Z'),
        (6, 'PlannedLinked', 'linked.csv', NULL, 'complete', 1, 1, 0, 0, NULL,
         '2024-06-06T09:00:00.000000Z', '2024-06-06T09:00:03.000000Z')`,
      `INSERT INTO import_staging_rows (id, batch_id, row_index, status, tx_date, bank_account, recipient_raw,
         memo, amount, currency, resolved_recipient_id, created_at, updated_at, match_source) VALUES
        (1, 1, 1, 'matched', '2024-06-01', 'Main', 'ImportedOne', 'Coffee', vision_numeric('4.5', 20, 4), 'EUR',
         10, '2024-06-01T10:00:01.000000Z', '2024-06-01T10:00:01.000000Z', 'new')`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active,
         created_at, updated_at, import_batch_id) VALUES
        (100, '2024-06-01', vision_numeric('4.5', 18, 4), 'EUR', 'Coffee', 10, 1, 1,
         '${SEED_TIME}', '${SEED_TIME}', 1),
        (101, '2024-06-01', vision_numeric('-10', 18, 4), 'EUR', 'Bread', 11, 1, 1,
         '${SEED_TIME}', '${SEED_TIME}', 1),
        (102, '2024-05-20', vision_numeric('-3', 18, 4), 'EUR', 'Old bread', 11, 1, 1,
         '${SEED_TIME}', '${SEED_TIME}', NULL),
        (103, '2024-06-06', vision_numeric('5', 18, 4), 'EUR', 'Quarterly', 11, 1, 1,
         '${SEED_TIME}', '${SEED_TIME}', 6)`,
      `INSERT INTO planned_transactions (id, planned_date, amount, currency, memo, is_recurring) VALUES
        (7, '2024-06-06', vision_numeric('5', 18, 4), 'EUR', 'Quarterly', 0)`,
      `INSERT INTO planned_transaction_executions (planned_transaction_id, executed_transaction_id,
         execution_date, created_at) VALUES
        (7, 103, '2024-06-06', '${SEED_TIME}')`,
    ],
    steps: [
      batches(),
      batches("?limit=2&offset=1"),
      batches("?limit=abc&offset=-5"),
      batches("?limit=500"),
      batches("?limit=1&offset=999"),
      batchDelete("abc"),
      batchDelete("0"),
      batchDelete("1e3"),
      batchDelete("2.5"),
      batchDelete("999"),
      batchDelete("3"),
      batchDelete("2"),
      batchDelete("1"),
      batchDelete("1"),
      batchDelete("4"),
      batchDelete("6"),
      batches(),
    ],
  },
  importReview: {
    router: { module: "importRoutes.ts", mountPath: "/api/import" },
    seed: [
      `INSERT INTO categories (id, general, detail, path_name, name, legacy_compatible, is_active, created_at, updated_at) VALUES
        (3, 'FOOD', 'GROCERIES', 'FOOD:GROCERIES', 'Food: Groceries', 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'FOOD', 'RESTAURANTS', 'FOOD:RESTAURANTS', 'FOOD:RESTAURANTS', 1, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, is_active, created_at, updated_at) VALUES
        (10, 'GroceryA', 'grocerya', 3, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (11, 'RestoB', 'restob', 4, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipient_match_patterns (id, recipient_id, pattern, pattern_kind, priority, is_active, source, created_at, updated_at) VALUES
        (2, 10, 'GroceryA%', 'literal_prefix', 100, 1, 'user', '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO import_batches (id, adapter_name, source_filename, status, rows_total, rows_imported, started_at, completed_at) VALUES
        (20, 'KBC adapter', 'kbc.csv', 'awaiting_review', 5, 0, '2024-06-01T10:00:00.000000Z', NULL),
        (21, 'ING', 'ing.csv', 'complete', 1, 1, '2024-06-02T10:00:00.000000Z', '2024-06-02T10:00:03.000000Z')`,
      `INSERT INTO import_staging_rows (id, batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo, amount,
         currency, resolved_recipient_id, match_source, match_similarity, matched_pattern_id, dedup_fingerprint,
         dedup_fingerprint_version, created_at, updated_at, override_category_id, user_override_recipient_id) VALUES
        (1, 20, 0, 'matched', '2024-06-01', 'Main', 'GroceryA', 'Coffee', vision_numeric('4.5', 20, 4), 'EUR',
         10, 'exact', 1.0, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, '${SEED_TIME}', '${SEED_TIME}', NULL, NULL),
        (2, 20, 1, 'matched', '2024-06-01', 'Main', 'GroceryA market', 'Market', vision_numeric('-2.25', 20, 4), 'EUR',
         10, 'pattern', 0.85, 2, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}', NULL, NULL),
        (3, 20, 2, 'matched', '2024-06-02', 'Main', 'UnknownCafe', 'Lunch', vision_numeric('12', 20, 4), 'EUR',
         NULL, 'new', NULL, NULL, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}', NULL, NULL),
        (4, 20, 3, 'matched', '2024-06-03', 'Main', 'RestoB', 'Dinner', vision_numeric('58', 20, 4), 'EUR',
         11, 'fuzzy', 0.9, NULL, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, '${SEED_TIME}', '${SEED_TIME}', 4, NULL),
        (5, 20, 4, 'validated', '2024-06-04', 'Main', 'Later', NULL, vision_numeric('1', 20, 4), 'EUR',
         NULL, NULL, NULL, NULL, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}', NULL, NULL),
        (6, 21, 0, 'matched', '2024-06-02', 'Main', 'GroceryA', 'Old', vision_numeric('3', 20, 4), 'EUR',
         10, 'exact', 1.0, NULL, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}', NULL, NULL)`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active, created_at,
         updated_at, dedup_fingerprint, dedup_fingerprint_version) VALUES
        (200, '2024-05-01', vision_numeric('4.5', 18, 4), 'EUR', 'Coffee before', 10, NULL, 1,
         '${SEED_TIME}', '${SEED_TIME}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1),
        (201, '2024-05-02', vision_numeric('58', 18, 4), 'EUR', 'Dinner before', 11, NULL, 1,
         '${SEED_TIME}', '${SEED_TIME}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1)`,
    ],
    steps: [
      batchPreview("abc"),
      batchPreview("999"),
      batchPreview("20"),
      batchOverrideRecipient("20", "abc", { recipient_id: 11 }),
      batchOverrideRecipient("20", "1", { recipient_id: 11 }),
      batchPreview("20"),
      batchOverrideRecipient("20", "1", { recipient_id: null }),
      batchOverrideRecipient("20", "3", { recipient_id: 10 }),
      batchOverrideRecipient("20", "5", { recipient_id: 10 }),
      batchOverrideRecipient("20", "999", { recipient_id: 10 }),
      batchOverrideRecipient("999", "1", { recipient_id: 10 }),
      batchOverrideRecipient("21", "1", { recipient_id: 10 }),
      batchOverrideRecipient("20", "1", { recipient_id: "abc" }),
      batchOverrideRecipient("20", "1", { recipient_id: 0 }),
      batchOverrideRecipient("20", "1", { recipient_id: [] }),
      batchOverrideRecipient("20", "1", {}),
      batchOverrideRecipient("20", "1"),
      batchOverrideCategory("20", "4", { category_id: 3 }),
      batchOverrideCategory("20", "4", {}),
      batchOverrideCategory("20", "2", { category_id: 999 }),
      batchOverrideCategory("20", "2", { category_id: null }),
      batchOverrideCategory("21", "2", { category_id: 3 }),
      batchOverrideCategory("20", "abc", {}),
      batchOverrideCategory("20", "2", { category_id: "abc" }),
      batchPreview("20"),
    ],
  },
  importUploads: {
    router: { module: "importRoutes.ts", mountPath: "/api/import" },
    seed: [
      `INSERT INTO categories (id, general, detail, path_name, name, legacy_compatible, is_active, created_at, updated_at) VALUES
        (3, 'FOOD', 'GROCERIES', 'FOOD:GROCERIES', 'Food: Groceries', 0, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, is_active, created_at, updated_at) VALUES
        (10, 'DupCoffee', 'dupcoffee', 3, 1, '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      csvUploadStep("importCsv", "/api/import/csv", {
        filename: "",
        content: "",
        fields: { bank_name: "kbc" },
      }),
      csvUploadStep("importCsv", "/api/import/csv", {
        filename: "x.txt",
        contentType: "text/plain",
        content: "a;b\nc;d",
        fields: { bank_name: "kbc" },
      }),
      csvUploadStep("importCsv", "/api/import/csv", {
        filename: "kbc.csv",
        content: kbcLine(
          "01/06/2024",
          "-12,34",
          "100,00",
          "",
          "12,34",
          "DupCoffee",
        ),
        fields: { bank_name: "kbc" },
      }),
      csvUploadStep("importCsv", "/api/import/csv", {
        filename: "kbc-new.csv",
        content: kbcLine(
          "02/06/2024",
          "-5,00",
          "95,00",
          "",
          "5,00",
          "FreshNewPlace",
        ),
        fields: { bank_name: "kbc" },
      }),
      csvUploadStep("importCsv", "/api/import/csv", {
        filename: "kbc-nobank.csv",
        content: kbcLine(
          "03/06/2024",
          "-6,00",
          "89,00",
          "",
          "6,00",
          "FreshNoBankName",
        ),
      }),
      csvUploadStep("importCsvCustom", "/api/import/csv/custom", {
        filename: "custom.csv",
        content:
          "Date,Name,Amount,Memo\n2024-07-01,FreshCustom,10.50,Custom memo\n",
        fields: {
          bank_name: "MyBank",
          date_format: "%Y-%m-%d",
          date_column: "Date",
          recipient_column: "Name",
          amount_column: "Amount",
          memo_column: "Memo",
        },
      }),
      {
        operationId: "importCsvStream",
        method: "POST",
        path: "/api/import/csv/stream",
        multipart: {
          fields: { bank_name: "kbc" },
          files: [
            {
              name: "file",
              filename: "kbc-stream.csv",
              contentType: "text/csv",
              base64: Buffer.from(
                kbcLine(
                  "04/06/2024",
                  "-7,00",
                  "82,00",
                  "",
                  "7,00",
                  "FreshStream",
                ),
              ).toString("base64"),
            },
          ],
        },
      },
      csvUploadStep("importRecipients", "/api/import/recipients", {
        filename: "recipients.csv",
        content:
          "name,category\nImported One,FOOD:GROCERIES\nImported Two,\n,worthless row",
      }),
      csvUploadStep("importCategories", "/api/import/categories", {
        filename: "categories.csv",
        content: "category,description\nIMPORT:FIRST,first test description\n",
      }),
      csvUploadStep("importRecipients", "/api/import/recipients", {
        filename: "recipients-sep.csv",
        content: "name;category\nSemicolon Rcpt;IMPORT:FIRST\n",
        fields: { separator: ";" },
      }),
    ],
  },
  investments: {
    router: { module: "investments.ts", mountPath: "/api/investments" },
    seed: [
      `INSERT INTO investments (id, name, symbol, asset_class, currency, current_price, interest_rate,
         is_active, price_provider, notes, created_at, updated_at) VALUES
        (1, 'ACME Corp', 'ACME', 'stock', 'EUR', vision_numeric('150.50', 18, 6), NULL,
         1, 'manual', 'growth stock', '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'City Loft', NULL, 'real_estate', 'EUR', vision_numeric('250000', 18, 6), NULL,
         1, 'manual', NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'Old Fund', 'OLDF', 'etf', 'EUR', vision_numeric('42', 18, 6), NULL,
         0, 'manual', 'closed', '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, units, price_per_unit,
         fees, taxes, currency, note, created_at, updated_at) VALUES
        (1, 1, 'buy', '2024-01-10', vision_numeric('1000', 18, 4), vision_numeric('10', 18, 8),
         vision_numeric('100', 18, 6), vision_numeric('1.5', 18, 4), vision_numeric('0', 18, 4), 'EUR',
         'initial buy', '${SEED_TIME}', '${SEED_TIME}'),
        (2, 1, 'dividend', '2024-03-01', vision_numeric('12.25', 18, 4), NULL, NULL,
         vision_numeric('0', 18, 4), vision_numeric('0', 18, 4), 'EUR', NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 2, 'rent_income', '2024-02-01', vision_numeric('950.40', 18, 4), NULL, NULL,
         vision_numeric('0', 18, 4), vision_numeric('0', 18, 4), 'EUR', 'february rent',
         '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      {
        operationId: "getInvestments",
        method: "GET",
        path: "/api/investments",
      },
      {
        operationId: "getInvestment",
        method: "GET",
        path: "/api/investments/1",
      },
      {
        operationId: "getInvestment",
        method: "GET",
        path: "/api/investments/abc",
      },
      {
        operationId: "getInvestment",
        method: "GET",
        path: "/api/investments/999",
      },
      {
        operationId: "getInvestment",
        method: "GET",
        path: "/api/investments/3",
      },
      {
        operationId: "getInvestmentSummary",
        method: "GET",
        path: "/api/investments/1/summary",
      },
      {
        operationId: "getInvestmentSummary",
        method: "GET",
        path: "/api/investments/999/summary",
      },
      {
        operationId: "getInvestmentTransactions",
        method: "GET",
        path: "/api/investments/1/transactions",
      },
      {
        operationId: "getBulkPortfolioTransactions",
        method: "GET",
        path: "/api/investments/transactions",
      },
      {
        operationId: "getBulkPortfolioTransactions",
        method: "GET",
        path: "/api/investments/transactions?investment_ids=1,2&investment_ids=abc",
      },
      {
        operationId: "getBulkPortfolioTransactions",
        method: "GET",
        path: "/api/investments/transactions?investment_ids=1,2",
      },
      {
        operationId: "getPortfolioExposure",
        method: "GET",
        path: "/api/investments/exposure",
      },
      {
        operationId: "getPortfolioExposureClassifications",
        method: "GET",
        path: "/api/investments/exposure/classifications",
      },
      {
        operationId: "listInvestmentProviders",
        method: "GET",
        path: "/api/investments/providers",
      },
    ],
  },
  importCommit: {
    router: { module: "importRoutes.ts", mountPath: "/api/import" },
    seed: [
      `INSERT INTO accounts (id, name, currency, type, is_active, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'EUR', 'checking', 1, '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000001')`,
      `INSERT INTO categories (id, general, detail, path_name, name, legacy_compatible, is_active, created_at, updated_at) VALUES
        (3, 'FOOD', 'GROCERIES', 'FOOD:GROCERIES', 'Food: Groceries', 0, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, is_active, created_at, updated_at) VALUES
        (10, 'DupCoffee', 'dupcoffee', 3, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (11, 'Savery', 'savery', NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO import_batches (id, adapter_name, source_filename, status, rows_total, rows_imported, started_at, completed_at) VALUES
        (30, 'kbc', 'kbc.csv', 'awaiting_review', 5, 0, '2024-06-01T10:00:00.000000Z', NULL),
        (31, 'ing', 'ing.csv', 'matching', 1, 0, '2024-06-02T10:00:00.000000Z', NULL),
        (21, 'generic', 'old.csv', 'complete', 0, 0, '2024-06-03T10:00:00.000000Z', '2024-06-03T10:00:09.000000Z')`,
      `INSERT INTO import_staging_rows (id, batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo, amount,
         balance, comment, currency, resolved_recipient_id, user_override_recipient_id, match_source, matched_pattern_id,
         dedup_fingerprint, dedup_fingerprint_version, dedup_occurrence, source_record_hash, created_at, updated_at) VALUES
        (101, 30, 0, 'matched', '2024-06-01', 'Main', 'DupCoffee', ' Coffee ', vision_numeric('4.5', 20, 4),
         vision_numeric('100', 18, 4), 'first', 'EUR ', 10, NULL, 'exact', NULL,
         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, NULL, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
         '${SEED_TIME}', '${SEED_TIME}'),
        (102, 30, 1, 'matched', '2024-06-05', ' Savery', 'Savery', 'Rent', vision_numeric('58', 20, 4),
         vision_numeric('158', 18, 4), NULL, 'EUR', 11, NULL, 'fuzzy', NULL,
         'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1, NULL, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (103, 30, 2, 'matched', '2024-06-03', NULL, 'Nobody', 'No recipient', vision_numeric('0.5', 20, 4),
         NULL, NULL, 'EUR', NULL, NULL, 'new', NULL,
         'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 1, NULL, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (104, 30, 3, 'matched', '2024-06-10', NULL, 'DupCoffee', ' Market ', vision_numeric('-2.25', 20, 4),
         vision_numeric('97.75', 18, 4), NULL, 'EUR', 10, NULL, 'pattern', NULL,
         NULL, NULL, 1, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (105, 30, 4, 'matched', '2024-06-12', 'Main', 'DupCoffee', 'Fresh', vision_numeric('-7.5', 20, 4),
         vision_numeric('105.25', 18, 4), NULL, NULL, 10, NULL, 'new', NULL,
         NULL, NULL, NULL, NULL,
         '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active, created_at,
         updated_at, dedup_fingerprint, dedup_fingerprint_version) VALUES
        (200, '2024-05-01', vision_numeric('4.5', 18, 4), 'EUR', ' Coffee before', 10, 1, 1,
         '${SEED_TIME}', '${SEED_TIME}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1),
        (201, '2024-06-10', vision_numeric('-2.25', 18, 4), 'EUR', ' Market ', 10, NULL, 1,
         '${SEED_TIME}', '${SEED_TIME}', NULL, NULL)`,
      `INSERT INTO planned_transactions (id, planned_date, amount, currency, memo, recipient_id, is_recurring,
         is_executed, is_active, created_at, updated_at) VALUES
        (1, '2024-06-05', vision_numeric('58', 18, 4), 'EUR', 'Savery rent', 11, 0, 0, 1,
         '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      batchCommit("abc"),
      batchCommit("999"),
      batchCommit("21"),
      batchCommit("31"),
      batches(),
      batchCommit("30"),
      batchCommit("30"),
      batches(),
      batchPreview("30"),
    ],
  },
  categories: {
    router: { module: "categories.ts", mountPath: "/api/categories" },
    seed: [
      `INSERT INTO categories (id, general, detail, name, hierarchy_only, legacy_compatible, is_active, created_at,
         updated_at) VALUES
        (1, 'FOOD', '', 'FOOD', 1, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'TRANSPORT', '', 'TRANSPORT', 1, 0, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO categories (id, general, detail, description, is_active, created_at, updated_at) VALUES
        (3, 'FOOD', 'GROCERIES', 'Supermarkets', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'FOOD', 'RESTAURANTS', NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, 'TRANSPORT', 'FUEL', NULL, 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO categories (id, general, detail, name, parent_id, hierarchy_only, legacy_compatible, is_active,
         created_at, updated_at) VALUES
        (6, '__HIERARCHY_6', 'SNACKS', 'SNACKS', 3, 0, 0, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO categories (id, general, detail, is_active, created_at, updated_at) VALUES
        (7, 'HOUSING', 'RENT', 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `UPDATE categories SET created_at = '${SEED_TIME}', updated_at = '${SEED_TIME}'`,
      `INSERT INTO category_merge_aliases (general, detail, target_category_id, created_at) VALUES
        ('FOOD', 'TAKEAWAY', 4, '${SEED_TIME}')`,
      `INSERT INTO category_root_aliases (general, target_category_id, created_at) VALUES
        ('OLDTRANSPORT', 2, '${SEED_TIME}')`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, created_at, updated_at) VALUES
        (1, 'Shop', 'shop', 3, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transactions (id, date, amount, currency, recipient_id, category_id, is_active, created_at,
         updated_at) VALUES
        (1, '2024-01-05', vision_numeric('-12.5', 18, 4), 'EUR', 1, 4, 1, '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      categoryTree,
      categories(),
      categories("?active=false"),
      categories("?general=fo"),
      categories("?detail=GRO&general=food"),
      categories("?search=market"),
      categories("?search=rest&limit=1"),
      categories("?active=0&limit=2&offset=1"),
      categories("?general=&detail="),
      categoryCreate({ general: "food", detail: " groceries " }),
      categoryCreate({
        general: "Travel",
        detail: "Hotel",
        description: "Stays",
      }),
      categoryCreate({ general: "food", detail: "takeaway" }),
      categoryCreate({}),
      categoryCreate({ general: 5, detail: "x" }),
      categoryCreate({ general: "", detail: "x" }),
      categoryCreate({ general: "a", detail: "b", description: 7 }),
      categoryCreate([]),
      categoryCreate(),
      categoryCreate({ general: "Travel", detail: "Hotel", extra: 1 }),
      nodeCreate({ name: " dessert ", parentId: 3 }),
      nodeCreate({ name: "x", parentId: 5 }),
      nodeCreate({ name: "x", parentId: 999 }),
      nodeCreate({ name: "oldtransport" }),
      nodeCreate({ name: "food" }),
      nodeCreate({ name: "   " }),
      nodeCreate({ name: "a".repeat(101) }),
      nodeCreate({ name: "y", extra: 1 }),
      nodeCreate({ name: "z", parentId: 1.5 }),
      nodeCreate({ name: "z", parentId: null, description: null }),
      nodeCreate({ name: "zz", parentId: "3", description: "d".repeat(501) }),
      nodeCreate([]),
      nodeUpdate("6", { name: "treats" }),
      nodeUpdate("3", { parentId: 6 }),
      nodeUpdate("1", { is_active: false }),
      nodeUpdate("6", { is_active: false, description: "Sweet" }),
      nodeUpdate("999", {}),
      nodeUpdate("abc", {}),
      nodeUpdate("2", { name: "vehicles" }),
      nodeUpdate("4", { description: "Eating out", parentId: null }),
      nodeUpdate("3", { parentId: 5 }),
      nodeUpdate("3", { bogus: 1 }),
      nodeUpdate("3", { name: "" }),
      nodeUpdate("3", { name: "restaurants", parentId: 4 }),
      nodeMerge("6", { targetId: 3 }),
      nodeMerge("3", { targetId: 3 }),
      nodeMerge("1", { targetId: 3 }),
      nodeMerge("999", { targetId: 3 }),
      nodeMerge("4", { targetId: "3" }),
      nodeMerge("4", { targetId: 5 }),
      nodeMerge("4", { targetId: 3 }),
      nodeDelete("3"),
      nodeDelete("5"),
      nodeDelete("5"),
      nodeDelete("abc"),
      categoryTree,
      categories("?active=false"),
      categoryCreate({ general: "food", detail: "restaurants" }),
    ],
  },
  recipients: {
    router: { module: "recipients.ts", mountPath: "/api/recipients" },
    seed: [
      `INSERT INTO categories (id, general, detail, name, hierarchy_only, legacy_compatible, created_at,
         updated_at) VALUES (1, 'FOOD', '', 'FOOD', 1, 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO categories (id, general, detail, created_at, updated_at) VALUES
        (2, 'FOOD', 'GROCERIES', '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'LEISURE', 'COFFEE', '${SEED_TIME}', '${SEED_TIME}')`,
      `UPDATE categories SET created_at = '${SEED_TIME}', updated_at = '${SEED_TIME}'`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, notes, is_active, created_at,
         updated_at) VALUES
        (1, 'SHOP', 'SHOP', 2, 'corner shop', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'CAFÉ ÉCLAIR', 'CAFÉ ÉCLAIR', 3, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'MARKET', 'MARKET', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'TO DELETE', 'DELETE TO', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, 'ALBERT HEIJN 1234', '1234 ALBERT HEIJN', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (6, 'ALBERT HEIJN 5678', '5678 ALBERT HEIJN', NULL, 'branch', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (7, 'OLD', 'OLD', NULL, NULL, 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipient_bank_accounts (id, recipient_id, account_number, is_primary, created_at, updated_at)
        VALUES
        (1, 1, 'BE12 3456', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 1, 'BE99 0000', 0, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 3, 'NL01 ABCD', 0, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 2, 'FR76 1111', 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transactions (id, date, amount, currency, recipient_id, category_id, is_active, created_at,
         updated_at) VALUES
        (1, '2024-01-05', vision_numeric('-12.5', 18, 4), 'EUR', 1, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, '2024-01-06', vision_numeric('-3.2', 18, 4), 'EUR', 2, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, '2024-01-07', vision_numeric('-40', 18, 4), 'EUR', 3, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, '2024-01-08', vision_numeric('-9', 18, 4), 'EUR', 6, NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transaction_splits (id, transaction_id, recipient_id, amount, created_at, updated_at) VALUES
        (1, 3, 2, vision_numeric('10', 18, 4), '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO planned_transactions (id, planned_date, amount, currency, recipient_id, created_at, updated_at)
        VALUES (1, '2024-02-01', vision_numeric('-5', 18, 4), 'EUR', 3, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipient_match_patterns (id, recipient_id, pattern, pattern_kind, case_sensitive, priority,
         notes, created_at, updated_at) VALUES
        (1, 1, 'SHOP', 'literal_prefix', 0, 100, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 1, 'SH?P*', 'glob', 1, 10, 'glob', '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      recipients(),
      recipients("?active=false"),
      recipients("?name=sho"),
      recipients("?name=caf%C3%A9"),
      recipients("?search=groc"),
      recipients("?search=be12"),
      recipients("?search=%C3%A9clair"),
      recipients("?search=branch"),
      recipients("?uncategorized=true"),
      recipients("?default_category_id=1"),
      recipients("?default_category_id=abc"),
      recipients("?default_category_id="),
      recipients("?sort_by=default_category_name&sort_dir=desc"),
      recipients("?sort_by=primary_bank_account"),
      recipients("?sort_by=bogus&sort_dir=up"),
      recipients("?sort_by=constructor"),
      recipients("?sort_by=__proto__&sort_dir=desc"),
      recipients("?limit=2&offset=1"),
      recipients("?limit=0&offset=-4"),
      recipients("?name=a&name=b"),
      recipients("?search=a&search=b&default_category_id=x"),
      recipientRead("1"),
      recipientRead("999"),
      recipientRead("abc"),
      recipientCreate({ name: "  New  Shop " }),
      recipientCreate({ name: "shop" }),
      recipientCreate({ name: "system" }),
      recipientCreate({ name: "" }),
      recipientCreate({}),
      recipientCreate({ name: 5 }),
      recipientCreate({
        name: "Bakery",
        default_category_id: 3,
        notes: "fresh",
      }),
      recipientCreate({ name: "x", default_category_id: "abc" }),
      recipientCreate({ name: "y", default_category_id: null, notes: null }),
      recipientCreate({ name: "z", notes: 7, default_category_id: 0 }),
      recipientCreate([]),
      recipientCreate(),
      recipientUpdate("1", { name: "shop two", notes: null }),
      recipientUpdate("1", { is_active: null, name: null }),
      recipientUpdate("999", { notes: "x" }),
      recipientUpdate("3", { name: "System" }),
      recipientUpdate("3", { default_category_id: 0 }),
      recipientUpdate("3", {}),
      recipientUpdate("abc", {}),
      recipientUpdate("3", { is_active: "yes" }),
      recipientUpdate("7", { is_active: true, default_category_id: 2 }),
      recipientUpdate("3", { name: "shop two" }),
      recipientMerge("1", { alias_ids: [2, 3] }),
      recipientMerge("1", { alias_ids: [] }),
      recipientMerge("1", {}),
      recipientMerge("1", { alias_ids: "2" }),
      recipientMerge("1", { alias_ids: ["x", 2] }),
      recipientMerge("999", { alias_ids: [2] }),
      recipientMerge("2", { alias_ids: [4] }),
      recipientMerge("1", { alias_ids: [1] }),
      recipientMerge("5", { alias_ids: [6, 999] }),
      recipientMerge("abc", { alias_ids: [6] }),
      recipientRead("1"),
      recipientRead("2"),
      recipientUnmerge("2"),
      recipientUnmerge("999"),
      recipientUnmerge("abc"),
      recipientDelete("4"),
      recipientDelete("4"),
      recipientDelete("abc"),
      patternList("1"),
      patternList("999"),
      patternCreate("1", { pattern: "SHOP" }),
      patternCreate("1", {
        pattern: "SH*P",
        pattern_kind: "glob",
        case_sensitive: true,
        priority: 5,
        notes: "n",
      }),
      patternCreate("1", { pattern: "" }),
      patternCreate("1", { pattern: "   " }),
      patternCreate("1", {}),
      patternCreate("1", { pattern: 5 }),
      patternCreate("1", { pattern: "x", pattern_kind: "bogus" }),
      patternCreate("1", { pattern: "x", priority: 1.5 }),
      patternCreate("1", { pattern: "x", priority: 3000000000 }),
      patternCreate("1", { pattern: "x", priority: "1" }),
      patternCreate("1", {
        pattern: "nulls",
        pattern_kind: null,
        case_sensitive: null,
        priority: null,
        notes: null,
      }),
      patternCreate("1", { pattern: "a".repeat(501) }),
      patternCreate("1", { pattern: "x", case_sensitive: "yes" }),
      patternCreate("abc", { pattern: "x" }),
      patternCreate("1", { pattern: "^SH(OP|IP)\\b", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "(", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "[z-a]", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "(a+)+$", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "(x|y)*", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "[(a+)+]", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "a{2,1}", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "(?<n>a)\\k<m>", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "*", pattern_kind: "regex" }),
      patternCreate("1", { pattern: "\\", pattern_kind: "regex" }),
      patternPreview("1", { pattern: "SHOP" }),
      patternPreview("1", { pattern: "albert" }),
      patternPreview("1", { pattern: "albert", case_sensitive: true }),
      patternPreview("1", { pattern: "*HEIJN ????", pattern_kind: "glob" }),
      patternPreview("1", {
        pattern: "caf\u00e9",
        pattern_kind: "literal_prefix",
      }),
      patternPreview("1", { pattern: "" }),
      patternPreview("1", {
        pattern: "x",
        pattern_kind: null,
        case_sensitive: null,
      }),
      patternPreview("1", { pattern: "x", extra: 1 }),
      patternPreview("abc", { pattern: "x" }),
      patternPreview("1", { pattern: "\\d{4}$", pattern_kind: "regex" }),
      patternPreview("1", { pattern: "^caf", pattern_kind: "regex" }),
      patternPreview("1", {
        pattern: "^caf",
        pattern_kind: "regex",
        case_sensitive: true,
      }),
      patternPreview("1", { pattern: "(?=.*HEIJN)A", pattern_kind: "regex" }),
      patternPreview("1", { pattern: ")", pattern_kind: "regex" }),
      patternPreview("1", { pattern: "^É", pattern_kind: "regex" }),
      patternUpdate("1", "1", { priority: 7 }),
      patternUpdate("1", "2", { case_sensitive: false }),
      patternUpdate("1", "1", { pattern: "" }),
      patternUpdate("1", "999", { pattern: "x" }),
      patternUpdate("1", "999", { priority: 1 }),
      patternUpdate("1", "1", { is_active: false, notes: "off" }),
      patternUpdate("1", "1", { notes: null }),
      patternUpdate("1", "1", { pattern_kind: null }),
      patternUpdate("1", "1", { pattern_kind: "glob", pattern: "S*" }),
      patternUpdate("1", "1", {}),
      patternUpdate("1", "4", { pattern_kind: "regex" }),
      patternUpdate("1", "4", { pattern_kind: "regex", pattern: "SH*P(" }),
      patternUpdate("1", "3", { pattern: "(b+)*", pattern_kind: "regex" }),
      patternUpdate("1", "3", {
        pattern: "^SHOP\\s",
        pattern_kind: "regex",
        case_sensitive: true,
      }),
      patternUpdate("1", "abc", {}),
      patternUpdate("abc", "1", {}),
      patternDelete("1", "2"),
      patternDelete("1", "999"),
      patternDelete("1", "abc"),
      patternList("1"),
      recipients("?active=false&limit=1000"),
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
  info: {
    router: { module: "info.ts", mountPath: "/api/info" },
    // /recurring-patterns is today-dependent (`sub_interval(today(), '3 years')`), so the
    // area records on the fixed clock and its transactions sit well inside the window.
    now: "2026-06-15T09:00:00.000Z",
    seed: [
      `INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'EUR', 'checking', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000001'),
        (2, 'Travel', 'USD', 'savings', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000002'),
        (3, 'Dormant', 'EUR', 'checking', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000003')`,
      `INSERT INTO categories (id, general, detail, name, path_name, legacy_compatible, created_at, updated_at) VALUES
        (21, 'SPORT', 'FITNESS', 'FITNESS', 'SPORT > FITNESS', 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, primary_recipient_id, is_active, created_at, updated_at) VALUES
        (1, 'GYMFIT', 'GYMFIT', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'SALARY CO', 'CO SALARY', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'CITY GYM', 'CITY GYM', 21, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'CITY GYM NORTH', 'CITY GYM NORTH', NULL, 3, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, 'TENANT', 'TENANT', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (6, 'ONCE SHOP', 'ONCE SHOP', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (7, 'NOISY SHOP', 'NOISY SHOP', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (8, 'PRICE UP', 'PRICE UP', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active, created_at, updated_at) VALUES
        (101, '2024-02-01', vision_numeric('-29.5', 18, 4), 'EUR', 'GYM', 1, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (102, '2024-02-08', vision_numeric('-29.5', 18, 4), 'EUR', 'GYM', 1, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (103, '2024-02-15', vision_numeric('-29.5', 18, 4), 'EUR', 'GYM', 1, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (104, '2024-02-22', vision_numeric('-29.5', 18, 4), 'EUR', 'GYM', 1, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (105, '2024-02-01', vision_numeric('2500', 18, 4), 'EUR', 'SALARY', 2, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (106, '2024-03-01', vision_numeric('2500', 18, 4), 'EUR', 'SALARY', 2, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (107, '2024-04-01', vision_numeric('2500', 18, 4), 'EUR', 'SALARY', 2, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (108, '2024-05-01', vision_numeric('2500', 18, 4), 'EUR', 'SALARY', 2, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (109, '2024-06-01', vision_numeric('-5', 18, 4), 'EUR', 'REFUND', 2, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (110, '2024-01-10', vision_numeric('-15', 18, 4), 'EUR', 'GYM CITY', 4, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (111, '2024-02-10', vision_numeric('-15', 18, 4), 'EUR', 'GYM CITY', 4, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (112, '2024-03-10', vision_numeric('-15', 18, 4), 'EUR', 'GYM CITY', 4, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (113, '2024-04-10', vision_numeric('-15', 18, 4), 'EUR', 'GYM CITY', 4, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (114, '2024-02-10', vision_numeric('-100', 18, 4), 'EUR', 'RENT', 5, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (115, '2024-02-20', vision_numeric('-100', 18, 4), 'EUR', 'RENT', 5, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (116, '2024-03-02', vision_numeric('-100', 18, 4), 'EUR', 'RENT', 5, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (117, '2024-03-12', vision_numeric('-100', 18, 4), 'USD', 'RENT', 5, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (118, '2024-03-12', vision_numeric('-100', 18, 4), 'USD', 'RENT INACTIVE', 5, 2, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (119, '2024-02-01', vision_numeric('-19.9', 18, 4), 'EUR', 'ONLY ONE', 6, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (120, '2024-03-01', vision_numeric('-19.9', 18, 4), 'EUR', 'ONLY ONE MORE', 6, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (121, '2024-02-01', vision_numeric('-3', 18, 4), 'EUR', 'NOISE', 7, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (122, '2024-02-06', vision_numeric('-3', 18, 4), 'EUR', 'NOISE', 7, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (123, '2024-03-08', vision_numeric('-3', 18, 4), 'EUR', 'NOISE', 7, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (124, '2024-05-07', vision_numeric('-3', 18, 4), 'EUR', 'NOISE', 7, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (125, '2024-06-08', vision_numeric('-3', 18, 4), 'EUR', 'NOISE', 7, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (126, '2024-02-15', vision_numeric('-10', 18, 4), 'EUR', 'PLAN', 8, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (127, '2024-03-15', vision_numeric('-10', 18, 4), 'EUR', 'PLAN', 8, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (128, '2024-04-15', vision_numeric('-10', 18, 4), 'EUR', 'PLAN', 8, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (129, '2024-05-15', vision_numeric('-12', 18, 4), 'EUR', 'PLAN RAISED', 8, 1, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO planned_transactions (id, planned_date, amount, currency, memo, comment, url,
         account_id, recipient_id, category_id, is_recurring, recurrence_pattern, recurrence_end_date,
         max_occurrences, is_loan, loan_type, loan_principal, loan_annual_interest_rate, loan_term_months,
         loan_start_date, loan_payment_day, is_executed, is_active, created_at, updated_at) VALUES
        (1, '2026-06-01', vision_numeric('2500', 18, 4), 'EUR', 'SALARY', NULL, NULL, 1, 2, NULL,
         1, 'monthly', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, '2026-06-08', vision_numeric('-29.5', 18, 4), 'EUR', 'GYM INACTIVE', NULL, NULL, 1, 1, NULL,
         1, 'weekly', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      {
        operationId: "getSupportedAdapters",
        method: "GET",
        path: "/api/info/supported-adapters",
      },
      { operationId: "getInfoBanks", method: "GET", path: "/api/info/banks" },
      {
        operationId: "getRecurringPatterns",
        method: "GET",
        path: "/api/info/recurring-patterns",
      },
    ],
  },

  attachments: {
    router: { module: "attachments.ts", mountPath: "/api/attachments" },
    // The whole area records on the fixed clock: the list after the last upload is
    // `ORDER BY created_at DESC` with no tiebreak, and the replay's one frozen
    // `now()` must meet the ordering the TypeScript recorder saw, not the sub-second
    // progression of a wall-clock run.
    now: "2026-06-15T09:00:00.000Z",
    // The upload steps answer 201 with `created_at`/`stored_path` the run wrote, and
    // write the file bytes under the throwaway ATTACHMENTS_DIR; the later list and
    // download steps read both back.
    seed: [
      `INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'EUR', 'checking', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000001')`,
      `INSERT INTO recipients (id, name, normalized_name, is_active, created_at, updated_at) VALUES
        (1, 'SHOP', 'SHOP', 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active,
         created_at, updated_at) VALUES
        (1, '2024-01-05', vision_numeric('-12.5', 18, 4), 'EUR', 'CARD 1234', 1, 1, 1,
         '${SEED_TIME}', '${SEED_TIME}')`,
      // ids leave the sequence room: a default upload insert takes nextval() (vision_sequences
      // counts default inserts only), so ids 101+ never shadow a created row (seed traps).
      `INSERT INTO attachments (id, transaction_id, filename, stored_path, mime_type, size_bytes, created_at) VALUES
        (101, 1, 'receipt.png', '1/aaaaaaaa-0000-4000-8000-000000000001.png', 'image/png', 1024,
         '2025-03-01T09:00:00.000000Z'),
        (102, 1, 'invoice.pdf', '1/bbbbbbbb-0000-4000-8000-000000000002.pdf', 'application/pdf', 2048,
         '2025-03-02T09:00:00.000000Z'),
        (103, 1, 'scan.png', '1/cccccccc-0000-4000-8000-000000000003.png', 'image/png', 512,
         '2025-03-03T09:00:00.000000Z')`,
    ],
    steps: [
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/1",
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/1?limit=1&offset=1",
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/1?limit=0",
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/1?limit=a",
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/999",
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/abc",
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/0",
      },
      {
        operationId: "downloadAttachment",
        method: "GET",
        path: "/api/attachments/999/download",
      },
      {
        operationId: "downloadAttachment",
        method: "GET",
        path: "/api/attachments/abc/download",
      },
      {
        operationId: "deleteAttachment",
        method: "DELETE",
        path: "/api/attachments/101",
      },
      {
        operationId: "deleteAttachment",
        method: "DELETE",
        path: "/api/attachments/999",
      },
      {
        operationId: "deleteAttachment",
        method: "DELETE",
        path: "/api/attachments/abc",
      },
      // ── uploadAttachment: the hand-written multipart POST ──
      upload("/api/attachments/transaction/1", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03],
        "receipt.png",
        "image/png",
      ]),
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/1",
      },
      {
        operationId: "downloadAttachment",
        method: "GET",
        path: "/api/attachments/1/download",
      },
      upload("/api/attachments/transaction/1", [
        [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
        "photo.JPG",
        "image/jpeg",
      ]),
      upload("/api/attachments/transaction/1", [
        textBytes("%PDF-1.4\nVision"),
        "doc.pdf",
        "application/pdf",
      ]),
      upload("/api/attachments/transaction/1", [
        textBytes("GIF89aVision"),
        "anim.gif",
        "image/gif",
      ]),
      upload("/api/attachments/transaction/1", [
        [
          ...textBytes("RIFF"),
          0x24,
          0x00,
          0x00,
          0x00,
          ...textBytes("WEBPVP8 "),
        ],
        "shot.webp",
        "image/webp",
      ]),
      // content sniff fails: text bytes named as a PNG
      upload("/api/attachments/transaction/1", [
        textBytes("just some plain text"),
        "fake.png",
        "image/png",
      ]),
      // a valid PNG stored under an unsupported extension
      upload("/api/attachments/transaction/1", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "evil.exe",
        "image/png",
      ]),
      // a valid PNG named .pdf: extension does not match the sniffed content
      upload("/api/attachments/transaction/1", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "pretend.pdf",
        "image/png",
      ]),
      // no extension: allowed, nothing misleading is stored
      upload("/api/attachments/transaction/1", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "noextension",
        "image/png",
      ]),
      // the file part's Content-Type is not an image or a PDF: multer's fileFilter
      upload("/api/attachments/transaction/1", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "data.txt",
        "text/plain",
      ]),
      // a text field instead of a file part
      {
        operationId: "uploadAttachment",
        method: "POST",
        path: "/api/attachments/transaction/1",
        multipart: {
          fields: { note: "no file here" },
          files: [],
        },
      },
      // no multipart at all: the JSON body parser runs, multer finds no buffer
      {
        operationId: "uploadAttachment",
        method: "POST",
        path: "/api/attachments/transaction/1",
        body: { filename: "x.png" },
      },
      // a bad :id is rejected before multer buffers the upload
      upload("/api/attachments/transaction/abc", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "bad.png",
        "image/png",
      ]),
      upload("/api/attachments/transaction/0", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "zero.png",
        "image/png",
      ]),
      // the transaction must exist (checked after the content checks)
      upload("/api/attachments/transaction/999", [
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "orphan.png",
        "image/png",
      ]),
      // an extra text field rides along and is ignored
      {
        operationId: "uploadAttachment",
        method: "POST",
        path: "/api/attachments/transaction/1",
        multipart: {
          fields: { caption: "monthly receipt" },
          files: [
            filePart([0xff, 0xd8, 0xff, 0xff], "tagged.jpg", "image/jpeg"),
          ],
        },
      },
      {
        operationId: "getTransactionAttachments",
        method: "GET",
        path: "/api/attachments/transaction/1",
      },
      {
        operationId: "deleteAttachment",
        method: "DELETE",
        path: "/api/attachments/1",
      },
      {
        operationId: "deleteAttachment",
        method: "DELETE",
        path: "/api/attachments/1",
      },
    ],
  },

  transactions: {
    router: { module: "transactions.ts", mountPath: "/api/transactions" },
    // The write steps' created/updated timestamps and the dedup/auto-link
    // chain must record on the same clock every run.
    now: "2026-06-15T09:00:00.000Z",
    seed: [
      `INSERT INTO categories (id, general, detail, name, hierarchy_only, legacy_compatible, created_at,
         updated_at) VALUES (1, 'FOOD', '', 'FOOD', 1, 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO categories (id, general, detail, created_at, updated_at) VALUES
        (2, 'FOOD', 'GROCERIES', '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'LEISURE', 'COFFEE', '${SEED_TIME}', '${SEED_TIME}'),
        (10, 'TRAVEL', 'HOTEL', '${SEED_TIME}', '${SEED_TIME}')`,
      `UPDATE categories SET created_at = '${SEED_TIME}', updated_at = '${SEED_TIME}'`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, primary_recipient_id, is_active,
         created_at, updated_at) VALUES
        (1, 'SHOP', 'SHOP', 2, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'CAFÉ ÉCLAIR', 'CAFÉ ÉCLAIR', 3, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'MARKET', 'MARKET', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'MARKET NORTH', 'MARKET NORTH', NULL, 3, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, 'SHOP 2', '2 SHOP', NULL, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (6, 'CAFÉ BIS', 'BIS CAFÉ', 10, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (7, '', '', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'EUR', 'checking', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000001'),
        (2, 'Travel', 'USD', 'savings', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000002')`,
      `INSERT INTO tags (id, slug, color, is_active, created_at, updated_at) VALUES
        (1, 'holiday', '#00aaff', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'work', NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'old', '#999999', 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
        ${RATE_ROW("USD", "0.9", "2025-01-02", 1)},
        ${RATE_ROW("USD", "0.95", "2024-12-31", 0)},
        ${RATE_ROW("GBP", "1.15", "2025-01-02", 1)},
        ${RATE_ROW("JPY", "0", "2025-01-02", 1)}`,
      `INSERT INTO transactions (id, date, amount, currency, balance, memo, comment, recipient_id, category_id,
         account_id, is_active, bank_sequence, is_transfer, transfer_peer_id, transfer_source, created_at,
         updated_at) VALUES
        (1, '2024-01-05', vision_numeric('-12.5', 18, 4), 'EUR', NULL, 'CARD 1234', NULL, 1, NULL, 1, 1, NULL, 0,
         NULL, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (2, '2024-01-06', vision_numeric('-3.2', 18, 4), 'EUR', vision_numeric('500', 18, 4), NULL, 'latte', 2,
         NULL, 1, 1, NULL, 0, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (3, '2024-01-06', vision_numeric('-40', 18, 4), 'EUR', NULL, 'WEEKLY', NULL, 3, NULL, 1, 1,
         vision_numeric('3', 18, 0), 0, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (4, '2024-01-07', vision_numeric('2500', 18, 4), 'EUR', NULL, 'SALARY', NULL, 4, 10, 1, 1, NULL, 0, NULL,
         NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (5, '2024-02-01', vision_numeric('-9.99', 18, 4), 'EUR', NULL, NULL, NULL, 5, NULL, 1, 1, NULL, 0, NULL,
         NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (6, '2024-02-02', vision_numeric('-4.5', 18, 4), 'EUR', NULL, NULL, 'bis', 6, NULL, 1, 1, NULL, 0, NULL,
         NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (7, '2024-03-01', vision_numeric('250.5', 18, 4), 'USD', vision_numeric('1250.5', 18, 4), 'TOP UP', NULL, 3,
         NULL, 2, 1, NULL, 0, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (8, '2024-03-02', vision_numeric('-75', 18, 4), 'GBP', NULL, 'HOTEL', NULL, 7, 10, 2, 1, NULL, 0, NULL, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (9, '2024-03-03', vision_numeric('-1000', 18, 4), 'JPY', NULL, NULL, NULL, 3, NULL, 2, 1, NULL, 0, NULL, NULL,
         '${SEED_TIME}', '${SEED_TIME}'),
        (10, '2024-03-04', vision_numeric('-12', 18, 4), 'CHF', NULL, NULL, NULL, 3, NULL, 2, 1, NULL, 0, NULL, NULL,
         NULL, '${SEED_TIME}'),
        (11, '2024-03-05', vision_numeric('-100', 18, 4), 'EUR', NULL, 'TO SAVINGS', NULL, 3, NULL, 1, 1, NULL, 1,
         12, 'manual', '${SEED_TIME}', '${SEED_TIME}'),
        (12, '2024-03-05', vision_numeric('100', 18, 4), 'EUR', NULL, 'FROM MAIN', NULL, 3, NULL, 2, 1, NULL, 1, 11,
         'manual', '${SEED_TIME}', '${SEED_TIME}'),
        (13, '2024-03-06', vision_numeric('-7.25', 18, 4), 'EUR', NULL, 'OLD ROW', NULL, 1, 3, 1, 0, NULL, 0, NULL,
         NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (14, '2024-01-06', vision_numeric('1.005', 18, 4), 'EUR', NULL, NULL, NULL, 3, NULL, 1, 1,
         vision_numeric('1', 18, 0), 0, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}'),
        (15, '2024-04-01', vision_numeric('-20', 18, 4), 'EUR', NULL, NULL, NULL, 3, NULL, NULL, 1, NULL, 0, NULL,
         NULL, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (1, 1), (1, 2), (3, 3), (5, 2), (8, 1)`,
      // A closed account for the PATCH ledger guard, and planned rows for the
      // delete guard and the create auto-link. No transfer pairs are created
      // during the write steps: the transfer reconcile timer would fire
      // mid-recording.
      `INSERT INTO accounts (id, name, currency, type, is_active, created_at, updated_at, import_identity) VALUES
        (3, 'Closed', 'EUR', 'checking', 0, '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000003')`,
      `INSERT INTO planned_transactions (id, planned_date, amount, currency, memo, account_id, recipient_id,
         is_executed, is_active, created_at, updated_at) VALUES
        (1, '2024-01-14', vision_numeric('-15.5', 18, 4), 'EUR', 'AUTO PLAN', 1, 1, 0, 1,
         '${SEED_TIME}', '${SEED_TIME}'),
        (2, '2024-01-06', vision_numeric('-40', 18, 4), 'EUR', 'LINKED', 1, 3, 0, 1,
         '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO planned_transaction_executions (id, planned_transaction_id, executed_transaction_id,
         execution_date, created_at) VALUES
        (1, 2, 3, '2024-01-06', '${SEED_TIME}')`,
    ],
    steps: [
      transactions(),
      transactions("?limit=3&offset=2"),
      transactions("?limit=0&offset=-1"),
      transactions("?limit=99999"),
      transactions("?active=false"),
      transactions("?start_date=2024-01-06&end_date=2024-02-01"),
      transactions("?start_date=2024-13-01"),
      transactions("?start_date=2024/01/01"),
      transactions("?start_date=2024-02-30&end_date=2024-01-00"),
      transactions("?start_date=a&start_date=b"),
      transactions("?account_id=2"),
      transactions("?account_id=abc"),
      transactions("?account_id="),
      transactions("?account_id=1&account_id=2"),
      transactions("?bank_account=trav"),
      transactions("?bank_account=a&bank_account=b"),
      transactions("?category_id=1"),
      transactions("?category_id=3"),
      transactions("?category_id=10"),
      transactions("?category_ids=2,3"),
      transactions("?category_ids=2,x"),
      transactions("?category_ids="),
      transactions("?category_ids=5,"),
      transactions("?category_ids=2&category_ids=10"),
      transactions("?recipient_id=3"),
      transactions("?recipient_group_id=4"),
      transactions("?recipient_group_id=6"),
      transactions("?recipient_name=caf%C3%A9"),
      transactions("?recipient_name=shop"),
      transactions("?search=groc"),
      transactions("?search=12.5"),
      transactions("?search=2024-03"),
      transactions("?search=holi"),
      transactions("?search=%C3%A9clair"),
      transactions("?search=trav"),
      transactions("?search=gbp"),
      transactions("?search=a"),
      transactions("?search=%20%20x%20"),
      transactions("?sort_by=amount&sort_dir=asc"),
      transactions("?sort_by=recipient"),
      transactions("?sort_by=category&sort_dir=desc"),
      transactions("?sort_by=bank&sort_dir=asc"),
      transactions("?sort_by=constructor"),
      transactions("?sort_by=currency&sort_dir=up"),
      transactions("?sort_by=memo&sort_dir=asc"),
      transactions("?include_balance=true"),
      transactions("?include_balance=true&account_id=1&sort_by=amount"),
      transactions("?include_balance=1&limit=2&offset=1"),
      transactions("?transaction_type=income"),
      transactions("?transaction_type=expense"),
      transactions("?transaction_type=x"),
      transactions("?amount_min=10&amount_max=50"),
      transactions("?amount_min=-50&amount_signed=true"),
      transactions("?amount_exact=12.5"),
      transactions("?amount_exact=-12.5&amount_signed=true"),
      transactions("?amount_min=abc"),
      transactions("?amount_max=1e2"),
      transactions("?tags=holiday"),
      transactions("?tags=HOLIDAY,%20work"),
      transactions("?tags=old"),
      transactions("?tags=,"),
      transactions("?uncategorised=true"),
      transactions("?uncategorised=true&include_balance=true"),
      transactions("?uncategorised=true&category_id=2"),
      transactions("?uncategorised=true&limit=1&offset=99"),
      transactions("?uncategorised=true&active=false&sort_by=amount"),
      transactions("?normalize_to_eur=true"),
      transactions("?normalize_to_eur=true&target_currency=usd"),
      transactions("?normalize_to_eur=true&target_currency=GBP"),
      transactions("?normalize_to_eur=true&target_currency=XYZ"),
      transactions(
        "?normalize_to_eur=true&target_currency=a&target_currency=b",
      ),
      transactions("?normalize_to_eur=true&uncategorised=true"),
      transactions("?transaction_id=3"),
      transactions("?transaction_id=0"),
      transactions("?transaction_id=1.5"),
      transactions(
        "?transaction_id=x&start_date=bad&sort_by=a&sort_by=b&category_ids=y",
      ),
      transactionRead("1"),
      transactionRead("6"),
      transactionRead("13"),
      transactionRead("999"),
      transactionRead("abc"),
      transactionRead("0"),
      transactionRead("2147483648"),
      // --- The write port (create/update/delete), recorded against the same seed ---
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          transaction_date: "2024-01-10",
          amount: -15.5,
          account_id: 1,
          recipient_id: 1,
          memo: "manual one",
          currency: "EUR",
        },
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          transaction_date: "2024-01-10",
          amount: -15.5,
          account_id: 1,
          recipient_id: 1,
          memo: "manual one",
          currency: "EUR",
        },
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          transaction_date: "2024-01-10",
          amount: -15.5,
          account_id: 1,
          recipient_id: 1,
          memo: "manual one",
          currency: "EUR",
          allow_duplicate: true,
        },
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: { memo: "no fields" },
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          transaction_date: "2024-01-10",
          amount: 0,
          account_id: 1,
          recipient_id: 1,
          currency: "EUR",
        },
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          transaction_date: "2024-01-10",
          amount: -5,
          account_id: 1,
          recipient_id: "1e3",
          currency: "EUR",
        },
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          date: "2024-01-11",
          amount: "-7.251",
          account_id: 2,
          recipient_id: 3,
          memo: "tagged create",
          currency: "usd",
          category_id: 10,
          tags: ["work", "holiday"],
        },
      },
      {
        operationId: "updateTransaction",
        method: "PATCH",
        path: "/api/transactions/1",
        body: { memo: "edited card" },
      },
      {
        operationId: "updateTransaction",
        method: "PATCH",
        path: "/api/transactions/15",
        body: { recipient_name: "market", recipient_id: null },
      },
      {
        operationId: "updateTransaction",
        method: "PATCH",
        path: "/api/transactions/1",
        body: { account_id: 3 },
      },
      {
        operationId: "updateTransaction",
        method: "PATCH",
        path: "/api/transactions/1",
        body: { transaction_date: "" },
      },
      {
        operationId: "updateTransaction",
        method: "PATCH",
        path: "/api/transactions/1",
        body: { amount: "abc" },
      },
      {
        operationId: "updateTransaction",
        method: "PATCH",
        path: "/api/transactions/999",
        body: { memo: "missing" },
      },
      {
        operationId: "deleteTransaction",
        method: "DELETE",
        path: "/api/transactions/5",
      },
      {
        operationId: "deleteTransaction",
        method: "DELETE",
        path: "/api/transactions/3",
      },
      {
        operationId: "deleteTransaction",
        method: "DELETE",
        path: "/api/transactions/999",
      },
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          transaction_date: "2024-01-15",
          amount: -15.5,
          account_id: 1,
          recipient_id: 1,
          memo: "autolink",
          currency: "EUR",
        },
      },
      transactionRead("16"),
      {
        operationId: "createTransaction",
        method: "POST",
        path: "/api/transactions",
        body: {
          date: "2024-01-16",
          amount: -3,
          account_id: 1,
          recipient_id: 2,
        },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1, bId: 7 },
      },
      transactionRead("1"),
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1, bId: 2 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1, bId: 1 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: "x", bId: 2 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1.5, bId: 2 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1, bId: 999 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1, bId: 13 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 1, bId: 6 },
      },
      {
        operationId: "markTransfer",
        method: "POST",
        path: "/api/transactions/transfers",
        body: { aId: 4, bId: 7 },
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: {
          transaction_ids: [1, 3],
          add_slugs: ["work"],
          remove_slugs: ["holiday"],
        },
      },
      transactionRead("1"),
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: { transaction_ids: [2], add_slugs: ["old"] },
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: { transaction_ids: [2], remove_slugs: ["old"] },
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: { transaction_ids: [1] },
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: { transaction_ids: [] },
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: {},
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: { transaction_ids: ["x"], add_slugs: ["work"] },
      },
      {
        operationId: "bulkTagTransactions",
        method: "POST",
        path: "/api/transactions/bulk-tag",
        body: {
          transaction_ids: [1, 2],
          add_slugs: ["work"],
          remove_slugs: ["nope"],
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2, 3], fields: { category_id: 10 } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { category_id: null } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { recipient_id: 3 } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: {} },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { category_id: 0 } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { category_id: 999 } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { recipient_id: 999 } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {},
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [1], fields: { category_id: 10 }, expected_count: 2 },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { account_id: 2 },
          expected_count: 5001,
          fields: { category_id: 10 },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { account_id: 2 },
          expected_count: 4,
          fields: { category_id: 10 },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { category_id: "x" },
          expected_count: 1,
          fields: { category_id: 10 },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { foo: 1 },
          expected_count: 1,
          fields: { category_id: 10 },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { transactionId: 1, transaction_id: 1 },
          expected_count: 1,
          fields: { category_id: 10 },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { search: "no such thing" },
          expected_count: 1,
          fields: { category_id: 10 },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: {
          filter: { uncategorised: true },
          expected_count: 1,
          fields: { is_active: true },
        },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { recipient_id: 1.5 } },
      },
      {
        operationId: "bulkUpdateTransactions",
        method: "POST",
        path: "/api/transactions/bulk-update",
        body: { ids: [2], fields: { is_active: "yes" } },
      },
      {
        operationId: "bulkDeleteTransactions",
        method: "POST",
        path: "/api/transactions/bulk-delete",
        body: { ids: [15] },
      },
      {
        operationId: "bulkDeleteTransactions",
        method: "POST",
        path: "/api/transactions/bulk-delete",
        body: { ids: [3] },
      },
      {
        operationId: "bulkDeleteTransactions",
        method: "POST",
        path: "/api/transactions/bulk-delete",
        body: { ids: [999] },
      },
      {
        operationId: "bulkDeleteTransactions",
        method: "POST",
        path: "/api/transactions/bulk-delete",
        body: { filter: { transaction_id: 999 } },
      },
      {
        operationId: "bulkDeleteTransactions",
        method: "POST",
        path: "/api/transactions/bulk-delete",
        body: { filter: { transaction_id: 999 }, expected_count: 1 },
      },
      {
        operationId: "bulkDeleteTransactions",
        method: "POST",
        path: "/api/transactions/bulk-delete",
        body: {},
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv",
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv?include_balance=true",
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv?account_id=1",
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv?start_date=2024-02-01&end_date=2024-03-01",
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv?account_ids=1,2",
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv?search=nope",
      },
      {
        operationId: "exportTransactionsCsv",
        method: "GET",
        path: "/api/transactions/export/csv?start_date=bad",
      },
      {
        operationId: "exportTransactionsJson",
        method: "GET",
        path: "/api/transactions/export/json",
      },
      {
        operationId: "exportTransactionsJson",
        method: "GET",
        path: "/api/transactions/export/json?recipient_id=999",
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: { ids: [1, 3], format: "csv" },
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: { ids: [2], format: "json" },
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: { ids: [1] },
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: { filter: { account_id: 1 }, expected_count: 20, format: "json" },
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: { ids: [999] },
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: { ids: [1], format: "zip" },
      },
      {
        operationId: "bulkExportTransactions",
        method: "POST",
        path: "/api/transactions/bulk-export",
        body: {},
      },
      transactions("?sort_by=date"),
    ],
  },

  planned: {
    router: {
      module: "plannedTransactions.ts",
      mountPath: "/api/planned-transactions",
    },
    // The area records under a fixed clock (see `now`): totals, suggestions and the
    // execute default date all depend on today, so a corpus recorded one day must not
    // fail the next.
    now: "2026-06-15T09:00:00.000Z",
    seed: [
      `INSERT INTO categories (id, general, detail, name, hierarchy_only, legacy_compatible, is_active,
         created_at, updated_at) VALUES
        (10, 'FOOD', '', 'FOOD', 1, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (11, 'FOOD', 'GROCERIES', 'FOOD > GROCERIES', 0, 0, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO recipients (id, name, normalized_name, default_category_id, primary_recipient_id,
         is_active, created_at, updated_at) VALUES
        (1, 'SHOP', 'SHOP', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'SHOP SOUTH', 'SHOP SOUTH', NULL, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'MARKET', 'MARKET', 10, NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, 'RENT CO', 'RENT CO', NULL, NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES
        (1, 'Main', 'EUR', 'checking', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000001'),
        (2, 'Travel', 'USD', 'savings', '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-000000000002')`,
      `INSERT INTO tags (id, slug, color, is_active, created_at, updated_at) VALUES
        (1, 'holiday', '#00aaff', 1, '${SEED_TIME}', '${SEED_TIME}'),
        (2, 'work', NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, 'old', '#999999', 0, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
        ${RATE_ROW("USD", "0.9", "2026-06-01", 1)},
        ${RATE_ROW("GBP", "1.15", "2026-06-01", 1)},
        ${RATE_ROW("JPY", "0", "2026-06-01", 1)}`,
      `INSERT INTO transactions (id, date, amount, currency, memo, recipient_id, account_id, is_active,
         created_at, updated_at) VALUES
        (101, '2026-06-10', vision_numeric('-12.5', 18, 4), 'EUR', 'CARD 1234', 1, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (102, '2026-06-14', vision_numeric('-12.6', 18, 4), 'EUR', 'SHOP SOUTH', 2, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (103, '2026-06-13', vision_numeric('-75', 18, 4), 'EUR', 'RENT', 4, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (104, '2026-05-20', vision_numeric('-100', 18, 4), 'USD', 'HOTEL', 3, 2, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (105, '2026-06-13', vision_numeric('-12.5', 18, 4), 'EUR', 'INACTIVE', 1, 1, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (106, '2026-06-01', vision_numeric('-2500', 18, 4), 'EUR', 'SALARY', 3, 1, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO planned_transactions (id, planned_date, amount, currency, memo, comment, url,
         account_id, recipient_id, category_id, is_recurring, recurrence_pattern, recurrence_end_date,
         max_occurrences, is_loan, loan_type, loan_principal, loan_annual_interest_rate, loan_term_months,
         loan_start_date, loan_payment_day, is_executed, is_active, created_at, updated_at) VALUES
        (1, '2026-06-12', vision_numeric('-12.5', 18, 4), 'EUR', 'SHOP', 'monthly shop', NULL, 1, 1, 11,
         0, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (3, '2026-05-31', vision_numeric('-35', 18, 4), 'EUR', 'MARKET', NULL, NULL, 1, 3, NULL,
         1, 'weekly', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (4, '2026-05-20', vision_numeric('-20', 18, 4), 'USD', 'HOTEL SAVE', NULL, NULL, 2, 3, NULL,
         1, 'monthly', '2026-12-20', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (5, '2026-06-20', vision_numeric('-9.99', 18, 4), 'EUR', 'INACTIVE', NULL, NULL, 1, 1, NULL,
         0, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, '${SEED_TIME}', '${SEED_TIME}'),
        (6, '2026-05-01', vision_numeric('-45', 18, 4), 'EUR', 'DONE MONTH', NULL, NULL, 1, 4, NULL,
         1, 'monthly', NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (8, '2026-05-10', vision_numeric('-120', 18, 4), 'EUR', 'LOAN', NULL, NULL, 1, 4, NULL,
         1, 'monthly', NULL, NULL, 1, 'annuity', vision_numeric('1200', 18, 4), vision_numeric('3.5', 8, 4),
         12, '2026-05-10', 10, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (10, '2026-05-15', vision_numeric('-14.5', 18, 4), 'EUR', 'BOUNDED', NULL, NULL, 1, 1, NULL,
         1, 'monthly', '2026-06-20', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (11, '2026-06-10', vision_numeric('-8', 18, 4), 'EUR', 'EVERY 3', NULL, NULL, 1, 1, NULL,
         1, 'every 3 days', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (12, '2026-06-10', vision_numeric('-7', 18, 4), 'EUR', 'PADDED', NULL, NULL, 1, 1, NULL,
         1, '  BiWeekly ', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}'),
        (13, '2027-01-15', vision_numeric('-5', 18, 4), 'GBP', 'FAR AWAY', NULL, NULL, 1, 1, NULL,
         0, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, '${SEED_TIME}', '${SEED_TIME}')`,
      `INSERT INTO planned_transaction_executions (id, planned_transaction_id, executed_transaction_id,
         execution_date, created_at) VALUES
        (1, 6, 103, '2026-05-01', '${SEED_TIME}'),
        (2, 8, 103, '2026-05-10', '${SEED_TIME}')`,
      `INSERT INTO planned_transaction_loan_schedule (planned_transaction_id, installment_number, due_date,
         payment_amount, principal_amount, interest_amount, remaining_principal) VALUES
        (8, 1, '2026-06-10', vision_numeric('100', 18, 4), vision_numeric('96.5', 18, 4),
         vision_numeric('3.5', 18, 4), vision_numeric('1103.5', 18, 4)),
        (8, 2, '2026-07-10', vision_numeric('100', 18, 4), vision_numeric('96.78', 18, 4),
         vision_numeric('3.22', 18, 4), vision_numeric('1006.72', 18, 4))`,
      `INSERT INTO planned_transaction_tags (planned_transaction_id, tag_id) VALUES (1, 1), (1, 2), (8, 3)`,
    ],
    steps: [
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?limit=3&offset=2",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?limit=0",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?offset=-5",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?limit=99999",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=all",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=bogus",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?start_date=2026-05-01&end_date=2026-06-12",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?start_date=2026-13-01",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?start_date=2026/05/01",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?end_date=2026-02-30",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?account_id=1",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?account_id=abc",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?account_id=",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?account_id=1&account_id=2",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?category_id=10",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?category_id=11",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?recipient_id=1",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?recipient_id=2",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?bank_account=mai",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?bank_account=",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?bank_account=a&bank_account=b",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=shop",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=groc",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=%C3%A9",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=bogus",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=a&search=b",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?search=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_recurring=true",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_recurring=",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_recurring=bogus",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_recurring=1&is_recurring=true",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_executed=false",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_executed=1&active=false",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_executed=true&is_recurring=true&limit=2",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?recipient_id=x&start_date=bad&search=a&search=b&account_id=abc",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=usd",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=GBP",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=XYZ",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=xy",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=5",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=a&currency=b",
      },
      {
        operationId: "getPlannedMatchSuggestions",
        method: "GET",
        path: "/api/planned-transactions/match-suggestions",
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/abc/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/0/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1.5/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: {},
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: null },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 0 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: "" },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: "abc" },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 1e3 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 2147483648 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 101, execution_date: "2026-13-01" },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 101, execution_date: "" },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 101, execution_date: 5 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/999/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/5/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/6/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 999 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/3/execute",
        body: { executed_transaction_id: 104 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/3/execute",
        body: { executed_transaction_id: 105 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 104 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/1/execute",
        body: { executed_transaction_id: 101, execution_date: "2026-06-13" },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?limit=2",
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/3/execute",
        body: { executed_transaction_id: 101 },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?is_executed=false&active=false&limit=3",
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/10/execute",
        body: { executed_transaction_id: 102 },
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/10/execute",
        body: { executed_transaction_id: 102 },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false&limit=5",
      },
      {
        operationId: "executePlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions/12/execute",
        body: { executed_transaction_id: 103 },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?limit=4",
      },
      {
        operationId: "getPlannedMatchSuggestions",
        method: "GET",
        path: "/api/planned-transactions/match-suggestions",
      },
      {
        operationId: "getPlannedTotals",
        method: "GET",
        path: "/api/planned-transactions/totals?currency=EUR",
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          memo: "rent",
          comment: "first",
        },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false&limit=3",
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { account_id: 1 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { account_id: 1, planned_date: "2026-07-01" },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { account_id: 1, planned_date: "2026-07-01", amount: 0 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { account_id: 1, planned_date: "2026-07-01", amount: "abc" },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { account_id: 1, planned_date: "2026-07-01", amount: 1e15 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { planned_date: "2026-07-01", amount: -5 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { planned_date: "2026-07-01", amount: -5, account_id: "2" },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { planned_date: "2026-07-01", amount: -5, account_id: -1 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { planned_date: "2026-07-01", amount: -5, account_id: 1.5 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: { planned_date: "2026-07-01", amount: -5, account_id: 999 },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          memo: null,
          currency: "usd",
          comment: "upper",
          url: "",
          tags: ["holiday", "old"],
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          memo: 5,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          currency: "xy",
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          currency: "",
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          tags: "holiday",
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          tags: [5],
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          is_recurring: true,
          recurrence_pattern: "fortnightly",
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          is_recurring: true,
          recurrence_pattern: "every 5 days",
          recurrence_end_date: "2026-12-31",
          max_occurrences: 5,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          recurrence_end_date: "2026-1-1",
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          max_occurrences: 0,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          max_occurrences: 1.5,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          reminder_days_before: 2.5,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          reminder_days_before: 366,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          reminder_days_before: 3,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          planned_date: "2026-07-01",
          amount: -12.5,
          account_id: 1,
          bank_account: "Main",
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          is_loan: true,
          loan_type: "amortizing",
          loan_principal: 12000,
          loan_annual_interest_rate: 3.5,
          loan_term_months: 6,
          loan_start_date: "2026-07-01",
          loan_payment_day: 20,
          account_id: 1,
          memo: " mortgage ",
          tags: ["holiday"],
          max_occurrences: 3,
        },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false&limit=2",
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          is_loan: true,
          loan_type: "annuity",
          loan_principal: 12000,
          loan_annual_interest_rate: 3.5,
          loan_term_months: 6,
          loan_start_date: "2026-07-01",
          loan_payment_day: 20,
          account_id: 1,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          is_loan: true,
          loan_type: "interest_only",
          loan_principal: "2400",
          loan_term_months: 3,
          loan_start_date: "2026-07-15",
          loan_payment_day: 5,
          loan_annual_interest_rate: null,
          account_id: 1,
        },
      },
      {
        operationId: "createPlannedTransaction",
        method: "POST",
        path: "/api/planned-transactions",
        body: {
          is_loan: 1,
          loan_type: "fixed_principal",
          loan_principal: 1000,
          loan_term_months: 601,
          loan_start_date: "2026-07-01",
          account_id: 1,
        },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/999",
        body: { memo: "no" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/1",
        body: { currency: null },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/1",
        body: { currency: "xy" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/1",
        body: { amount: 0 },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/1",
        body: { amount: 1e15 },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/1",
        body: { amount: "", reminder_days_before: 400 },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/1",
        body: { recurrence_pattern: "fortnightly" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { recurrence_pattern: "quarterly", is_recurring: true },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: {
          recurrence_pattern: "quarterly",
          is_recurring: true,
          memo: " PAD ",
        },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/999",
        body: { recipient_name: "SHOP" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { recipient_name: "NOBODY" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { recipient_name: "shop south" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { category_name: "FOOD" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { category_name: "NOPE" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { category_name: "food:grocERIES" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { tags: [] },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { tags: ["work", "unknown-tag", "old"] },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=all&limit=3",
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { is_active: false },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { is_active: true, account_id: 2, currency: "USD" },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { account_id: 999 },
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/8",
        body: { loan_principal: 13000 },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false&limit=2",
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: {
          is_loan: true,
          loan_type: "fixed_principal",
          loan_principal: 5000,
          loan_term_months: 5,
          loan_start_date: "2026-06-01",
          loan_payment_day: 1,
        },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false&limit=3",
      },
      {
        operationId: "updatePlannedTransaction",
        method: "PATCH",
        path: "/api/planned-transactions/13",
        body: { is_loan: false },
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false&limit=3",
      },
      {
        operationId: "deletePlannedTransaction",
        method: "DELETE",
        path: "/api/planned-transactions/abc",
      },
      {
        operationId: "deletePlannedTransaction",
        method: "DELETE",
        path: "/api/planned-transactions/0",
      },
      {
        operationId: "deletePlannedTransaction",
        method: "DELETE",
        path: "/api/planned-transactions/999",
      },
      {
        operationId: "deletePlannedTransaction",
        method: "DELETE",
        path: "/api/planned-transactions/12",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?limit=100",
      },
      {
        operationId: "deletePlannedTransaction",
        method: "DELETE",
        path: "/api/planned-transactions/8",
      },
      {
        operationId: "getPlannedTransactions",
        method: "GET",
        path: "/api/planned-transactions?active=false",
      },
    ],
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
  const categoryArea = AREAS.categories;
  const recipientArea = AREAS.recipients;
  const transactionArea = AREAS.transactions;
  const plannedArea = AREAS.planned;
  const importParsersArea = AREAS.importParsers;
  const importBatchesArea = AREAS.importBatches;
  const importReviewArea = AREAS.importReview;
  const importUploadsArea = AREAS.importUploads;
  const investmentsArea = AREAS.investments;
  if (
    tags === undefined ||
    settings === undefined ||
    rates === undefined ||
    accountArea === undefined ||
    categoryArea === undefined ||
    recipientArea === undefined ||
    transactionArea === undefined ||
    plannedArea === undefined ||
    importParsersArea === undefined ||
    importBatchesArea === undefined ||
    importReviewArea === undefined ||
    importUploadsArea === undefined ||
    investmentsArea === undefined
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

  const parserRandom = new Random(0x9c1f);
  const parserStep: ParityStep[] = [];
  const parserIds = [
    "1",
    "2",
    "999",
    "5",
    "abc",
    "0",
    "1e3",
    "2147483648",
    "-1",
  ];
  const names = ["KBC main", "  Bulk  ", "", 0, null, [], "", "x".repeat(120)];
  const configs = [
    null,
    [],
    "text",
    0,
    {},
    PARSER_CONFIG,
    { dateColumn: "D", recipientColumn: "R", amountColumn: "A" },
    { ...PARSER_CONFIG, encoding: "UTF8" },
    { ...PARSER_CONFIG, encoding: "latin-1" },
    { ...PARSER_CONFIG, encoding: "windows-1252" },
    { ...PARSER_CONFIG, encoding: "bogus" },
    { ...PARSER_CONFIG, encoding: 7 },
    { ...PARSER_CONFIG, number_format: "decimal_dot" },
    { ...PARSER_CONFIG, number_format: "bogus" },
    { ...PARSER_CONFIG, number_format: 3 },
    { ...PARSER_CONFIG, skipRows: "" },
    { ...PARSER_CONFIG, skipRows: "3a" },
    { ...PARSER_CONFIG, skipRows: 2 },
    { ...PARSER_CONFIG, skipRows: -1 },
    { ...PARSER_CONFIG, separator: "" },
    { ...PARSER_CONFIG, separator: "\t" },
    { ...PARSER_CONFIG, dateFormat: "  " },
    { ...PARSER_CONFIG, memoColumn: 0 },
    { ...PARSER_CONFIG, extraKey: "dropped" },
    { dateColumn: "", recipientColumn: "R", amountColumn: "A" },
    { dateColumn: 5, recipientColumn: [], amountColumn: {} },
  ];
  for (let i = 0; i < 420; i++) {
    const roll = parserRandom.next();
    if (roll < 0.5) {
      parserStep.push({
        operationId: "createCustomParser",
        method: "POST",
        path: "/api/import/parsers",
        body: {
          ...(parserRandom.chance(0.9)
            ? { name: parserRandom.pick(names) }
            : {}),
          ...(parserRandom.chance(0.9)
            ? { config: parserRandom.pick(configs) }
            : {}),
          ...(parserRandom.chance(0.05)
            ? { extra: randomValue(parserRandom, 0) }
            : {}),
        },
      });
    } else if (roll < 0.75) {
      const body: Record<string, unknown> = {};
      if (parserRandom.chance(0.6)) body.name = parserRandom.pick(names);
      if (parserRandom.chance(0.6)) body.config = parserRandom.pick(configs);
      parserStep.push({
        operationId: "updateCustomParser",
        method: "PATCH",
        path: `/api/import/parsers/${parserRandom.pick(parserIds)}`,
        body,
      });
      if (parserRandom.chance(0.06))
        parserStep.push({
          operationId: "deleteCustomParser",
          method: "DELETE",
          path: `/api/import/parsers/${parserRandom.pick(parserIds)}`,
        });
    } else {
      parserStep.push(parserList());
    }
  }
  parserStep.push(parserList());

  const batchRandom = new Random(0x4b7c);
  const batchSteps: ParityStep[] = [];
  const batchIds = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "999",
    "0",
    "-3",
    "abc",
    "1e3",
    "2.5",
    "00001",
    "9007199254740991",
    "9007199254740992",
    "0x10",
    "+5",
    " 12 ",
    "",
  ];
  for (let i = 0; i < 420; i++) {
    const roll = batchRandom.next();
    if (roll < 0.55) {
      batchSteps.push(batchDelete(batchRandom.pick(batchIds)));
    } else {
      batchSteps.push(
        batches(`?${randomQuery(batchRandom, ["limit", "offset", "status"])}`),
      );
    }
  }
  batchSteps.push(batches());

  // The review area's writes: overrides aimed at random batch/row ids with random id
  // values, with previews between. The ids stay inside the seed's (10, 11, 3, 4) or the
  // malformed set: a syntactically valid but nonexistent id reaches the database write
  // and fails its foreign key, a 500 the corpus cannot meaningfully pin.
  const reviewRandom = new Random(0x6f11);
  const reviewSteps: ParityStep[] = [];
  const reviewBatchIds = [
    "20",
    "21",
    "999",
    "0",
    "-3",
    "abc",
    "1e3",
    "2.5",
    "00020",
    "9007199254740991",
    "9007199254740992",
    "+20",
    " 20 ",
  ];
  const reviewRowIds = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "999",
    "0",
    "-1",
    "abc",
    "4.5",
    "0002",
  ];
  const reviewRecipientIds: unknown[] = [
    null,
    10,
    11,
    0,
    -1,
    "10",
    "abc",
    [],
    {},
    true,
    false,
    3.5,
    9007199254740991,
    2147483648,
  ];
  const reviewCategoryIds: unknown[] = [
    null,
    3,
    4,
    999,
    0,
    -1,
    "3",
    "abc",
    [],
    {},
    true,
    false,
    2.5,
    2147483648,
  ];
  for (let i = 0; i < 420; i++) {
    const roll = reviewRandom.next();
    if (roll < 0.25) {
      reviewSteps.push(batchPreview(reviewRandom.pick(reviewBatchIds)));
    } else if (roll < 0.65) {
      const id = reviewRandom.pick(reviewBatchIds);
      const rowId = reviewRandom.pick(reviewRowIds);
      if (reviewRandom.chance(0.12)) {
        reviewSteps.push(batchOverrideRecipient(id, rowId));
      } else {
        reviewSteps.push(
          batchOverrideRecipient(id, rowId, {
            recipient_id: reviewRandom.pick(reviewRecipientIds),
          }),
        );
      }
    } else {
      const id = reviewRandom.pick(reviewBatchIds);
      const rowId = reviewRandom.pick(reviewRowIds);
      if (reviewRandom.chance(0.12)) {
        reviewSteps.push(batchOverrideCategory(id, rowId));
      } else {
        reviewSteps.push(
          batchOverrideCategory(id, rowId, {
            category_id: reviewRandom.pick(reviewCategoryIds),
          }),
        );
      }
    }
    if (reviewRandom.chance(0.1)) reviewSteps.push(batchPreview("20"));
  }
  reviewSteps.push(batchPreview("20"));

  // The investments area's mutations: only its read requests, with seeded-random
  // query strings (repeated keys, garbage bounds, invalid id lists) over the five
  // ported operations. The { id } reads use the ids the seed owns plus shapes that
  // probe `validateId`'s accept set.
  const investmentRandom = new Random(0x1a2b);
  const investmentIds = [
    "1",
    "2",
    "3",
    "999",
    "0",
    "-1",
    "abc",
    "1.5",
    "01",
    "1e3",
    "2147483648",
    " 5",
  ];
  const investmentQueryValues = [
    "",
    "1",
    "2",
    "0",
    "-3",
    "1001",
    "200000",
    "5001",
    "abc",
    "1.5",
    "1e2",
    "true",
    "false",
    "all",
    "stock",
  ];
  const investmentPick = () => investmentRandom.pick(investmentQueryValues);
  const investmentPairs = (names: readonly string[]) => {
    const count = investmentRandom.int(5);
    const pairs: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = investmentRandom.chance(0.9)
        ? investmentRandom.pick(names)
        : "other";
      pairs.push(
        investmentRandom.chance(0.1) ? name : `${name}=${investmentPick()}`,
      );
    }
    return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
  };
  const investmentWithQuery = (path: string, query: string) =>
    path + (query === "" ? "" : query);
  const investmentJoin = (query: string, extra: string) => {
    if (query === "" || extra === "") return query + extra;
    return `${query}&${extra.slice(1)}`;
  };
  const investmentSteps: ParityStep[] = [];
  for (let i = 0; i < 60; i++) {
    investmentSteps.push({
      operationId: "getInvestments",
      method: "GET",
      path: `/api/investments${investmentPairs(["asset_class", "active", "limit", "offset"])}`,
    });
    if (investmentRandom.chance(0.7))
      investmentSteps.push({
        operationId: "getInvestmentSummary",
        method: "GET",
        path: `/api/investments/${investmentRandom.pick(investmentIds)}/summary`,
      });
    if (investmentRandom.chance(0.7))
      investmentSteps.push({
        operationId: "getInvestmentTransactions",
        method: "GET",
        path: `/api/investments/${investmentRandom.pick(investmentIds)}/transactions${investmentPairs(["type", "limit", "offset"])}`,
      });
    if (investmentRandom.chance(0.8)) {
      // `investment_ids` alone decides 400 vs 200, so probe the element accept set
      // (digit runs, duplicates, repeated keys, garbage) as often as the real one.
      const ids = Array.from({ length: 1 + investmentRandom.int(4) }, () =>
        investmentRandom.pick(investmentIds),
      );
      let query = investmentRandom.chance(0.2)
        ? ""
        : `?investment_ids=${encodeURIComponent(ids.join(","))}`;
      if (investmentRandom.chance(0.15) && query !== "")
        query += `&investment_ids=${investmentRandom.pick(investmentIds)}`;
      investmentSteps.push({
        operationId: "getBulkPortfolioTransactions",
        method: "GET",
        path: investmentWithQuery(
          "/api/investments/transactions",
          investmentJoin(
            query,
            investmentPairs([
              "type",
              "per_investment_limit",
              "limit",
              "offset",
            ]),
          ),
        ),
      });
    }
    if (investmentRandom.chance(0.3))
      investmentSteps.push({
        operationId: "listInvestmentProviders",
        method: "GET",
        path: "/api/investments/providers",
      });
  }

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

  // The category bodies mutated; node updates and merges sometimes aimed at
  // random ids, with random list queries, tree reads and node deletes between.
  const categoryRandom = new Random(0xca7e);
  const categorySteps: ParityStep[] = [];
  for (const step of mutatedSteps(categoryRandom, categoryArea.steps, 3)) {
    if (step.operationId === "updateCategoryNode" && categoryRandom.chance(0.3))
      categorySteps.push(nodeUpdate(categoryRandom.pick(ids), step.body));
    else if (
      step.operationId === "mergeCategoryNode" &&
      categoryRandom.chance(0.3)
    )
      categorySteps.push(nodeMerge(categoryRandom.pick(ids), step.body));
    else categorySteps.push(step);
    if (categoryRandom.chance(0.12))
      categorySteps.push(
        categories(
          randomQuery(categoryRandom, [
            "active",
            "general",
            "detail",
            "search",
            "limit",
            "offset",
          ]),
        ),
      );
    if (categoryRandom.chance(0.05)) categorySteps.push(categoryTree);
    if (categoryRandom.chance(0.04))
      categorySteps.push(nodeDelete(categoryRandom.pick(ids)));
  }
  categorySteps.push(categoryTree, categories("?active=false"));

  // The recipient and pattern bodies mutated; writes sometimes aimed at random
  // ids, with random list queries, reads, unmerges and deletes between.
  const recipientRandom = new Random(0x2ec1);
  const recipientSteps: ParityStep[] = [];
  for (const step of mutatedSteps(recipientRandom, recipientArea.steps, 3)) {
    const target = recipientRandom.chance(0.3)
      ? recipientRandom.pick(ids)
      : undefined;
    if (target !== undefined && step.operationId === "updateRecipient")
      recipientSteps.push(recipientUpdate(target, step.body));
    else if (target !== undefined && step.operationId === "mergeRecipient")
      recipientSteps.push(recipientMerge(target, step.body));
    else if (
      target !== undefined &&
      step.operationId === "updateRecipientPattern"
    )
      recipientSteps.push(patternUpdate("1", target, step.body));
    else recipientSteps.push(step);
    if (recipientRandom.chance(0.12))
      recipientSteps.push(
        recipients(
          randomQuery(recipientRandom, [
            "active",
            "name",
            "search",
            "sort_by",
            "sort_dir",
            "default_category_id",
            "uncategorized",
            "limit",
            "offset",
          ]),
        ),
      );
    if (recipientRandom.chance(0.05))
      recipientSteps.push(recipientRead(recipientRandom.pick(ids)));
    if (recipientRandom.chance(0.04))
      recipientSteps.push(recipientUnmerge(recipientRandom.pick(ids)));
    if (recipientRandom.chance(0.03))
      recipientSteps.push(recipientDelete(recipientRandom.pick(ids)));
    if (recipientRandom.chance(0.03))
      recipientSteps.push(patternList(recipientRandom.pick(ids)));
  }
  recipientSteps.push(recipients("?active=false&limit=1000"), patternList("1"));

  // Reads only: random list queries and reads of random ids.
  const transactionRandom = new Random(0x7a11);
  const transactionSteps: ParityStep[] = [];
  for (let i = 0; i < 200; i++) {
    transactionSteps.push(
      transactions(randomQuery(transactionRandom, TRANSACTION_QUERY_KEYS)),
    );
    if (transactionRandom.chance(0.1))
      transactionSteps.push(transactionRead(transactionRandom.pick(ids)));
  }

  // The planned-payments area's writes: mutated execute bodies, executes aimed at
  // random ids, deletes now and then, with random list, totals and suggestion reads
  // between, all under the area's fixed clock.
  const plannedRandom = new Random(0x91a3);
  const plannedSteps: ParityStep[] = [];
  const executeIds = [
    "1",
    "3",
    "4",
    "5",
    "6",
    "8",
    "10",
    "11",
    "12",
    "13",
    "0",
    "-1",
    "abc",
    "1e3",
    "999",
  ];
  const transactionIds = [
    "101",
    "102",
    "103",
    "104",
    "105",
    "106",
    "0",
    "-1",
    "abc",
    "1.5",
    "999",
    "2147483648",
  ];
  const plannedPasses = mutatedSteps(plannedRandom, plannedArea.steps, 3);
  // Three passes of the mutated bodies: the area writes, so the corpus needs the
  // hundreds of steps the hand-written one cannot reach.
  const plannedRounds = [0, 1, 2].flatMap(() => plannedPasses);
  for (const step of plannedRounds) {
    if (
      step.operationId === "executePlannedTransaction" &&
      plannedRandom.chance(0.25)
    ) {
      plannedSteps.push({
        operationId: "executePlannedTransaction",
        method: "POST",
        path: `/api/planned-transactions/${plannedRandom.pick(executeIds)}/execute`,
        body: step.body,
      });
    } else {
      plannedSteps.push(step);
    }
    if (plannedRandom.chance(0.12)) {
      plannedSteps.push({
        operationId: "getPlannedTransactions",
        method: "GET",
        path: `/api/planned-transactions${randomQuery(plannedRandom, [
          "start_date",
          "end_date",
          "bank_account",
          "account_id",
          "category_id",
          "recipient_id",
          "is_recurring",
          "is_executed",
          "search",
          "active",
          "limit",
          "offset",
        ])}`,
      });
    }
    if (plannedRandom.chance(0.05)) {
      plannedSteps.push({
        operationId: "getPlannedTotals",
        method: "GET",
        path: `/api/planned-transactions/totals${randomQuery(plannedRandom, ["currency"])}`,
      });
    }
    if (plannedRandom.chance(0.05)) {
      plannedSteps.push({
        operationId: "getPlannedMatchSuggestions",
        method: "GET",
        path: "/api/planned-transactions/match-suggestions",
      });
    }
    if (plannedRandom.chance(0.02)) {
      plannedSteps.push({
        operationId: "executePlannedTransaction",
        method: "POST",
        path: `/api/planned-transactions/${plannedRandom.pick(executeIds)}/execute`,
        body: { executed_transaction_id: plannedRandom.pick(transactionIds) },
      });
    }
    if (plannedRandom.chance(0.04)) {
      plannedSteps.push({
        operationId: "deletePlannedTransaction",
        method: "DELETE",
        path: `/api/planned-transactions/${plannedRandom.pick(executeIds)}`,
      });
    }
  }
  // The upload area's mutations: uploads with mutated multipart fields, file
  // names, content types and CSV contents, with batch reads between so a wrong
  // staged state shows up as a difference. Every bank name routes to a real
  // adapter or fails the pipeline's own validation — an unknown name is the
  // pipeline's 500, which the corpus cannot replay usefully.
  const uploadRandom = new Random(0x7a16e);
  const uploadSteps: ParityStep[] = [];
  const uploadBankNames = ["kbc", "KBC", "K B C", "kbc ", "", "  "];
  const uploadFileNames = [
    "a.csv",
    "b.CSV",
    "c.txt",
    "x.tar.gz",
    " sta-p až 1.csv",
    "UP.CSV",
  ];
  const uploadContentTypes = [
    "text/csv",
    "text/plain",
    "application/vnd.ms-excel",
    "application/octet-stream",
    "",
    "application/json",
  ];
  const uploadDates = [
    "10/07/2024",
    "10/13/2024",
    "31/12/2024",
    "",
    "aa/bb/cccc",
    "1/2/2024",
    "2024-07-10",
  ];
  const uploadAmounts = [
    "-1,25",
    "0,00",
    "9,95",
    "-0,01",
    "1e3,45",
    "",
    "abc",
    "12",
  ];
  const uploadCounterparties = [
    "DupCoffee",
    "DUPCOFFEE",
    "fresh place x2c",
    "Fresh Café",
    "",
    "   ",
    "Стамбул food",
    "Dup Coffee",
  ];
  const uploadCustomBodies = (): Record<string, string> => {
    const fields: Record<string, string> = {};
    if (uploadRandom.chance(0.92))
      fields.bank_name = uploadRandom.pick(uploadBankNames);
    if (uploadRandom.chance(0.8))
      fields.date_format = uploadRandom.pick([
        "%Y-%m-%d",
        "%d/%m/%Y",
        "",
        "Y-m-d",
      ]);
    if (uploadRandom.chance(0.8))
      fields.date_column = uploadRandom.pick([
        "Date",
        "date",
        "Datum",
        "",
        "  ",
      ]);
    if (uploadRandom.chance(0.8))
      fields.recipient_column = uploadRandom.pick([
        "Name",
        "Naam",
        "",
        "Payee",
      ]);
    if (uploadRandom.chance(0.8))
      fields.amount_column = uploadRandom.pick(["Amount", "Bedrag", "", "Amt"]);
    if (uploadRandom.chance(0.4))
      fields.memo_column = uploadRandom.pick(["Memo", "", "Note"]);
    if (uploadRandom.chance(0.3))
      fields.number_format = uploadRandom.pick([
        "auto",
        "dot",
        "comma",
        "weird",
      ]);
    if (uploadRandom.chance(0.3))
      fields.separator = uploadRandom.pick([",", ";", ";;", "\t", ",,"]);
    if (uploadRandom.chance(0.3))
      fields.skip_rows = uploadRandom.pick(["0", "1", "-2", "3", "abc"]);
    if (uploadRandom.chance(0.2))
      fields.encoding = uploadRandom.pick(["utf-8", "latin1", "", "utf8"]);
    return fields;
  };
  const uploadBatchIds = ["1", "2", "3", "4", "10", "999", "0", "abc", "1e3"];
  const uploadCsvContent = (): string => {
    if (uploadRandom.chance(0.15))
      return "\uFEFFgarbage header;line;with\nno structure";
    const rows: string[] = [];
    const count = 1 + uploadRandom.int(3);
    for (let r = 0; r < count; r++) {
      rows.push(
        kbcLine(
          uploadRandom.pick(uploadDates),
          uploadRandom.pick(uploadAmounts),
          uploadRandom.pick(["100,00", "", "-5,00"]),
          uploadRandom.chance(0.5) ? "" : "1,00",
          uploadRandom.chance(0.5) ? "" : "2,00",
          uploadRandom.pick(uploadCounterparties),
        ),
      );
    }
    return rows.join("");
  };
  const uploadRecipientsContent = (): string => {
    const rows: string[] = ["name,category,bank_account,address"];
    const count = 1 + uploadRandom.int(3);
    for (let r = 0; r < count; r++) {
      rows.push(
        [
          uploadRandom.pick(uploadCounterparties),
          uploadRandom.pick([
            "FOOD:GROCERIES",
            "IMPORT:MUT",
            "no colon here",
            "",
            "general:",
            ":detail",
          ]),
          uploadRandom.chance(0.3)
            ? uploadRandom.pick(["BE10", "", "abc"])
            : "",
          uploadRandom.chance(0.3)
            ? uploadRandom.pick(["Street 1", "", "x;s"])
            : "",
        ].join(","),
      );
    }
    return rows.join("\n");
  };
  const uploadCategoriesContent = (): string => {
    const rows: string[] = ["category,description"];
    const count = 1 + uploadRandom.int(3);
    for (let r = 0; r < count; r++) {
      rows.push(
        [
          uploadRandom.pick([
            "IMPORT:MUT" + r,
            "no colon",
            "",
            "gen:eral",
            "FOOD:GROCERIES",
            "INTER:SPIØ",
          ]),
          uploadRandom.pick(["", "d", "x;s"] as string[]),
        ].join(","),
      );
    }
    return rows.join("\n");
  };
  const withMultipart = (
    operationId: string,
    path: string,
    content: string,
  ): ParityStep => {
    if (uploadRandom.chance(0.08)) {
      // No file part at all: the route's "No file uploaded" answer.
      return csvUploadStep(operationId, path, {
        filename: "",
        content: "",
        fields: uploadCustomBodies(),
      });
    }
    return csvUploadStep(operationId, path, {
      filename: uploadRandom.pick(uploadFileNames),
      contentType: uploadRandom.pick(uploadContentTypes),
      content,
      fields: uploadCustomBodies(),
    });
  };
  for (let i = 0; i < 430; i++) {
    const roll = uploadRandom.next();
    if (roll < 0.5) {
      uploadSteps.push(
        withMultipart("importCsv", "/api/import/csv", uploadCsvContent()),
      );
    } else if (roll < 0.68) {
      uploadSteps.push(
        withMultipart(
          "importCsvCustom",
          "/api/import/csv/custom",
          "Date,Name,Amount,Memo\n2024-07-01,FreshCustom,10.50,Custom memo\n2024-07-02,Second,\x221,\n",
        ),
      );
    } else if (roll < 0.85) {
      uploadSteps.push(
        withMultipart(
          "importRecipients",
          "/api/import/recipients",
          uploadRecipientsContent(),
        ),
      );
    } else {
      uploadSteps.push(
        withMultipart(
          "importCategories",
          "/api/import/categories",
          uploadCategoriesContent(),
        ),
      );
    }
    if (uploadRandom.chance(0.1)) {
      // The batch list grows with every upload, so the corpus keeps each read
      // a bounded page; the preview reads carry the staged state.
      uploadSteps.push(batches("?limit=5&offset=0"));
    }
    if (uploadRandom.chance(0.08)) {
      uploadSteps.push(batchPreview(uploadRandom.pick(uploadBatchIds)));
    }
  }
  uploadSteps.push(
    batches("?limit=5"),
    batchPreview("2"),
    withMultipart("importCsv", "/api/import/csv", uploadCsvContent()),
    withMultipart(
      "importCsvStream",
      "/api/import/csv/stream",
      kbcLine("01/06/2025", "-1,00", "99,00", "", "1,00", "DupCoffee"),
    ),
    batches("?limit=5"),
  );

  plannedSteps.push(
    {
      operationId: "getPlannedTransactions",
      method: "GET",
      path: "/api/planned-transactions?limit=100",
    },
    {
      operationId: "getPlannedTotals",
      method: "GET",
      path: "/api/planned-transactions/totals",
    },
    {
      operationId: "getPlannedMatchSuggestions",
      method: "GET",
      path: "/api/planned-transactions/match-suggestions",
    },
  );

  return {
    "planned-mutations": {
      ...plannedArea,
      steps: asRecorded(plannedSteps),
    },
    "transactions-mutations": {
      ...transactionArea,
      steps: asRecorded(transactionSteps),
    },
    "recipients-mutations": {
      ...recipientArea,
      steps: asRecorded(recipientSteps),
    },
    "categories-mutations": {
      ...categoryArea,
      steps: asRecorded(categorySteps),
    },
    "accounts-mutations": { ...accountArea, steps: asRecorded(accountSteps) },
    "tags-mutations": { ...tags, steps: asRecorded(tagSteps) },
    "settings-mutations": { ...settings, steps: asRecorded(settingSteps) },
    "exchange-rates-mutations": { ...rates, steps: asRecorded(rateSteps) },
    "importParsers-mutations": {
      ...importParsersArea,
      steps: asRecorded(parserStep),
    },
    "investments-mutations": {
      ...investmentsArea,
      steps: asRecorded(investmentSteps),
    },
    "portfolio-transactions-mutations": {
      router: { module: "investments.ts", mountPath: "/api/investments" },
      seed: [
        `INSERT INTO accounts (id, name, display_name, institution, currency, type, liquidity_class, spendable,
           in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active,
           closed_at, created_at, updated_at, import_identity) VALUES
          (1, 'Bolero', 'Bolero brokerage', 'Bolero', 'EUR', 'brokerage', 'liquid', 1, 1, 'tax_advantaged', 'me', 0, 1, NULL, 1, NULL,
           '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-00000000aa01'),
          (2, 'Degiro', NULL, 'Degiro', 'USD', 'brokerage', 'liquid', 1, 1, 'none', 'me', 1, 1, NULL, 1, NULL,
           '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-00000000aa02'),
          (3, 'Cash', NULL, NULL, 'EUR', 'checking', 'liquid', 1, 1, 'none', 'me', 0, 1, NULL, 1, NULL,
           '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-00000000aa03')`,
        `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
          ${RATE_ROW("USD", "0.9163", "2025-01-02", 1)},
          ${RATE_ROW("GBP", "1.1541", "2025-01-02", 1)}`,
        `INSERT INTO investments (id, name, symbol, asset_class, currency, current_price, interest_rate,
           is_active, price_provider, notes, created_at, updated_at) VALUES
          (1, 'ACME Corp', 'ACME', 'stock', 'USD', vision_numeric('150.50', 18, 6), NULL,
           1, 'manual', 'usd stock', '${SEED_TIME}', '${SEED_TIME}'),
          (2, 'City Loft', NULL, 'real_estate', 'EUR', vision_numeric('250000', 18, 6), NULL,
           1, 'manual', NULL, '${SEED_TIME}', '${SEED_TIME}')`,
        `INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, units, price_per_unit,
           fees, taxes, currency, fx_rate_to_eur, note, account_id, created_at, updated_at) VALUES
          (1, 1, 'buy', '2024-01-10', vision_numeric('1000', 18, 4), vision_numeric('10', 18, 8),
           vision_numeric('100', 18, 6), vision_numeric('1.5', 18, 4), vision_numeric('0', 18, 4), 'USD',
           vision_numeric('0.9', 20, 10), 'initial buy', 1, '${SEED_TIME}', '${SEED_TIME}'),
          (2, 1, 'dividend', '2024-03-01', vision_numeric('12.25', 18, 4), NULL, NULL,
           vision_numeric('0', 18, 4), vision_numeric('0', 18, 4), 'USD', NULL, NULL, 1,
           '${SEED_TIME}', '${SEED_TIME}'),
          (3, 2, 'rent_income', '2024-02-01', vision_numeric('950.40', 18, 4), NULL, NULL,
           vision_numeric('0', 18, 4), vision_numeric('0', 18, 4), 'EUR', NULL, 'february rent', NULL,
           '${SEED_TIME}', '${SEED_TIME}'),
          (4, 1, 'sell', '2024-05-20', vision_numeric('600', 18, 4), vision_numeric('4', 18, 8),
           vision_numeric('150', 18, 6), vision_numeric('2', 18, 4), vision_numeric('0', 18, 4), 'USD',
           vision_numeric('0.92', 20, 10), 'partial exit', 2, '${SEED_TIME}', '${SEED_TIME}'),
          (5, 1, 'gift', '2024-06-15', vision_numeric('0', 18, 4), vision_numeric('2', 18, 8),
           vision_numeric('0', 18, 6), vision_numeric('0', 18, 4), vision_numeric('0', 18, 4), 'USD',
           NULL, 'inherited shares', 1, '${SEED_TIME}', '${SEED_TIME}')`,
      ],
      now: "2026-11-26T12:00:00.000Z",
      steps: [
        { operationId: "getInvestmentTransactions", method: "GET", path: "/api/investments/1/transactions" },
        {
          operationId: "createInvestmentTransaction",
          method: "POST",
          path: "/api/investments/1/transactions",
          body: { type: "buy", date: "2024-07-01", amount: "750", units: "5", price_per_unit: "150", fees: 2.5, currency: "usd", note: "july top-up", account_id: 2 },
        },
        {
          operationId: "createInvestmentTransaction",
          method: "POST",
          path: "/api/investments/1/transactions",
          body: { type: "dividend", date: "2024-07-02", amount: 3.75, dividend_amount_convention: "gross" },
        },
        {
          operationId: "createInvestmentTransaction",
          method: "POST",
          path: "/api/investments/2/transactions",
          body: { type: "rent_income", date: "2024-03-01", amount: "1000", is_recurring: true, recurrence_interval: "monthly", recurrence_end_date: "2024-12-31" },
        },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "buy" } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: {} },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "buy", date: "2024-07-03", amount: "abc" } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "buy", date: "2024-07-03", amount: "10", currency: "euro" } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "buy", date: "2024-07-03", amount: "10", account_id: "0x10" } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "buy", date: "2024-07-03", amount: "10", account_id: 999 } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "bonus", date: "2024-07-03", amount: "10" } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/1/transactions", body: { type: "buy", date: "2024-13-45", amount: "10" } },
        { operationId: "createInvestmentTransaction", method: "POST", path: "/api/investments/999/transactions", body: { type: "buy", date: "2024-07-03", amount: "10" } },
        { operationId: "getInvestments", method: "GET", path: "/api/investments?asset_class=stock" },
        { operationId: "getBulkPortfolioTransactions", method: "GET", path: "/api/investments/transactions?investment_ids=1,2&limit=50" },
        {
          operationId: "updatePortfolioTransaction",
          method: "PATCH",
          path: "/api/investments/transactions/2",
          body: { note: "withholding included" },
        },
        {
          operationId: "updatePortfolioTransaction",
          method: "PATCH",
          path: "/api/investments/transactions/2",
          body: { currency: "" },
        },
        {
          operationId: "updatePortfolioTransaction",
          method: "PATCH",
          path: "/api/investments/transactions/2",
          body: { currency: "usd", date: "2024-03-02" },
        },
        {
          operationId: "updatePortfolioTransaction",
          method: "PATCH",
          path: "/api/investments/transactions/3",
          body: { account_id: null },
        },
        {
          operationId: "updatePortfolioTransaction",
          method: "PATCH",
          path: "/api/investments/transactions/3",
          body: { account_id: "0x10" },
        },
        {
          operationId: "updatePortfolioTransaction",
          method: "PATCH",
          path: "/api/investments/transactions/3",
          body: { account_id: 3 },
        },
        { operationId: "updatePortfolioTransaction", method: "PATCH", path: "/api/investments/transactions/999", body: { note: "nothing" } },
        { operationId: "updatePortfolioTransaction", method: "PATCH", path: "/api/investments/transactions/abc", body: { note: "nothing" } },
        { operationId: "deletePortfolioTransaction", method: "DELETE", path: "/api/investments/transactions/12abc" },
        { operationId: "deletePortfolioTransaction", method: "DELETE", path: "/api/investments/transactions/4" },
        { operationId: "deletePortfolioTransaction", method: "DELETE", path: "/api/investments/transactions/4" },
        { operationId: "getInvestmentTransactions", method: "GET", path: "/api/investments/1/transactions?limit=2&offset=1" },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [1, 2], from_account_id: 1, to_account_id: 2, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeeff" },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [1, 2], from_account_id: 1, to_account_id: 2, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeef1" },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [1, 2], from_account_id: 2, to_account_id: 1, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeef2" },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [1, 1], from_account_id: 2, to_account_id: 1, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeef3" },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [], from_account_id: null, to_account_id: 1, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeef4" },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [1], from_account_id: null, to_account_id: 1 },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [999], from_account_id: 1, to_account_id: 2, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeef5" },
        },
        {
          operationId: "bulkRetagPortfolioTransactions",
          method: "PUT",
          path: "/api/investments/transactions/broker",
          body: { transaction_ids: [1], from_account_id: 1, to_account_id: 999, idempotency_key: "0f0e0d0c-1a2b-4c3d-9e8f-aabbccddeef6" },
        },
        { operationId: "getInvestmentTransactions", method: "GET", path: "/api/investments/1/transactions?type=dividend" },
        { operationId: "getInvestmentTransactions", method: "GET", path: "/api/investments/2/transactions?limit=5" },
      ],
    },
    "prices-mutations": {
      router: { module: "investments.ts", mountPath: "/api/investments" },
      now: "2026-11-26T12:00:00.000Z",
      seed: [
        `INSERT INTO accounts (id, name, display_name, institution, currency, type, liquidity_class, spendable,
           in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active,
           closed_at, created_at, updated_at, import_identity) VALUES
          (1, 'Bolero', 'Bolero brokerage', 'Bolero', 'EUR', 'brokerage', 'liquid', 1, 1, 'none', 'me', 0, 1, NULL, 1, NULL,
           '${SEED_TIME}', '${SEED_TIME}', '00000000-0000-4000-8000-00000000bb01')`,
        `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES
          ${RATE_ROW("USD", "0.9163", "2025-01-02", 1)}`,
        `INSERT INTO investments (id, name, symbol, asset_class, currency, current_price, interest_rate,
           is_active, price_provider, price_provider_id, price_provider_latest_url, price_provider_latest_path,
           notes, created_at, updated_at) VALUES
          (1, 'ACME Corp', 'ACME', 'stock', 'USD', vision_numeric('150.50', 18, 6), NULL,
           1, 'yahoo', NULL, NULL, NULL, 'yahoo quote stub', '${SEED_TIME}', '${SEED_TIME}'),
          (2, 'Custom Fund', NULL, 'stock', 'EUR', vision_numeric('40', 18, 6), NULL,
           1, 'custom', NULL, 'http://example.com/prices/latest.json', 'data.price',
           'custom json stub', '${SEED_TIME}', '${SEED_TIME}'),
          (3, 'City Loft', NULL, 'real_estate', 'EUR', vision_numeric('250000', 18, 6), NULL,
           1, 'manual', NULL, NULL, NULL, NULL, '${SEED_TIME}', '${SEED_TIME}'),
          (4, 'Quiet Holdings', 'QUIET', 'stock', 'USD', NULL, NULL,
           1, 'yahoo', NULL, NULL, NULL, 'falls back to stored history', '${SEED_TIME}', '${SEED_TIME}')`,
        `INSERT INTO asset_price_history (investment_id, price_date, close_price, source, fetched_at, updated_at) VALUES
          (4, '2026-11-20', vision_numeric('77.25', 18, 6), 'provider',
           '2026-11-20T22:00:00.000000Z', '2026-11-20T22:00:00.000000Z'),
          (4, '2026-11-23', vision_numeric('78.5', 18, 6), 'provider',
           '2026-11-23T22:00:00.000000Z', '2026-11-23T22:00:00.000000Z')`,
      ],
      fetch: {
        "http://example.com/prices/latest.json": {
          status: 200,
          body: JSON.stringify({ data: { price: 42.5 }, asof: "2026-11-26" }),
        },
        // The yahoo batch quote fails deterministically (its spec fetch is not
        // stubbed), so the per-symbol chart fallback supplies the live quote.
        "https://query2.finance.yahoo.com/v8/finance/chart/ACME?useYfid=true&interval=1d&includePrePost=false&events=div%7Csplit%7Cearn&lang=en-US&period1=1795262400&period2=1795694400": {
          status: 200,
          body: JSON.stringify(CHART_ACME_RECENT),
        },
        "https://query2.finance.yahoo.com/v8/finance/chart/ACME?useYfid=true&interval=1d&includePrePost=false&events=div%7Csplit%7Cearn&lang=en-US&period1=1637971200&period2=1795737600": {
          status: 200,
          body: JSON.stringify(CHART_ACME_WINDOW),
        },
      },
      steps: [
        { operationId: "listInvestmentProviders", method: "GET", path: "/api/investments/providers" },
        { operationId: "refreshInvestmentPrices", method: "POST", path: "/api/investments/refresh-prices" },
        { operationId: "refreshInvestmentPrices", method: "POST", path: "/api/investments/refresh-prices" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/1/price-history" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/1/price-history?db_only=false" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/1/price-history" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/4/price-history?db_only=true" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/4/price-history?db_only=false&from_ms=1794787200000" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/2/price-history?db_only=false" },
        { operationId: "getInvestmentPriceHistory", method: "GET", path: "/api/investments/999/price-history" },
      ],
    },
    "importBatches-mutations": {
      ...importBatchesArea,
      steps: asRecorded(batchSteps),
    },
    "importReview-mutations": {
      ...importReviewArea,
      steps: asRecorded(reviewSteps),
    },
    "importUploads-mutations": {
      ...importUploadsArea,
      // The interleaved batch reads show `NOW()` timestamps the uploads write, so the
      // area records on the fixed clock the replay runs on.
      now: "2026-11-20T12:00:00.000Z",
      steps: asRecorded(uploadSteps),
    },
  };
}

Object.assign(AREAS, mutationAreas());

interface RecordedStep extends ParityStep {
  status: number;
  response: unknown;
  /** Present on the step when the route set headers (shared with the step itself). */
  headers?: Record<string, string>;
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
interface AgentRequest extends PromiseLike<{
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  text?: string | undefined;
}> {
  set(name: string, value: string): AgentRequest;
  send(body: string): AgentRequest;
  /** `httpAgent`'s multipart helpers: a text field and a file part. */
  field(name: string, value: string | number | boolean | Buffer): AgentRequest;
  attach(
    name: string,
    file: Buffer,
    options: { filename: string; contentType?: string | undefined },
  ): AgentRequest;
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
  // Before any backend module loads, so a today-dependent area records the same day on
  // every run (the recorder's answer to a corpus that only passes on the recording day).
  if (area.now !== undefined) {
    const { setSystemTime } = await import("bun:test");
    setSystemTime(new Date(area.now));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vision-parity-${name}-`));
  const file = path.join(dir, "vision.sqlite3");
  // Before any backend module loads its settings.
  process.env.VISION_DATABASE_PATH = file;
  // Written upload files (the attachments storage) land beside the throwaway database,
  // never in the repo's checkout.
  process.env.ATTACHMENTS_DIR = path.join(dir, "attachments");
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
    if (step.multipart !== undefined) {
      for (const [name, value] of Object.entries(step.multipart.fields ?? {}))
        request.field(name, value);
      for (const file of step.multipart.files)
        request.attach(file.name, Buffer.from(file.base64, "base64"), {
          filename: file.filename,
          contentType: file.contentType,
        });
    } else if ("body" in step)
      request
        .set("Content-Type", "application/json")
        .send(JSON.stringify(step.body));
    const res = await request;
    const today = todayAppDateString();
    // A streamed file answer (the exports' text/csv and x-ndjson) never parses into
    // `res.body` — its raw text is the answer the corpus must hold; everything
    // else round-trips the parsed body 1:1, and a 204 keeps recording `{}`.
    const rawContentType = res.headers["content-type"];
    const contentType = Array.isArray(rawContentType)
      ? (rawContentType[0] ?? "")
      : (rawContentType ?? "");
    const isTextAnswer =
      (contentType.startsWith("text/") || contentType.includes("ndjson")) &&
      res.text !== undefined &&
      res.text.length > 0;
    // A streamed file answer (the exports' text/csv and x-ndjson, and an attachment
    // download's raw bytes) never parses into `res.body` — its raw bytes (base64, for a
    // binary download) are the answer the corpus must hold.
    const response = Buffer.isBuffer(res.body)
      ? { buffer: res.body.toString("base64") }
      : isTextAnswer
        ? res.text
        : (JSON.parse(
            JSON.stringify(
              withoutRequestId(res.body),
              (_key, value: unknown) => {
                if (typeof value !== "string") return value;
                const withoutUuid = value.replace(UUID_RE, UUID_TOKEN);
                return withoutUuid === today ? TODAY_TOKEN : withoutUuid;
              },
            ),
          ) as unknown);
    // Headers the route set itself (execute's `Idempotent-Replay`), not the envelope's.
    const replay = res.headers["idempotent-replay"];
    const headers: Record<string, string> | undefined =
      replay === undefined
        ? undefined
        : { "Idempotent-Replay": String(replay) };
    recorded.push({
      ...step,
      status: res.status,
      response,
      ...(headers && { headers }),
    });
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
    now: area.now,
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
