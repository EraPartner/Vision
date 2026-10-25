#!/usr/bin/env bun
import fs from "node:fs";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  camelCase,
  generatedHeader,
  parseListFile,
  parseYaml,
  pascalCase,
  repoPath,
  swiftIdentifier,
  swiftString,
  writeGenerated,
} from "./lib/nativeCodegen.ts";

/**
 * Generates Vision Native's OpenAPI layer (ADR-204 phase 2): Codable models
 * for the schemas the allow-listed operations reference and one operation
 * struct per allow-listed operationId, from openapi.yaml.
 *
 *   bun run native:generate-api
 *
 * Only the operations in apps/native/openapi-operations.txt are generated, so
 * the Swift surface grows with the native screens. The output is a pure
 * function of openapi.yaml and the allow-list; CI regenerates it and fails on
 * a diff.
 */

export const ALLOW_LIST = "apps/native/openapi-operations.txt";
export const OUTPUT_DIR = "apps/native/Sources/VisionNativeCore/API/Generated";
const COMMAND = "native:generate-api";
const SOURCE = "scripts/native-openapi.ts from openapi.yaml";
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
/** The ADR-026 envelope and its error; the client decodes every response with them. */
const ALWAYS_GENERATED = ["Envelope", "ErrorPayload"];

/*
 * Typed identifiers (WP-1). Every entity id gets its own Swift type, `<Entity>ID`
 * (`IntIdentifier<Tag>` / `StringIdentifier<Tag>` in API/Types/Identifier.swift).
 * An `id` property belongs to the entity named after its schema; an `xId` / `x_id`
 * property or parameter belongs to the entity its stem names (the last words of a
 * stem are tried too, so `fromAccountId` and `ancestor_category_id` need no entry).
 * The tables below carry only the irregular names. An id-like integer or string
 * field that no rule maps, and that UNTYPED_IDS does not list with a reason, fails
 * generation.
 */

/** Schemas whose `id` identifies an entity other than the schema's own name. */
export const SCHEMA_ID_ENTITY: Record<string, string> = {
  AnalysisColumnRef: "AnalysisColumn",
  BelgianPortfolioTaxInvestmentCosts: "Investment",
  BelgianPortfolioTaxSummary: "Investment",
  BelgianTaxInputPartnerActivity: "TaxPartnerActivity",
  BelgianTaxInputRelationshipEvent: "TaxRelationshipEvent",
  CategoryNode: "Category",
  PortfolioSummaryItem: "Investment",
  ResearchDossierSummary: "ResearchDossier",
  SplitOwedDetail: "Split",
  TransactionTagRef: "Tag",
};

/** Entities a `xId` stem names when the stem is not itself an entity name. */
export const STEM_ENTITY: Record<string, string> = {
  Activity: "TaxPartnerActivity",
  AnalysisRun: "AnalysisRun",
  Conversation: "AiConversation",
  Document: "ResearchDocument",
  Dossier: "ResearchDossier",
  Monitor: "AnalysisMonitor",
  Observation: "AnalysisMonitorObservation",
  Pattern: "RecipientPattern",
  RecipientGroup: "RecipientGroup",
  SavedAnalysis: "SavedAnalysis",
  Txn: "PortfolioTransaction",
};

/**
 * Per-field entity overrides, keyed `Schema.field`, `Schema.Nested.field`,
 * `Operation.field` or `*.field` (nested struct names as generated). Checked
 * before the stem rules.
 */
export const FIELD_ENTITY: Record<string, string> = {
  "*.transfer_peer_id": "Transaction",
  "AccountTotals.AccountsItem.id": "Account",
  "AnalysisVisualPlan.OrderByItem.id": "AnalysisColumn",
  "CategoryNode.parentId": "Category",
  "CategoryNode.pathIds": "Category",
  "CategoryNodeCreate.parentId": "Category",
  "CategoryNodeUpdate.parentId": "Category",
  "CategoryPivotData.CategoryPivotValueItem.categoryPathIds": "Category",
  "CreateCategory.ResponseData.id": "Category",
  "CreateRecipient.ResponseData.id": "Recipient",
  "CreateRecipientPattern.ResponseData.id": "RecipientPattern",
  "CreateTag.ResponseData.id": "Tag",
  "EvaluateAnalysisExtension.Body.outcomeId": "AnalysisColumn",
  "EvaluateAnalysisExtension.Body.variableId": "AnalysisColumn",
  "GetPlannedMatchSuggestions.ResponseData.ItemsItem.CandidatesItem.id":
    "Transaction",
  "GetPlannedMatchSuggestions.ResponseData.ItemsItem.Planned.id":
    "PlannedTransaction",
  "MarkTransfer.Body.aId": "Transaction",
  "MarkTransfer.Body.bId": "Transaction",
  "MergeAccounts.Body.source_ids": "Account",
  "MergeCategoryNode.Body.targetId": "Category",
  "MergeRecipient.Body.alias_ids": "Recipient",
  // The spec serializes import batch ids as BIGINT strings on the batch itself (and in
  // paths) but as numbers wherever a batch is referenced from a portfolio import payload.
  // They are two wire shapes, so two types: `ImportBatchID` / `PortfolioImportBatchID`
  // (strings) and the `...NumericID` ones (numbers).
  "PortfolioImportPreviewData.batch_id": "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationCommitResult.BatchesItem.batch_id":
    "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationPlan.ActionsItem.batchId":
    "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationPlan.ActionsItem.duplicateOfRowId":
    "PortfolioImportRow",
  "PortfolioImportReconciliationPlan.ActionsItem.rowId": "PortfolioImportRow",
  "PortfolioImportReconciliationPlan.BatchPoliciesItem.batchId":
    "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationPlan.RowChoicesItem.batchId":
    "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationPlan.RowChoicesItem.rowId":
    "PortfolioImportRow",
  "PortfolioImportReconciliationPlan.batchIds": "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationRequest.BatchPoliciesItem.batch_id":
    "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationRequest.RowChoicesItem.batch_id":
    "PortfolioImportBatchNumeric",
  "PortfolioImportReconciliationRequest.RowChoicesItem.row_id":
    "PortfolioImportRow",
  "PortfolioImportReconciliationRequest.batch_ids":
    "PortfolioImportBatchNumeric",
  "PortfolioSummaryData.ArchivedInKindIncomeItem.id": "Investment",
  "PortfolioTransaction.import_batch_id": "PortfolioImportBatch",
  "ReconcileAccount.ResponseData.Transaction.id": "Transaction",
  "ResearchDossierExport.DossiersItem.id": "ResearchDossier",
};

/**
 * Path parameters whose entity is not the singular of the segment before them
 * (`/api/accounts/{id}` needs no entry). The longest matching path prefix wins.
 */
export const PATH_ID_ENTITY: { prefix: string; param: string; entity: string }[] =
  [
    { prefix: "/api/ai-research/documents/{id}", param: "id", entity: "ResearchDocument" },
    { prefix: "/api/ai-research/investigations/{id}", param: "id", entity: "AiInvestigation" },
    { prefix: "/api/ai/conversations/{id}", param: "id", entity: "AiConversation" },
    { prefix: "/api/analysis/monitors/notifications/{id}", param: "id", entity: "AnalysisMonitorNotification" },
    { prefix: "/api/analysis/monitors/{id}", param: "id", entity: "AnalysisMonitor" },
    { prefix: "/api/analysis/saved/{id}", param: "id", entity: "SavedAnalysis" },
    { prefix: "/api/categories/tree/{id}", param: "id", entity: "Category" },
    { prefix: "/api/import/batches/{id}", param: "id", entity: "ImportBatch" },
    { prefix: "/api/import/batches/{id}/rows/{rowId}", param: "rowId", entity: "ImportRow" },
    { prefix: "/api/import/parsers/{id}", param: "id", entity: "CustomParserConfig" },
    { prefix: "/api/portfolio/import/batches/{id}", param: "id", entity: "PortfolioImportBatch" },
    { prefix: "/api/portfolio/import/batches/{id}/rows/{rowId}", param: "rowId", entity: "PortfolioImportRow" },
    { prefix: "/api/portfolio/import/parsers/{id}", param: "id", entity: "PortfolioParserConfig" },
    { prefix: "/api/recipients/{id}/bank-accounts/{accountId}", param: "accountId", entity: "RecipientBankAccount" },
    { prefix: "/api/research/mappings/{id}", param: "id", entity: "InstrumentProviderMapping" },
    { prefix: "/api/splits/owed/{id}", param: "id", entity: "Recipient" },
    { prefix: "/api/watchlist/{id}", param: "id", entity: "WatchlistItem" },
  ];

/**
 * Id-like integer/string fields that deliberately stay plain, each with its
 * reason. Keys as in FIELD_ENTITY. A stale entry (matching nothing) fails the
 * generator test.
 */
export const UNTYPED_IDS: Record<string, string> = {
  "*.account_ids":
    "Comma-separated query string of account ids (wire format), not an array.",
  "*.category_ids":
    "Comma-separated query string of category ids (wire format), not an array.",
  "*.investment_ids":
    "Comma-separated query string of investment ids (wire format), not an array.",
  "*.datasetId": "Analysis dataset catalog key (a fixed code), not a stored entity.",
  "*.fieldId": "Analysis dataset field catalog key (a fixed code), not a stored entity.",
  "*.historicalId":
    "Snapshot of a reference to an entity that may no longer exist; the kind varies per row.",
  "*.historicalTargetId":
    "Snapshot of a reference to an entity that may no longer exist; the kind varies per row.",
  "*.issuerId": "Exposure issuer grouping key derived from instrument data, not a stored entity.",
  "*.methodId": "Cash forecast method code from a fixed catalog, not a stored entity.",
  "*.price_provider_id":
    "The market data provider's own symbol or code for the instrument, not a Vision entity.",
  "*.requestId":
    "Client-generated correlation token for an in-flight request, not a stored entity.",
  "*.seriesId": "Macro data series code of the research provider, not a stored entity.",
  "*.series_id": "Macro data series code of the research provider, not a stored entity.",
  "BelgianTaxDashboard.SuggestionsItem.id":
    "Static tax suggestion catalog key (pairs with i18n keys), not a stored entity.",
  "PortfolioExposureDimension.RowsItem.id":
    "Exposure bucket key (a dimension value such as a sector), not a stored entity.",
};

/**
 * Request-body fields that must be able to send an explicit `null` (clear the
 * stored value), keyed by the body struct (`Schema` or `Operation.Body`). Only
 * fields the web frontend demonstrably sends as `null` (apps/frontend callers) are
 * listed; every other nullable PATCH field stays `T?`.
 */
export const NULLABLE_PATCH_FIELDS: Record<string, string[]> = {
  // accountFormMapping.ts: an edit sends `display_name: null` / `institution: null` to clear.
  AccountUpdate: ["display_name", "institution"],
  // TransactionsPage.tsx: "Explicit null clears the category / recipient on the backend".
  TransactionUpdate: ["category_id", "recipient_id"],
  // CategoryNodeDialog.tsx sends `parentId` (null = root) and `description || null`.
  CategoryNodeUpdate: ["parentId", "description"],
  // useImportReviewData.tsx persists `default_category_id: null` to clear the default.
  RecipientUpdate: ["default_category_id"],
  // plannedPaymentMapper.ts: null clears the end date / max count.
  "UpdatePlannedTransaction.Body": ["recurrence_end_date", "max_occurrences"],
  // CustomChartBuilderModal.tsx sends `dateRangeStart || null` / `dateRangeEnd || null`.
  "UpdateSavedChart.Body": ["dateRangeStart", "dateRangeEnd"],
  // RecipientPatternsDialog.tsx: "null clears an existing note on PATCH".
  "UpdateRecipientPattern.Body": ["notes"],
  // EditPortfolioTxnDialog.tsx: cleared note / FX rate / account / end date are explicit null.
  "UpdatePortfolioTransaction.Body": [
    "fx_rate_to_eur",
    "account_id",
    "note",
    "recurrence_end_date",
  ],
};

type IdKind = "int" | "string";

/** The override tables the generator reads; tests pass their own around a toy spec. */
export interface GeneratorTables {
  schemaIdEntity: Record<string, string>;
  stemEntity: Record<string, string>;
  fieldEntity: Record<string, string>;
  pathIdEntity: { prefix: string; param: string; entity: string }[];
  untypedIds: Record<string, string>;
  nullablePatchFields: Record<string, string[]>;
}

export const DEFAULT_TABLES: GeneratorTables = {
  schemaIdEntity: SCHEMA_ID_ENTITY,
  stemEntity: STEM_ENTITY,
  fieldEntity: FIELD_ENTITY,
  pathIdEntity: PATH_ID_ENTITY,
  untypedIds: UNTYPED_IDS,
  nullablePatchFields: NULLABLE_PATCH_FIELDS,
};

export interface GenerationStats {
  /** Entity id types emitted. */
  identifierTypes: number;
  /** Model fields and operation parameters typed with an identifier. */
  identifierFields: number;
  enumsNamed: number;
  enumsInline: number;
  currencyFields: number;
  nullableFields: number;
  /** Keys of UNTYPED_IDS that matched a field. */
  untypedIdsHit: string[];
  /** Keys of NULLABLE_PATCH_FIELDS entries that matched a field (`Struct.field`). */
  nullableFieldsHit: string[];
}

type Schema = { [key: string]: unknown };

interface Spec {
  paths: Record<string, Schema>;
  components: {
    schemas: Record<string, Schema>;
    parameters?: Record<string, Schema>;
  };
}

interface Operation {
  id: string;
  method: string;
  path: string;
  summary: string | undefined;
  parameters: Schema[];
  requestBody: Schema | undefined;
  responses: Record<string, Schema>;
}

export interface GeneratedAPI {
  models: string;
  operations: string;
  identifiers: string;
  /** The component schemas emitted as Swift models (struct, enum or typealias), sorted. */
  schemas: string[];
  stats: GenerationStats;
}

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(schema: Schema, key: string): string | undefined {
  const value = schema[key];
  return typeof value === "string" ? value : undefined;
}

function refName(ref: string, kind: "schemas" | "parameters"): string {
  const prefix = `#/components/${kind}/`;
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported $ref ${ref}.`);
  return ref.slice(prefix.length);
}

/** `///` lines for a description, wrapped at 100 columns. */
function docLines(text: string | undefined, indent: string): string[] {
  if (!text) return [];
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && indent.length + 4 + line.length + 1 + word.length > 100) {
      lines.push(`${indent}/// ${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(`${indent}/// ${line}`);
  return lines;
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

/** `account_ids` -> stem `account`, plural; `id` -> empty stem; not id-like -> undefined. */
export function identifierStem(
  wire: string,
): { stem: string; plural: boolean } | undefined {
  if (wire === "id") return { stem: "", plural: false };
  const match = /^(.+?)(_ids?|Ids?)$/.exec(wire);
  if (!match) return undefined;
  return { stem: match[1] ?? "", plural: (match[2] ?? "").endsWith("s") };
}

/** `batches` -> `batch`, `categories` -> `category`, `tags` -> `tag`. */
function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Currency fields: names ending in currency/currencies, or the `^[A-Z]{3}$` pattern. */
export function isCurrencyField(wire: string, schema: Schema): boolean {
  const target =
    schema.type === "array" && isObject(schema.items) ? schema.items : schema;
  if (target.type !== "string" || Array.isArray(target.enum)) return false;
  if (target.pattern === "^[A-Z]{3}$") return true;
  return /(?:^|[_-])(?:currency|currencies)$|(?:Currency|Currencies)$/.test(
    wire,
  );
}

const RESERVED_TYPE_NAMES = new Set([
  "Type",
  "Protocol",
  "Self",
  "Any",
  "String",
  "Int",
  "Bool",
  "Decimal",
  "Data",
  "Date",
  "URL",
  "Array",
  "Optional",
  "Dictionary",
  "JSONValue",
  "CurrencyCode",
  "Nullable",
  "OpenAPI",
]);

const RESERVED_CASES = new Set([
  "unknown",
  "rawValue",
  "allCases",
  "allKnownCases",
  "hashValue",
  "init",
]);

/** Swift case names for enum values, unique and clear of the generated members. */
export function enumCases(values: string[]): { name: string; value: string }[] {
  const used = new Set<string>(RESERVED_CASES);
  return values.map((value, index) => {
    let name: string;
    try {
      name = camelCase(value);
    } catch {
      name = `value${index}`;
    }
    if (RESERVED_CASES.has(name)) name = `${name}Value`;
    while (used.has(name)) name = `${name}Value`;
    used.add(name);
    return { name: swiftIdentifier(name), value };
  });
}

/** The Swift for an enum whose unknown raw values decode to `.unknown(raw)`. */
function enumDeclaration(
  name: string,
  values: string[],
  description: string | undefined,
  indent = "",
): string {
  const cases = enumCases(values);
  const lines: string[] = [...docLines(description, "")];
  lines.push(
    "/// A value this client does not know decodes to `.unknown` and encodes back unchanged.",
    `public enum ${name}: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {`,
  );
  for (const item of cases) lines.push(`    case ${item.name}`);
  lines.push(
    "    case unknown(String)",
    "",
    `    public static var allKnownCases: [${name}] {`,
    `        [${cases.map((item) => `.${item.name}`).join(", ")}]`,
    "    }",
    "",
    `    public static var allCases: [${name}] { allKnownCases }`,
    "",
    "    public init(rawValue: String) {",
    "        switch rawValue {",
  );
  for (const item of cases)
    lines.push(
      `        case ${swiftString(item.value)}: self = .${item.name}`,
    );
  lines.push(
    "        default: self = .unknown(rawValue)",
    "        }",
    "    }",
    "",
    "    public var rawValue: String {",
    "        switch self {",
  );
  for (const item of cases)
    lines.push(`        case .${item.name}: return ${swiftString(item.value)}`);
  lines.push(
    "        case .unknown(let value): return value",
    "        }",
    "    }",
    "",
    "    public init(from decoder: any Decoder) throws {",
    "        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))",
    "    }",
    "",
    "    public func encode(to encoder: any Encoder) throws {",
    "        var container = encoder.singleValueContainer()",
    "        try container.encode(rawValue)",
    "    }",
    "}",
  );
  return indent ? indentBlock(lines.join("\n"), indent) : lines.join("\n");
}

interface TypeOptions {
  /** Keep string enums as `String` (request parameters accept only what the server lists). */
  plainStrings?: boolean;
}

class Generator {
  private readonly required = new Set<string>(ALWAYS_GENERATED);
  private readonly pending = [...ALWAYS_GENERATED];

  private readonly spec: Spec;
  private readonly tables: GeneratorTables;

  /** The struct names being generated, outermost first (the context of a field). */
  private readonly context: string[] = [];
  /** Entity -> wire kinds seen: from every schema `id` up front, then from each use. */
  private readonly entities = new Map<string, Set<IdKind>>();
  private readonly schemaEntities = new Set<string>();
  private readonly nestedNames = new WeakMap<string[], Set<string>>();
  readonly unmappedIds = new Set<string>();
  readonly untypedHits = new Set<string>();
  readonly nullableHits = new Set<string>();
  readonly stats = {
    identifierFields: 0,
    enumsNamed: 0,
    enumsInline: 0,
    currencyFields: 0,
    nullableFields: 0,
  };

  constructor(spec: Spec, tables: GeneratorTables) {
    this.spec = spec;
    this.tables = tables;
    for (const [name, raw] of Object.entries(spec.components.schemas)) {
      if (!isObject(raw)) continue;
      const properties = isObject(raw.properties)
        ? raw.properties
        : Array.isArray(raw.allOf)
          ? this.mergeAllOf(raw.allOf).properties
          : undefined;
      const id = properties && isObject(properties.id) ? properties.id : undefined;
      const shape = id ? this.idShape(id) : undefined;
      if (!shape || shape.array) continue;
      const entity = this.tables.schemaIdEntity[name] ?? name;
      this.schemaEntities.add(name);
      this.register(entity, shape.kind);
    }
  }

  /** Where each entity was first seen with each wire kind, for conflict messages. */
  private readonly firstSeen = new Map<string, string>();

  private register(entity: string, kind: IdKind, where = "schema id"): void {
    const kinds = this.entities.get(entity) ?? new Set<IdKind>();
    kinds.add(kind);
    this.entities.set(entity, kinds);
    const key = `${entity}:${kind}`;
    if (!this.firstSeen.has(key)) this.firstSeen.set(key, where);
  }

  /** `int` / `string` and whether it is an array, for an id-shaped schema. */
  private idShape(schema: Schema): { kind: IdKind; array: boolean } | undefined {
    let current: Schema = schema;
    let array = false;
    for (let depth = 0; depth < 4; depth++) {
      const ref = stringField(current, "$ref");
      if (ref) {
        current = this.schema(refName(ref, "schemas"));
        continue;
      }
      if (!array && current.type === "array" && isObject(current.items)) {
        array = true;
        current = current.items;
        continue;
      }
      break;
    }
    if (current.type === "integer") return { kind: "int", array };
    if (current.type === "string" && !Array.isArray(current.enum))
      return { kind: "string", array };
    return undefined;
  }

  /** The entity a `xId` stem names, trying shorter word suffixes of the stem. */
  private entityForStem(stem: string): string | undefined {
    const words = pascalCase(stem).match(/[A-Z][a-z0-9]*/g) ?? [];
    for (let index = 0; index < words.length; index++) {
      const candidate = words.slice(index).join("");
      const mapped =
        this.tables.stemEntity[candidate] ??
        (this.entities.has(candidate) ? candidate : undefined);
      if (mapped) return mapped;
    }
    return undefined;
  }

  /**
   * The identifier type of an id-like integer/string field or parameter, or
   * undefined when it is not id-like, is deliberately untyped, or is unmapped
   * (recorded in `unmappedIds`). `explicit` is a path-derived entity.
   */
  private identifierType(
    wire: string,
    schema: Schema,
    scope: string[],
    explicit?: string,
    inUrl = false,
  ): string | undefined {
    const stem = identifierStem(wire);
    if (!stem) return undefined;
    const shape = this.idShape(schema);
    if (!shape) return undefined;
    const keys = [`${scope.join(".")}.${wire}`, `${scope[0]}.${wire}`, `*.${wire}`];
    let entity = explicit ?? keys.map((key) => this.tables.fieldEntity[key]).find(Boolean);
    if (!entity) {
      const untyped = keys.find((key) => this.tables.untypedIds[key] !== undefined);
      if (untyped) {
        this.untypedHits.add(untyped);
        return undefined;
      }
      // A plural name must be an array and a singular one a scalar; anything else
      // (a comma-separated string of ids) needs an explicit decision.
      if (stem.plural === shape.array) {
        if (stem.stem === "") {
          const root = scope[0] ?? "";
          if (scope.length === 1 && this.schemaEntities.has(root))
            entity = this.tables.schemaIdEntity[root] ?? root;
        } else {
          entity = this.entityForStem(stem.stem);
        }
      }
    }
    if (!entity) {
      this.unmappedIds.add(keys[0] ?? wire);
      return undefined;
    }
    // A URL carries the id as text, so a parameter the spec types differently from the
    // entity's own schema id (a path `integer` for an `Attachment` string id) follows the entity.
    if (!(inUrl && this.entities.has(entity)))
      this.register(entity, shape.kind, keys[0]);
    this.stats.identifierFields++;
    const type = `${entity}ID`;
    return shape.array ? `[${type}]` : type;
  }

  /** The entity of a path parameter: a table entry, else the singular of the segment before it. */
  private pathEntity(operation: Operation, name: string): string | undefined {
    const template = operation.path;
    const marker = `{${name}}`;
    const at = template.indexOf(marker);
    if (at < 0) return undefined;
    const upto = template.slice(0, at + marker.length);
    const entry = this.tables.pathIdEntity.filter(
      (item) => item.param === name && upto.startsWith(item.prefix),
    ).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (entry) return entry.entity;
    if (name !== "id") return undefined;
    const segment = upto
      .slice(0, at)
      .split("/")
      .filter(Boolean)
      .pop();
    if (!segment || segment.startsWith("{")) return undefined;
    const candidate = pascalCase(singular(segment));
    return this.entities.has(candidate) ? candidate : undefined;
  }

  /** Entities and their wire kind, for the identifier file. */
  identifierEntities(): [string, IdKind][] {
    const result: [string, IdKind][] = [];
    for (const [entity, kinds] of [...this.entities].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (kinds.size > 1) {
        throw new Error(
          `${entity} is both an integer (${this.firstSeen.get(`${entity}:int`)}) and a string (${this.firstSeen.get(`${entity}:string`)}) id on the wire; give one a distinct entity in FIELD_ENTITY / SCHEMA_ID_ENTITY.`,
        );
      }
      if (this.spec.components.schemas[`${entity}ID`] !== undefined) {
        throw new Error(`${entity}ID collides with a schema name.`);
      }
      result.push([entity, [...kinds][0] ?? "int"]);
    }
    return result;
  }

  /** A nested type name not yet used in this scope (collisions get a numeric suffix). */
  private nestedName(
    nested: string[],
    base: string,
    kind: "struct" | "enum" = "struct",
  ): string {
    const used = this.nestedNames.get(nested) ?? new Set<string>();
    this.nestedNames.set(nested, used);
    // `Type` and `Protocol` would read as metatypes, and a nested type named like a
    // Foundation or generated type would shadow it inside the struct.
    // Nested structs keep their historical names (`Data` shadows Foundation's inside the
    // envelope structs that already declared it); new enums avoid shadowing at all.
    const reserved =
      kind === "enum"
        ? RESERVED_TYPE_NAMES.has(base)
        : ["Type", "Protocol", "Self"].includes(base);
    const first = reserved
      ? `${this.context[this.context.length - 1] ?? ""}${base}`
      : base;
    let name = first;
    for (let index = 2; used.has(name); index++) name = `${first}${index}`;
    used.add(name);
    return name;
  }

  schema(name: string): Schema {
    const schema = this.spec.components.schemas[name];
    if (!isObject(schema)) throw new Error(`Unknown schema ${name}.`);
    return schema;
  }

  private requireSchema(name: string): void {
    this.schema(name);
    if (this.required.has(name)) return;
    this.required.add(name);
    this.pending.push(name);
  }

  /** The Swift type of a schema; inline objects become nested structs in `nested`. */
  typeFor(
    schema: unknown,
    hint: string,
    nested: string[],
    options: TypeOptions = {},
  ): string {
    if (!isObject(schema) || Object.keys(schema).length === 0)
      return "JSONValue";
    const ref = stringField(schema, "$ref");
    if (ref) {
      const name = refName(ref, "schemas");
      this.requireSchema(name);
      return `OpenAPI.${name}`;
    }
    if (schema.oneOf !== undefined || schema.anyOf !== undefined)
      return "JSONValue";
    if (Array.isArray(schema.allOf)) {
      // `allOf: [$ref]` with `nullable: true` is OpenAPI 3.0's nullable reference: the
      // referenced type itself (an enum would otherwise become an empty struct).
      if (schema.allOf.length === 1 && isObject(schema.allOf[0])) {
        const only = stringField(schema.allOf[0], "$ref");
        if (only) return this.typeFor(schema.allOf[0], hint, nested, options);
      }
      const merged = this.mergeAllOf(schema.allOf);
      const name = this.nestedName(nested, pascalCase(hint));
      nested.push(
        this.struct(name, merged.properties, merged.required, undefined),
      );
      return name;
    }
    switch (schema.type) {
      case "string": {
        const values = Array.isArray(schema.enum)
          ? schema.enum.filter((value) => typeof value === "string")
          : [];
        if (options.plainStrings || values.length === 0) return "String";
        const name = this.nestedName(nested, pascalCase(hint), "enum");
        this.stats.enumsInline++;
        nested.push(
          enumDeclaration(name, values.map(String), stringField(schema, "description")),
        );
        return name;
      }
      case "integer":
        return "Int";
      case "number":
        // Money and rates are Decimal, never Double (ADR-204 decision 8).
        return "Decimal";
      case "boolean":
        return "Bool";
      case "array":
        return `[${this.typeFor(schema.items, `${hint}Item`, nested, options)}]`;
      default: {
        const properties = isObject(schema.properties)
          ? schema.properties
          : undefined;
        if (properties && Object.keys(properties).length > 0) {
          const name = this.nestedName(nested, pascalCase(hint));
          const required = Array.isArray(schema.required)
            ? schema.required.map(String)
            : [];
          nested.push(this.struct(name, properties, required, undefined));
          return name;
        }
        if (isObject(schema.additionalProperties)) {
          const value = this.typeFor(
            schema.additionalProperties,
            `${hint}Value`,
            nested,
            options,
          );
          return `[String: ${value}]`;
        }
        return "JSONValue";
      }
    }
  }

  private mergeAllOf(parts: unknown[]): {
    properties: Schema;
    required: string[];
  } {
    const properties: Schema = {};
    const required = new Set<string>();
    for (const part of parts) {
      if (!isObject(part)) continue;
      const ref = stringField(part, "$ref");
      const resolved = ref ? this.schema(refName(ref, "schemas")) : part;
      if (Array.isArray(resolved.allOf)) {
        const inner = this.mergeAllOf(resolved.allOf);
        Object.assign(properties, inner.properties);
        inner.required.forEach((key) => required.add(key));
        continue;
      }
      if (isObject(resolved.properties))
        Object.assign(properties, resolved.properties);
      if (Array.isArray(resolved.required))
        resolved.required.forEach((key) => required.add(String(key)));
    }
    return { properties, required: [...required] };
  }

  /** A Codable struct with a public memberwise init and explicit coding keys. */
  struct(
    name: string,
    properties: Schema,
    required: string[],
    description: string | undefined,
  ): string {
    this.context.push(name);
    try {
      return this.structBody(name, properties, required, description);
    } finally {
      this.context.pop();
    }
  }

  private structBody(
    name: string,
    properties: Schema,
    required: string[],
    description: string | undefined,
  ): string {
    const nested: string[] = [];
    const nameCounts = new Map<string, number>();
    for (const wire of Object.keys(properties)) {
      const name = camelCase(wire);
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const scope = [...this.context];
    const patchKey = scope.join(".");
    const nullable = new Set(this.tables.nullablePatchFields[patchKey] ?? []);
    const usedNames = new Set<string>();
    const fields = Object.entries(properties).map(([wire, raw]) => {
      const schema = isObject(raw) ? raw : {};
      const camel = camelCase(wire);
      // Some compatibility responses carry both snake_case and camelCase aliases.
      // Retain each wire spelling when camelization would collapse two real fields.
      const name = (nameCounts.get(camel) ?? 0) > 1 ? wire : camel;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || usedNames.has(name)) {
        throw new Error(
          `${name}: response field names cannot be represented uniquely in Swift.`,
        );
      }
      usedNames.add(name);
      const swiftName = swiftIdentifier(name);
      let base = this.identifierType(wire, schema, scope);
      if (base === undefined && isCurrencyField(wire, schema)) {
        base = schema.type === "array" ? "[CurrencyCode]" : "CurrencyCode";
        this.stats.currencyFields++;
      }
      base ??= this.typeFor(schema, wire, nested);
      let optional = !required.includes(wire) || schema.nullable === true;
      let type = optional ? `${base}?` : base;
      const patchable = nullable.has(wire);
      if (patchable) {
        if (schema.nullable !== true) {
          throw new Error(
            `${patchKey}.${wire} is listed in NULLABLE_PATCH_FIELDS but is not nullable in openapi.yaml.`,
          );
        }
        this.nullableHits.add(`${patchKey}.${wire}`);
        this.stats.nullableFields++;
        type = `Nullable<${base}>`;
        optional = false;
      }
      return {
        wire,
        swiftName,
        plainName: swiftName.replace(/`/g, ""),
        base,
        type,
        optional,
        patchable,
        required: required.includes(wire),
        description: stringField(schema, "description"),
      };
    });
    for (const wire of nullable) {
      if (!(wire in properties)) {
        throw new Error(
          `${patchKey}.${wire} is listed in NULLABLE_PATCH_FIELDS but is not a property.`,
        );
      }
    }
    const lines: string[] = [...docLines(description, "")];
    lines.push(`public struct ${name}: Codable, Equatable, Sendable {`);
    for (const field of fields) {
      lines.push(...docLines(field.description, "    "));
      lines.push(`    public let ${field.swiftName}: ${field.type}`);
    }
    if (fields.length > 0) lines.push("");
    const parameters = fields
      .map(
        (field) =>
          `${field.swiftName}: ${field.type}${field.patchable ? " = .absent" : field.optional ? " = nil" : ""}`,
      )
      .join(", ");
    lines.push(`    public init(${parameters}) {`);
    for (const field of fields)
      lines.push(`        self.${field.plainName} = ${field.swiftName}`);
    lines.push("    }");
    if (fields.length > 0) {
      lines.push("", "    enum CodingKeys: String, CodingKey {");
      for (const field of fields)
        lines.push(
          `        case ${field.swiftName} = ${swiftString(field.wire)}`,
        );
      lines.push("    }");
    }
    if (fields.some((field) => field.patchable)) {
      // Synthesized Codable cannot tell an absent key from an explicit null.
      lines.push(
        "",
        "    public init(from decoder: any Decoder) throws {",
        "        let container = try decoder.container(keyedBy: CodingKeys.self)",
      );
      for (const field of fields) {
        const key = `forKey: .${field.swiftName}`;
        if (field.patchable) {
          lines.push(
            `        self.${field.plainName} = try container.decodeNullable(${field.base}.self, ${key})`,
          );
        } else if (field.optional) {
          lines.push(
            `        self.${field.plainName} = try container.decodeIfPresent(${field.type.slice(0, -1)}.self, ${key})`,
          );
        } else {
          lines.push(
            `        self.${field.plainName} = try container.decode(${field.type}.self, ${key})`,
          );
        }
      }
      lines.push(
        "    }",
        "",
        "    public func encode(to encoder: any Encoder) throws {",
        "        var container = encoder.container(keyedBy: CodingKeys.self)",
      );
      for (const field of fields) {
        const key = `forKey: .${field.swiftName}`;
        lines.push(
          field.patchable
            ? `        try container.encodeNullable(${field.plainName}, ${key})`
            : field.optional
              ? `        try container.encodeIfPresent(${field.plainName}, ${key})`
              : `        try container.encode(${field.plainName}, ${key})`,
        );
      }
      lines.push("    }");
    }
    for (const block of nested) lines.push("", indentBlock(block, "    "));
    lines.push("}");
    return lines.join("\n");
  }

  /** One component schema as a Swift declaration. */
  component(name: string): string {
    const schema = this.schema(name);
    const description = stringField(schema, "description");
    const ref = stringField(schema, "$ref");
    if (ref) {
      const target = refName(ref, "schemas");
      this.requireSchema(target);
      return [
        ...docLines(description, ""),
        `public typealias ${name} = OpenAPI.${target}`,
      ].join("\n");
    }
    if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
      return [
        ...docLines(description, ""),
        "/// A oneOf/anyOf schema, decoded as plain JSON.",
        `public typealias ${name} = JSONValue`,
      ].join("\n");
    }
    if (Array.isArray(schema.allOf)) {
      const merged = this.mergeAllOf(schema.allOf);
      return this.struct(name, merged.properties, merged.required, description);
    }
    if (schema.type === "string" && Array.isArray(schema.enum)) {
      this.stats.enumsNamed++;
      return enumDeclaration(
        name,
        schema.enum.filter((value) => typeof value === "string").map(String),
        description,
      );
    }
    const properties = isObject(schema.properties)
      ? schema.properties
      : undefined;
    if (properties && Object.keys(properties).length > 0) {
      const required = Array.isArray(schema.required)
        ? schema.required.map(String)
        : [];
      return this.struct(name, properties, required, description);
    }
    const nested: string[] = [];
    const type = this.typeFor(
      { ...schema, description: undefined },
      name,
      nested,
    );
    if (nested.length > 0)
      throw new Error(`Schema ${name} needs a nested type at the top level.`);
    return [
      ...docLines(description, ""),
      `public typealias ${name} = ${type}`,
    ].join("\n");
  }

  operation(id: string): Operation {
    for (const [path, rawItem] of Object.entries(this.spec.paths)) {
      if (!isObject(rawItem)) continue;
      for (const method of METHODS) {
        const operation = rawItem[method];
        if (!isObject(operation) || operation.operationId !== id) continue;
        const shared = Array.isArray(rawItem.parameters)
          ? rawItem.parameters
          : [];
        const own = Array.isArray(operation.parameters)
          ? operation.parameters
          : [];
        const byKey = new Map<string, Schema>();
        for (const raw of [...shared, ...own]) {
          const parameter = this.parameter(raw);
          byKey.set(
            `${String(parameter.in)}:${String(parameter.name)}`,
            parameter,
          );
        }
        return {
          id,
          method,
          path,
          summary: stringField(operation, "summary"),
          parameters: [...byKey.values()],
          requestBody: isObject(operation.requestBody)
            ? operation.requestBody
            : undefined,
          responses: isObject(operation.responses)
            ? (operation.responses as Record<string, Schema>)
            : {},
        };
      }
    }
    throw new Error(`operationId ${id} is not in openapi.yaml.`);
  }

  private parameter(raw: unknown): Schema {
    if (!isObject(raw)) throw new Error("Malformed parameter.");
    const ref = stringField(raw, "$ref");
    if (!ref) return raw;
    const parameter =
      this.spec.components.parameters?.[refName(ref, "parameters")];
    if (!isObject(parameter)) throw new Error(`Unknown parameter ${ref}.`);
    return parameter;
  }

  /**
   * The type the client returns: the envelope's `data` when the response is
   * `allOf: [Envelope, { data }]`, plain JSON for a bare Envelope, and nothing
   * for a response without a JSON body.
   */
  responseType(operation: Operation, nested: string[]): string {
    const codes = Object.keys(operation.responses)
      .filter((code) => /^2\d\d$/.test(code))
      .sort();
    const code = codes[0];
    if (code === undefined)
      throw new Error(`${operation.id} has no 2xx response.`);
    const response = operation.responses[code];
    const content = isObject(response?.content) ? response.content : undefined;
    const media =
      content && isObject(content["application/json"])
        ? content["application/json"]
        : undefined;
    const schema = media && isObject(media.schema) ? media.schema : undefined;
    if (!schema) return "APIEmpty";
    const isEnvelope = (part: unknown) =>
      isObject(part) && part.$ref === "#/components/schemas/Envelope";
    if (isEnvelope(schema)) return "JSONValue";
    if (Array.isArray(schema.allOf) && schema.allOf.some(isEnvelope)) {
      const data = schema.allOf
        .filter((part) => !isEnvelope(part))
        .map((part) =>
          isObject(part) && isObject(part.properties)
            ? part.properties.data
            : undefined,
        )
        .find((value) => value !== undefined);
      return data === undefined
        ? "JSONValue"
        : this.typeFor(data, "ResponseData", nested);
    }
    return this.typeFor(schema, "ResponseData", nested);
  }

  operationStruct(operation: Operation): string {
    this.context.push(pascalCase(operation.id));
    try {
      return this.operationStructBody(operation);
    } finally {
      this.context.pop();
    }
  }

  private operationStructBody(operation: Operation): string {
    const name = pascalCase(operation.id);
    const nested: string[] = [];
    const response = this.responseType(operation, nested);
    const pathParameters = operation.parameters.filter(
      (parameter) => parameter.in === "path",
    );
    const queryParameters = operation.parameters.filter(
      (parameter) => parameter.in === "query",
    );
    const unsupported = operation.parameters.filter(
      (parameter) => parameter.in !== "path" && parameter.in !== "query",
    );
    if (unsupported.length > 0) {
      throw new Error(
        `${operation.id}: only path and query parameters are generated.`,
      );
    }
    interface Field {
      wire: string;
      name: string;
      type: string;
      optional: boolean;
      array: boolean;
      description: string | undefined;
    }
    const field = (parameter: Schema, forcedRequired: boolean): Field => {
      const wire = String(parameter.name);
      const schema = isObject(parameter.schema) ? parameter.schema : {};
      let base = this.identifierType(
        wire,
        schema,
        [name],
        parameter.in === "path" ? this.pathEntity(operation, wire) : undefined,
        true,
      );
      if (base === undefined && isCurrencyField(wire, schema)) {
        base = schema.type === "array" ? "[CurrencyCode]" : "CurrencyCode";
        this.stats.currencyFields++;
      }
      base ??= this.typeFor(schema, wire, nested, { plainStrings: true });
      if (
        !(
          ["String", "Int", "Decimal", "Bool", "[String]", "[Int]"].includes(
            base,
          ) || /^\[?(?:[A-Za-z]+ID|CurrencyCode)\]?$/.test(base)
        )
      ) {
        throw new Error(
          `${operation.id}: parameter ${wire} has an unsupported type ${base}.`,
        );
      }
      const optional = !(forcedRequired || parameter.required === true);
      return {
        wire,
        name: swiftIdentifier(camelCase(wire)),
        type: optional ? `${base}?` : base,
        optional,
        array: base.startsWith("["),
        description: stringField(parameter, "description"),
      };
    };
    const pathFields = pathParameters.map((parameter) =>
      field(parameter, true),
    );
    const queryFields = queryParameters.map((parameter) =>
      field(parameter, false),
    );
    const fields = [...pathFields, ...queryFields];

    let bodyType: string | undefined;
    let bodyOptional = false;
    if (operation.requestBody) {
      const content = isObject(operation.requestBody.content)
        ? operation.requestBody.content
        : {};
      const media = isObject(content["application/json"])
        ? content["application/json"]
        : undefined;
      if (!media)
        throw new Error(
          `${operation.id}: only JSON request bodies are generated.`,
        );
      bodyType = this.typeFor(media.schema, "Body", nested);
      bodyOptional = operation.requestBody.required !== true;
    }

    const lines: string[] = [
      ...docLines(
        `${operation.method.toUpperCase()} ${operation.path}: ${operation.summary ?? operation.id}`,
        "",
      ),
      `public struct ${name}: APIOperation {`,
      `    public typealias Response = ${response}`,
      `    public static let operationId = ${swiftString(operation.id)}`,
      `    public static let method = HTTPMethod.${operation.method}`,
      `    public static let pathTemplate = ${swiftString(operation.path)}`,
    ];
    if (fields.length > 0 || bodyType) lines.push("");
    for (const item of fields) {
      lines.push(...docLines(item.description, "    "));
      lines.push(`    public var ${item.name}: ${item.type}`);
    }
    if (bodyType)
      lines.push(`    public var body: ${bodyType}${bodyOptional ? "?" : ""}`);
    const initParameters = [
      ...fields.map(
        (item) => `${item.name}: ${item.type}${item.optional ? " = nil" : ""}`,
      ),
      ...(bodyType
        ? [`body: ${bodyType}${bodyOptional ? "? = nil" : ""}`]
        : []),
    ];
    if (initParameters.length === 0) {
      lines.push("", "    public init() {}");
    } else {
      lines.push("", `    public init(${initParameters.join(", ")}) {`);
      for (const item of fields)
        lines.push(
          `        self.${item.name.replace(/`/g, "")} = ${item.name}`,
        );
      if (bodyType) lines.push("        self.body = body");
      lines.push("    }");
    }

    // The path, with each path parameter percent-encoded as one segment.
    let pathExpression = "";
    for (const piece of operation.path.split(/(\{[^}]+\})/)) {
      const match = /^\{([^}]+)\}$/.exec(piece);
      if (!match) {
        pathExpression += swiftString(piece).slice(1, -1);
        continue;
      }
      const item = pathFields.find((candidate) => candidate.wire === match[1]);
      if (!item)
        throw new Error(
          `${operation.id}: path parameter ${match[1]} is not declared.`,
        );
      pathExpression += `\\(APIPath.segment(APIQuery.value(${item.name})))`;
    }
    lines.push("", `    public var path: String { "${pathExpression}" }`);

    if (queryFields.length > 0) {
      lines.push(
        "",
        "    public var queryItems: [URLQueryItem] {",
        "        var items: [URLQueryItem] = []",
      );
      for (const item of queryFields) {
        const append = item.array
          ? `for value in ${item.name} { items.append(URLQueryItem(name: ${swiftString(item.wire)}, value: APIQuery.value(value))) }`
          : `items.append(URLQueryItem(name: ${swiftString(item.wire)}, value: APIQuery.value(${item.name})))`;
        if (item.optional) {
          lines.push(`        if let ${item.name} { ${append} }`);
        } else {
          lines.push(`        ${append}`);
        }
      }
      lines.push("        return items", "    }");
    }
    if (bodyType) {
      lines.push(
        "",
        "    public func encodedBody() throws -> Data? {",
        bodyOptional
          ? "        try body.map { try APIBody.encode($0) }"
          : "        try APIBody.encode(body)",
        "    }",
      );
    }
    for (const block of nested) lines.push("", indentBlock(block, "    "));
    lines.push("}");
    return lines.join("\n");
  }

  /** Emits every required component, including those found while emitting. */
  models(): string[] {
    const emitted = new Map<string, string>();
    while (this.pending.length > 0) {
      const name = this.pending.shift() ?? "";
      if (emitted.has(name)) continue;
      emitted.set(name, this.component(name));
    }
    this.emittedSchemas = [...emitted.keys()].sort();
    return this.emittedSchemas.map((name) => emitted.get(name) ?? "");
  }

  /** Names of the schemas `models()` emitted. */
  emittedSchemas: string[] = [];
}

export function generateAPI(
  specText: string,
  allowListText: string,
  tables: GeneratorTables = DEFAULT_TABLES,
): GeneratedAPI {
  const parsed = parseYaml(specText);
  if (
    !isObject(parsed) ||
    !isObject(parsed.paths) ||
    !isObject(parsed.components)
  ) {
    throw new Error("openapi.yaml must declare paths and components.");
  }
  const spec = parsed as unknown as Spec;
  const ids = parseListFile(allowListText, ALLOW_LIST);
  if (ids.length === 0) throw new Error(`${ALLOW_LIST} lists no operations.`);
  const generator = new Generator(spec, tables);
  const operations = ids.map((id) =>
    generator.operationStruct(generator.operation(id)),
  );
  const models = generator.models();
  if (generator.unmappedIds.size > 0) {
    throw new Error(
      `${generator.unmappedIds.size} id-like integer/string fields have no identifier type. Map each in SCHEMA_ID_ENTITY, STEM_ENTITY, FIELD_ENTITY or PATH_ID_ENTITY, or list it in UNTYPED_IDS with a reason:\n  ${[...generator.unmappedIds].sort().join("\n  ")}`,
    );
  }
  const entities = generator.identifierEntities();

  const modelsFile = [
    generatedHeader(SOURCE, COMMAND),
    "import Foundation",
    "",
    "/// The OpenAPI component schemas the allow-listed operations use",
    `/// (\`${ALLOW_LIST}\`). Dates stay the wire strings; numbers are \`Decimal\`; ids, currencies and`,
    "/// string enums are typed (`OpenAPIIdentifiers.swift`, `CurrencyCode`, enums with `.unknown`).",
    "public enum OpenAPI {}",
    "",
    "extension OpenAPI {",
    models.map((block) => indentBlock(block, "    ")).join("\n\n"),
    "}",
    "",
  ].join("\n");

  const operationsFile = [
    generatedHeader(SOURCE, COMMAND),
    "import Foundation",
    "",
    "/// One struct per operationId in `" + ALLOW_LIST + "`, in its order.",
    "public enum OpenAPIOperations {",
    `    public static let operationIds = [${ids.map(swiftString).join(", ")}]`,
    "}",
    "",
    "extension OpenAPIOperations {",
    operations.map((block) => indentBlock(block, "    ")).join("\n\n"),
    "}",
    "",
  ].join("\n");

  const identifiersFile = [
    generatedHeader(SOURCE, COMMAND),
    "/// One identifier type per entity the OpenAPI spec has ids for (`API/Types/Identifier.swift`",
    "/// holds the generic types). Ids of different entities never convert into one another.",
    entities
      .map(([entity, kind]) =>
        [
          `/// The id of a ${entity} (${kind === "int" ? "an integer" : "a string"} on the wire).`,
          `public enum ${entity}IDTag: IdentifierTag {}`,
          `public typealias ${entity}ID = ${kind === "int" ? "IntIdentifier" : "StringIdentifier"}<${entity}IDTag>`,
        ].join("\n"),
      )
      .join("\n\n"),
    "",
  ].join("\n");

  return {
    models: modelsFile,
    operations: operationsFile,
    identifiers: identifiersFile,
    schemas: generator.emittedSchemas,
    stats: {
      identifierTypes: entities.length,
      identifierFields: generator.stats.identifierFields,
      enumsNamed: generator.stats.enumsNamed,
      enumsInline: generator.stats.enumsInline,
      currencyFields: generator.stats.currencyFields,
      nullableFields: generator.stats.nullableFields,
      untypedIdsHit: [...generator.untypedHits].sort(),
      nullableFieldsHit: [...generator.nullableHits].sort(),
    },
  };
}

function main(): void {
  try {
    const generated = generateAPI(
      fs.readFileSync(repoPath("openapi.yaml"), "utf8"),
      fs.readFileSync(repoPath(ALLOW_LIST), "utf8"),
    );
    writeGenerated(
      repoPath(OUTPUT_DIR, "OpenAPIModels.swift"),
      generated.models,
    );
    writeGenerated(
      repoPath(OUTPUT_DIR, "OpenAPIOperations.swift"),
      generated.operations,
    );
    writeGenerated(
      repoPath(OUTPUT_DIR, "OpenAPIIdentifiers.swift"),
      generated.identifiers,
    );
    const stats = generated.stats;
    console.log(
      `[native-openapi] ${stats.identifierTypes} identifier types on ${stats.identifierFields} fields/parameters; ` +
        `${stats.enumsNamed + stats.enumsInline} enums (${stats.enumsNamed} named, ${stats.enumsInline} inline); ` +
        `${stats.currencyFields} CurrencyCode fields; ${stats.nullableFields} Nullable fields; ` +
        `${stats.untypedIdsHit.length} untyped id rules used.`,
    );
  } catch (error) {
    console.error(
      `[native-openapi] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) main();
