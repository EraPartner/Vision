import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  camelCase,
  parseListFile,
  pascalCase,
  repoPath,
  swiftIdentifier,
  swiftString,
} from "../lib/nativeCodegen.ts";
import {
  ALLOW_LIST,
  FIELD_ENTITY,
  type GeneratorTables,
  NULLABLE_PATCH_FIELDS,
  PATH_ID_ENTITY,
  SCHEMA_ID_ENTITY,
  STEM_ENTITY,
  UNTYPED_IDS,
  enumCases,
  generateAPI,
  identifierStem,
} from "../native-openapi.ts";
import {
  generateTokens,
  loadDesignSources,
  resolvePalette,
  ruleDeclarations,
  uncoveredDesignTokens,
  type ThemeTokens,
} from "../native-design-tokens.ts";
import { generateCatalog } from "../native-strings.ts";
import {
  generateNavigation,
  type NavigationSource,
} from "../native-navigation.ts";

test("names and literals follow Swift rules", () => {
  assert.equal(camelCase("rate_to_eur"), "rateToEur");
  assert.equal(camelCase("card-foreground"), "cardForeground");
  assert.equal(camelCase("chart-1"), "chart1");
  assert.equal(camelCase("getExchangeRates"), "getExchangeRates");
  assert.equal(pascalCase("high-contrast"), "HighContrast");
  assert.equal(swiftIdentifier("default"), "`default`");
  assert.equal(swiftString('a "b"\\\n\u0001'), '"a \\"b\\"\\\\\\n\\u{1}"');
  assert.deepEqual(parseListFile("# c\na\n\n b # note\n", "x"), ["a", "b"]);
  assert.throws(() => parseListFile("a\na\n", "list"), /listed twice/);
});

const SPEC = `
openapi: 3.0.3
info: { title: Fixture, version: "1" }
paths:
  /api/items/{id}:
    parameters:
      - { in: path, name: id, required: true, schema: { type: integer } }
    get:
      operationId: getItem
      summary: Read one item
      parameters:
        - { in: query, name: with_notes, schema: { type: boolean } }
        - { in: query, name: tags, schema: { type: array, items: { type: string } } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                allOf:
                  - $ref: "#/components/schemas/Envelope"
                  - type: object
                    properties:
                      data: { $ref: "#/components/schemas/Item" }
  /api/ping:
    post:
      operationId: ping
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Envelope" }
  /api/unused:
    get:
      operationId: unused
      responses:
        "204": { description: Nothing }
components:
  schemas:
    Envelope:
      type: object
      required: [ok]
      properties:
        ok: { type: boolean }
        data: { description: Present on success }
        error: { $ref: "#/components/schemas/ErrorPayload" }
    ErrorPayload:
      type: object
      required: [message]
      properties:
        message: { type: string }
    Item:
      type: object
      required: [id, amount, kind, meta]
      properties:
        id: { type: integer }
        amount: { type: number }
        note: { type: string, nullable: true }
        kind: { $ref: "#/components/schemas/ItemKind" }
        extra: { oneOf: [{ type: string }, { type: integer }] }
        meta:
          type: object
          required: [created_at]
          properties:
            created_at: { type: string, format: date-time }
    ItemKind:
      type: string
      enum: [cash, crypto_exchange]
    Unused:
      type: object
      properties:
        x: { type: string }
`;

test("generates the allow-listed operations and only the schemas they reach", () => {
  const generated = generateAPI(SPEC, "getItem\nping\n");
  assert.match(
    generated.models,
    /public struct Item: Codable, Equatable, Sendable \{/,
  );
  assert.match(generated.models, /public let amount: Decimal\n/);
  assert.match(generated.models, /public let note: String\?\n/);
  assert.match(generated.models, /public let kind: OpenAPI\.ItemKind\n/);
  assert.match(generated.models, /public let extra: JSONValue\?\n/);
  assert.match(generated.models, /public let meta: Meta\n/);
  assert.match(generated.models, /case createdAt = "created_at"/);
  assert.match(generated.models, /case "crypto_exchange": self = \.cryptoExchange/);
  assert.match(generated.models, /public let id: ItemID\n/);
  assert.match(generated.models, /public struct Envelope:/);
  assert.match(generated.models, /public struct ErrorPayload:/);
  assert.doesNotMatch(generated.models, /Unused/);
  assert.match(generated.operations, /public struct GetItem: APIOperation \{/);
  assert.match(
    generated.operations,
    /public typealias Response = OpenAPI\.Item\n/,
  );
  assert.match(
    generated.operations,
    /public var path: String \{ "\/api\/items\/\\\(APIPath\.segment\(APIQuery\.value\(id\)\)\)" \}/,
  );
  assert.match(generated.operations, /public var id: ItemID\n/);
  assert.match(
    generated.operations,
    /if let withNotes \{ items\.append\(URLQueryItem\(name: "with_notes"/,
  );
  assert.match(generated.operations, /if let tags \{ for value in tags/);
  assert.match(
    generated.operations,
    /public struct Ping: APIOperation \{\n {8}public typealias Response = JSONValue/,
  );
  assert.match(
    generated.operations,
    /public static let method = HTTPMethod\.post/,
  );
  assert.doesNotMatch(generated.operations, /Unused/);
  assert.deepEqual(
    generateAPI(SPEC, "getItem\nping\n"),
    generated,
    "the output is deterministic",
  );
});

test("an unknown operationId or an empty allow-list fails", () => {
  assert.throws(
    () => generateAPI(SPEC, "missing\n"),
    /operationId missing is not in openapi\.yaml/,
  );
  assert.throws(() => generateAPI(SPEC, "# nothing\n"), /lists no operations/);
});

test("compatibility field aliases retain separate wire keys and Swift members", () => {
  const spec = SPEC.replace(
    "amount: { type: number }",
    "amount: { type: number }\n        asset_class: { type: string }\n        assetClass: { type: string }",
  );
  const generated = generateAPI(spec, "getItem\n");
  assert.match(generated.models, /public let asset_class: String\?/);
  assert.match(generated.models, /public let assetClass: String\?/);
  assert.match(generated.models, /case asset_class = "asset_class"/);
  assert.match(generated.models, /case assetClass = "assetClass"/);
  assert.doesNotMatch(
    generated.models,
    /assetClass: String\? = nil, assetClass:/,
  );
});

/** A spec with entities, foreign keys, currencies, enums and a PATCH body, for WP-1 cases. */
const TYPED_SPEC = `
openapi: 3.0.3
info: { title: Fixture, version: "1" }
paths:
  /api/accounts/{id}:
    parameters:
      - { in: path, name: id, required: true, schema: { type: integer } }
    patch:
      operationId: updateAccount
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/AccountUpdate" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                allOf:
                  - $ref: "#/components/schemas/Envelope"
                  - type: object
                    properties:
                      data: { $ref: "#/components/schemas/Account" }
  /api/transactions:
    get:
      operationId: getTransactions
      parameters:
        - { in: query, name: account_id, schema: { type: integer } }
        - { in: query, name: currency, schema: { type: string } }
        - { in: query, name: tag_ids, schema: { type: array, items: { type: integer } } }
        - { in: query, name: kind, schema: { type: string, enum: [a, b] } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                allOf:
                  - $ref: "#/components/schemas/Envelope"
                  - type: object
                    properties:
                      data: { $ref: "#/components/schemas/Transaction" }
components:
  schemas:
    Envelope:
      type: object
      required: [ok]
      properties:
        ok: { type: boolean }
    ErrorPayload:
      type: object
      required: [message]
      properties:
        message: { type: string }
    Account:
      type: object
      required: [id, currency, owner]
      properties:
        id: { type: integer }
        currency: { type: string }
        owner: { type: string, enum: [me, none, unknown, "2fa", "a-b", "a_b"] }
        type: { type: string, enum: [checking, savings] }
        funding_account_id: { type: integer, nullable: true }
        unconverted_currencies: { type: array, items: { type: string } }
        note: { type: string, nullable: true }
        display_name: { type: string, nullable: true }
    AccountUpdate:
      type: object
      properties:
        display_name: { type: string, nullable: true }
        note: { type: string, nullable: true }
        funding_account_id: { type: integer, nullable: true }
    Transaction:
      type: object
      required: [id, account_id, category_id, tag_ids, transfer_peer_id]
      properties:
        id: { type: integer }
        account_id: { type: integer }
        category_id: { type: integer, nullable: true }
        tag_ids: { type: array, items: { type: integer } }
        transfer_peer_id: { type: integer }
        label: { type: string, enum: [x, null], nullable: true }
        currency_column: { type: string }
        pattern_currency: { type: string, pattern: "^[A-Z]{3}$" }
    Category:
      type: object
      required: [id]
      properties:
        id: { type: integer }
    Tag:
      type: object
      required: [id]
      properties:
        id: { type: integer }
`;
const TYPED_OPS = "updateAccount\ngetTransactions\n";

/** Override tables for the toy spec, so the real tables never leak into a case. */
function toyTables(over: Partial<GeneratorTables> = {}): GeneratorTables {
  return {
    schemaIdEntity: {},
    stemEntity: {},
    fieldEntity: { "*.transfer_peer_id": "Transaction" },
    pathIdEntity: [],
    untypedIds: {},
    nullablePatchFields: {},
    ...over,
  };
}

test("ids get one Swift type per entity, foreign keys included", () => {
  const generated = generateAPI(TYPED_SPEC, TYPED_OPS, toyTables());
  assert.match(
    generated.models,
    /public struct Account: .*\{\n {8}public let id: AccountID\n/,
  );
  assert.match(generated.models, /public let fundingAccountId: AccountID\?\n/);
  assert.match(generated.models, /public let accountId: AccountID\n/);
  assert.match(generated.models, /public let categoryId: CategoryID\?\n/);
  assert.match(generated.models, /public let tagIds: \[TagID\]\n/);
  assert.match(generated.models, /public let transferPeerId: TransactionID\n/);
  assert.match(generated.models, /public let id: TransactionID\n/);
  assert.match(generated.operations, /public var id: AccountID\n/);
  assert.match(generated.operations, /public var accountId: AccountID\?\n/);
  assert.match(generated.operations, /public var tagIds: \[TagID\]\?\n/);
  assert.match(generated.operations, /for value in tagIds \{ items\.append/);
  assert.doesNotMatch(generated.models, /: Int\??\n/, "no integer id stays Int");
  for (const entity of ["Account", "Category", "Tag", "Transaction"]) {
    assert.match(
      generated.identifiers,
      new RegExp(
        `public enum ${entity}IDTag: IdentifierTag \\{\\}\\npublic typealias ${entity}ID = IntIdentifier<${entity}IDTag>`,
      ),
    );
  }
  assert.equal(generated.stats.identifierTypes, 4);
});

test("an id-like integer or string field with no mapping fails generation", () => {
  const spec = TYPED_SPEC.replace(
    "transfer_peer_id: { type: integer }",
    "transfer_peer_id: { type: integer }\n        mystery_id: { type: string }",
  );
  assert.throws(
    () => generateAPI(spec, TYPED_OPS, toyTables()),
    /no identifier type[\s\S]*Transaction\.mystery_id/,
  );
  // The same field is accepted once it is mapped, or listed with a reason.
  const mapped = generateAPI(
    spec,
    TYPED_OPS,
    toyTables({
      fieldEntity: {
        "*.transfer_peer_id": "Transaction",
        "Transaction.mystery_id": "Voucher",
      },
    }),
  );
  assert.match(mapped.models, /public let mysteryId: VoucherID\?\n/);
  assert.match(mapped.identifiers, /public typealias VoucherID = StringIdentifier<VoucherIDTag>/);
  const untyped = generateAPI(
    spec,
    TYPED_OPS,
    toyTables({
      untypedIds: { "*.mystery_id": "A catalog code, not an entity." },
    }),
  );
  assert.match(untyped.models, /public let mysteryId: String\?\n/);
  assert.deepEqual(untyped.stats.untypedIdsHit, ["*.mystery_id"]);
});

test("a comma-separated id string is never typed as one id", () => {
  const spec = TYPED_SPEC.replace(
    "- { in: query, name: kind,",
    "- { in: query, name: account_ids, schema: { type: string } }\n        - { in: query, name: kind,",
  );
  assert.throws(
    () => generateAPI(spec, TYPED_OPS, toyTables()),
    /GetTransactions\.account_ids/,
  );
});

test("identifier stems and tables are consistent", () => {
  assert.deepEqual(identifierStem("id"), { stem: "", plural: false });
  assert.deepEqual(identifierStem("fundingAccountId"), {
    stem: "fundingAccount",
    plural: false,
  });
  assert.deepEqual(identifierStem("transfer_origin_account_id"), {
    stem: "transfer_origin_account",
    plural: false,
  });
  assert.deepEqual(identifierStem("category_ids"), {
    stem: "category",
    plural: true,
  });
  assert.equal(identifierStem("paid"), undefined);
  assert.equal(identifierStem("identity"), undefined);
  // Entity names become Swift type names (`<Entity>ID`).
  const entities = [
    ...Object.values(SCHEMA_ID_ENTITY),
    ...Object.values(STEM_ENTITY),
    ...Object.values(FIELD_ENTITY),
    ...PATH_ID_ENTITY.map((item) => item.entity),
  ];
  for (const entity of entities) {
    assert.match(entity, /^[A-Z][A-Za-z0-9]*[a-z0-9]$/);
    assert.doesNotMatch(entity, /ID$/);
  }
  for (const [key, reason] of Object.entries(UNTYPED_IDS))
    assert.ok(reason.trim().length > 20, `${key} needs a reason`);
});

test("currency fields become CurrencyCode, other strings stay strings", () => {
  const generated = generateAPI(TYPED_SPEC, TYPED_OPS, toyTables());
  assert.match(generated.models, /public let currency: CurrencyCode\n/);
  assert.match(
    generated.models,
    /public let unconvertedCurrencies: \[CurrencyCode\]\?\n/,
  );
  assert.match(generated.models, /public let patternCurrency: CurrencyCode\?\n/);
  assert.match(generated.models, /public let currencyColumn: String\?\n/);
  assert.match(generated.operations, /public var currency: CurrencyCode\?\n/);
  assert.equal(generated.stats.currencyFields, 4);
});

test("string enums decode unknown values and re-encode the raw string", () => {
  const generated = generateAPI(TYPED_SPEC, TYPED_OPS, toyTables());
  assert.match(generated.models, /public let owner: Owner\n/);
  assert.match(
    generated.models,
    /public enum Owner: Codable, Hashable, Sendable, CaseIterable, RawRepresentable \{/,
  );
  assert.match(generated.models, /case unknown\(String\)/);
  assert.match(generated.models, /default: self = \.unknown\(rawValue\)/);
  assert.match(generated.models, /case \.unknown\(let value\): return value/);
  assert.match(generated.models, /public static var allKnownCases: \[Owner\]/);
  // `type` must not become a nested type named `Type` (a metatype).
  assert.match(generated.models, /public let type: AccountType\?\n/);
  assert.doesNotMatch(generated.models, /enum Type\b/);
  // A null enum member is not a case; query parameter enums stay plain strings.
  assert.match(generated.models, /public let label: Label\?\n/);
  assert.doesNotMatch(generated.models, /"null"/);
  assert.match(generated.operations, /public var kind: String\?\n/);
  assert.equal(generated.stats.enumsInline, 3);
});

test("enum case names are unique and clear of the generated members", () => {
  const cases = enumCases([
    "me",
    "none",
    "unknown",
    "2fa",
    "a-b",
    "a_b",
    "",
    "rawValue",
  ]);
  const names = cases.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.includes("unknown"));
  assert.ok(!names.includes("rawValue"));
  assert.ok(!names.includes("allCases"));
  assert.equal(names[1], "none");
  assert.equal(names[2], "unknownValue");
  assert.equal(cases.length, 8);
});

test("a nullable PATCH field that the frontend clears sends an explicit null", () => {
  const generated = generateAPI(
    TYPED_SPEC,
    TYPED_OPS,
    toyTables({
      nullablePatchFields: {
        AccountUpdate: ["display_name", "funding_account_id"],
      },
    }),
  );
  const body = generated.models.slice(
    generated.models.indexOf("public struct AccountUpdate"),
  );
  assert.match(body, /public let displayName: Nullable<String>\n/);
  assert.match(body, /public let fundingAccountId: Nullable<AccountID>\n/);
  assert.match(body, /public let note: String\?\n/, "unlisted fields stay T?");
  assert.match(body, /displayName: Nullable<String> = \.absent/);
  assert.match(
    body,
    /container\.decodeNullable\(String\.self, forKey: \.displayName\)/,
  );
  assert.match(
    body,
    /try container\.encodeNullable\(displayName, forKey: \.displayName\)/,
  );
  assert.match(body, /try container\.encodeIfPresent\(note, forKey: \.note\)/);
  assert.deepEqual(generated.stats.nullableFieldsHit, [
    "AccountUpdate.display_name",
    "AccountUpdate.funding_account_id",
  ]);
  // A field that is not nullable in the spec, or not a property, cannot be listed.
  assert.throws(
    () =>
      generateAPI(
        TYPED_SPEC,
        TYPED_OPS,
        toyTables({ nullablePatchFields: { Account: ["currency"] } }),
      ),
    /not nullable/,
  );
  assert.throws(
    () =>
      generateAPI(
        TYPED_SPEC,
        TYPED_OPS,
        toyTables({ nullablePatchFields: { AccountUpdate: ["gone"] } }),
      ),
    /not a property/,
  );
});

test("the real spec generates with every id mapped and every table entry used", () => {
  const generated = generateAPI(
    fs.readFileSync(repoPath("openapi.yaml"), "utf8"),
    fs.readFileSync(repoPath(ALLOW_LIST), "utf8"),
  );
  // Generation itself fails on an unmapped id; these checks cover the rest.
  assert.deepEqual(
    generated.stats.untypedIdsHit,
    Object.keys(UNTYPED_IDS).sort(),
    "every UNTYPED_IDS entry matches a field, and none is stale",
  );
  const expectedNullable = Object.entries(NULLABLE_PATCH_FIELDS)
    .flatMap(([struct, fields]) => fields.map((field) => `${struct}.${field}`))
    .sort();
  assert.deepEqual(generated.stats.nullableFieldsHit, expectedNullable);

  // No integer or string id-named field stays Int/String unless it is in UNTYPED_IDS.
  const allowedNames = new Set(
    Object.keys(UNTYPED_IDS).map((key) => camelCase(key.split(".").pop() ?? "")),
  );
  const plain = [
    ...generated.models.matchAll(
      /public (?:let|var) (\w+): \[?(?:Int|String)\]?\??$/gm,
    ),
    ...generated.operations.matchAll(
      /public (?:let|var) (\w+): \[?(?:Int|String)\]?\??$/gm,
    ),
  ]
    .map((match) => match[1] ?? "")
    .filter((name) => /^id$|Ids?$/.test(name));
  assert.deepEqual(
    plain.filter((name) => !allowedNames.has(name)),
    [],
    "an id field is typed Int/String without an UNTYPED_IDS entry",
  );

  // Each emitted type is declared once and nothing references an undeclared one.
  const declared = new Set(
    [...generated.identifiers.matchAll(/public typealias (\w+ID) = /g)].map((m) => m[1]),
  );
  const used = new Set(
    [...(generated.models + generated.operations).matchAll(/\b([A-Z]\w*ID)\b/g)].map((m) => m[1]),
  );
  for (const name of used) assert.ok(declared.has(name), `${name} is not declared`);
  assert.equal(declared.size, generated.stats.identifierTypes);
  assert.ok(generated.stats.identifierFields > 200);
  assert.ok(generated.stats.currencyFields > 50);
  const enumCount = (generated.models.match(/^ *public enum \w+: Codable, Hashable/gm) ?? [])
    .length + (generated.operations.match(/^ *public enum \w+: Codable, Hashable/gm) ?? []).length;
  assert.equal(enumCount, generated.stats.enumsNamed + generated.stats.enumsInline);
  assert.doesNotMatch(
    generated.models,
    /public let currency\w*: (?:String|\[String\])/i,
    "no currency field stays String",
  );
});

const TOKENS_CSS = `
@layer base {
  :root {
    --background: 40 36% 96%;
    --gain: 36 74% 33%;
    --loss: var(--destructive);
    --loss-colorblind: 24 85% 45%;
    --radius: 0.625rem;
    --radius-chip: 0.375rem;
    --radius-control: var(--radius);
    --radius-card: 0.875rem;
    --radius-sheet: 1.375rem;
    --duration-fast: 150ms;
    --font-display: "Fraunces", serif;
    --font-body: "Inter", sans-serif;
    --font-mono: "SF Mono", monospace;
    --label-primary-alpha: 1;
  }
  .dark {
    --gain: var(--accent);
    --loss-colorblind: 24 90% 62%;
  }
  :root[data-theme-variant]:not([data-theme-variant="default"]) {
    --gain: var(--accent);
  }
}`;
const SKIN_CSS = `:root.skin-v2 { --gain: 162 84% 30%; --loss: var(--loss-colorblind); }
:root.skin-v2.dark { --gain: 160 65% 52%; --loss: var(--loss-colorblind); }`;

function palette(
  background: string,
  accent: string,
  destructive: string,
): ThemeTokens {
  return { background, accent, destructive, "label-secondary-alpha": "0.72" };
}

const THEMES = {
  default: {
    light: palette("40 36% 96%", "38 58% 52%", "358 74% 48%"),
    dark: palette("200 20% 7%", "42 72% 66%", "358 82% 62%"),
  },
  nord: {
    light: palette("220 16% 96%", "179 30% 36%", "354 42% 46%"),
    dark: palette("220 16% 22%", "179 25% 65%", "354 42% 56%"),
  },
};

test("design tokens follow the cascade for gain and loss", () => {
  assert.deepEqual(ruleDeclarations(TOKENS_CSS, ".dark"), {
    gain: "var(--accent)",
    "loss-colorblind": "24 90% 62%",
  });
  const sources = { tokensCss: TOKENS_CSS, skinCss: SKIN_CSS, themes: THEMES };
  const defaultLight = resolvePalette(sources, "default", "light");
  assert.deepEqual(defaultLight.gain, {
    hue: 36,
    saturation: 74,
    lightness: 33,
  });
  assert.deepEqual(defaultLight.loss, {
    hue: 358,
    saturation: 74,
    lightness: 48,
  });
  assert.deepEqual(defaultLight.colorblindGain, {
    hue: 162,
    saturation: 84,
    lightness: 30,
  });
  assert.deepEqual(defaultLight.colorblindLoss, {
    hue: 24,
    saturation: 85,
    lightness: 45,
  });
  const defaultDark = resolvePalette(sources, "default", "dark");
  assert.deepEqual(defaultDark.gain, {
    hue: 42,
    saturation: 72,
    lightness: 66,
  });
  assert.deepEqual(defaultDark.colorblindLoss, {
    hue: 24,
    saturation: 90,
    lightness: 62,
  });
  // The non-default variant rule puts gain on the variant's own accent in light mode too.
  assert.deepEqual(resolvePalette(sources, "nord", "light").gain, {
    hue: 179,
    saturation: 30,
    lightness: 36,
  });
  assert.deepEqual(defaultLight.alphas, [["label-secondary-alpha", 0.72]]);

  const design = loadDesignSources();
  const swift = generateTokens({
    ...sources,
    variants: ["default", "nord"],
    design,
  });
  assert.match(swift, /case \(\.nord, \.dark\): return nordDark/);
  assert.match(swift, /public static let control: Double = 10\n/);
  assert.match(swift, /public static let fast: Double = 0\.15\n/);
  assert.match(swift, /public static let display = \["Fraunces", "serif"\]/);
  assert.equal(
    generateTokens({ ...sources, variants: ["default", "nord"], design }),
    swift,
  );
});

const FIXTURE = { tokensCss: TOKENS_CSS, skinCss: SKIN_CSS, themes: THEMES };

function designTokensSwift(
  edit: (design: ReturnType<typeof loadDesignSources>) => void = () => {},
): string {
  const design = loadDesignSources();
  edit(design);
  return generateTokens({ ...FIXTURE, variants: ["default", "nord"], design });
}

test("the design-system tokens come from the web sources", () => {
  const swift = designTokensSwift();
  const has = (text: string) => assert.ok(swift.includes(text), text);
  has(
    "public static let glide = BezierCurve(x1: 0.32, y1: 0.72, x2: 0, y2: 1)",
  );
  has(
    "public static let inOutQuart = BezierCurve(x1: 0.77, y1: 0, x2: 0.175, y2: 1)",
  );
  has("settleDuration: 0.506,");
  has("mass: 1, stiffness: 300, damping: 30,");
  has(
    "ShadowLayer(color: .shadow, alpha: 0.16, x: 0, y: 8, blur: 24, spread: -8, inset: false)",
  );
  has(
    "public static let saturate: AppearanceValue<Double> = AppearanceValue(light: 1.8, dark: 1.5)",
  );
  has("public static let thickBlur: Double = 28");
  has(
    "public static let grainAlpha: AppearanceValue<Double> = AppearanceValue(light: 0.018, dark: 0.028)",
  );
  has("public static let scrim: Double = 0.6");
  has("public static let scrimFrosted: Double = 0.4");
  has("public static let scrimFrostedStrong: Double = 0.5");
  has("public static let blur: Double = 12");
  has("public static let dialogRadius: Double = 22");
  has("public static let dialogMaxWidth: Double = 512");
  has("public static let enterScale: Double = 0.95");
  has("public static let enterOffsetY: Double = 12");
  has("public static let scale: Double = 0.97");
  has("public static let width: Double = 3");
  has("public static let x2l: Double = 20");
  has("public static let md: Double = 8");
  has("public static let heightSm: Double = 32");
  has("public static let heightLg: Double = 40");
  has("public enum Typography {");
  has(
    "TypeStyle(face: .display, size: 32, lineHeight: 38, weight: 600, tracking: -0.025)",
  );
  has(
    "TypeStyle(face: .body, size: 11, lineHeight: 14, weight: 400, tracking: 0)",
  );
  // The palette is untouched by the design-system section.
  has("public static let control: Double = 10");
});

test("every design-system custom property of tokens.css reaches the Swift tokens", () => {
  const swift = designTokensSwift();
  const { text } = loadDesignSources().tokensCss;
  assert.deepEqual(uncoveredDesignTokens(text, swift), []);
  // A new property without a Swift counterpart is reported, unless it is allow-listed.
  const orphan = text.replace(
    "--grain-alpha: 0.018;",
    "--grain-alpha: 0.018;\n        --aurora-new-alpha: 0.5;\n        --glass-saturate-extra: 1;",
  );
  assert.deepEqual(uncoveredDesignTokens(orphan, swift), ["aurora-new-alpha"]);
  assert.deepEqual(
    uncoveredDesignTokens(orphan, swift, { "aurora-new-alpha": "not drawn" }),
    [],
  );
  // Generation itself fails on it.
  assert.throws(
    () =>
      designTokensSwift((design) => {
        design.tokensCss.text = orphan;
      }),
    /without a Swift counterpart: --aurora-new-alpha/,
  );
  // A new easing or spring curve needs no allow-list: the generator discovers them.
  const eased = designTokensSwift((design) => {
    design.tokensCss.text = design.tokensCss.text.replace(
      "--ease-glide:",
      "--ease-linear: cubic-bezier(0, 0, 1, 1);\n        --ease-glide:",
    );
  });
  assert.match(
    eased,
    /public static let linear = BezierCurve\(x1: 0, y1: 0, x2: 1, y2: 1\)/,
  );
});

test("generation fails on an unresolved var(--x)", () => {
  assert.throws(
    () =>
      designTokensSwift((design) => {
        design.tokensCss.text = design.tokensCss.text.replace(
          "hsl(var(--glass-highlight) / 0.3)",
          "hsl(var(--glass-missing) / 0.3)",
        );
      }),
    /unresolved var\(--glass-missing\)/,
  );
  assert.throws(
    () =>
      designTokensSwift((design) => {
        design.tokensCss.text = design.tokensCss.text.replace(
          "--ease-glide: cubic-bezier(0.32, 0.72, 0, 1);",
          "--ease-glide: var(--ease-missing);",
        );
      }),
    /--ease-missing is not defined/,
  );
  assert.throws(
    () =>
      designTokensSwift((design) => {
        design.tokensCss.text = design.tokensCss.text.replace(
          "0 1px 2px hsl(var(--glass-shadow) / 0.06)",
          "0 1px var(--blur) hsl(var(--glass-shadow) / 0.06)",
        );
      }),
    /unresolved var\(--x\)/,
  );
  // Tailwind class constants are checked too: a missing class fails instead of defaulting.
  assert.throws(
    () =>
      designTokensSwift((design) => {
        design.buttonTsx.text = design.buttonTsx.text.replace(
          'lg: "h-10',
          'lg: "px-6',
        );
      }),
    /size lg: not found/,
  );
});

test("the String Catalog carries both languages for every listed key", () => {
  const catalog = JSON.parse(
    generateCatalog(["b.key", "a.key"], {
      en: { "a.key": "A {count}", "b.key": "B" },
      nl: { "a.key": "A-nl {count}", "b.key": "B-nl" },
    }),
  ) as {
    sourceLanguage: string;
    strings: Record<
      string,
      { localizations: Record<string, { stringUnit: { value: string } }> }
    >;
  };
  assert.equal(catalog.sourceLanguage, "en");
  assert.deepEqual(Object.keys(catalog.strings), ["a.key", "b.key"]);
  assert.equal(
    catalog.strings["a.key"]?.localizations.nl?.stringUnit.value,
    "A-nl {count}",
  );
  assert.throws(
    () => generateCatalog(["a.key"], { en: { "a.key": "A" }, nl: {} }),
    /a\.key has no nl text/,
  );
});

function navigation(icon: string): NavigationSource {
  const item = (titleKey: string, url: string) => ({
    titleKey,
    url,
    icon: { displayName: icon },
  });
  return {
    NAV_SECTIONS: [
      {
        id: "top",
        collapsible: false,
        items: [{ ...item("nav.home", "/"), shortcutKey: "h", exact: true }],
      },
    ],
    ADMIN_SECTION: {
      id: "admin",
      labelKey: "nav.admin",
      collapsible: true,
      items: [item("nav.exchangeRates", "/admin/exchange-rates")],
    },
    FOOTER_NAV_ITEMS: [item("nav.aiChat", "/ai-chat")],
  };
}

test("the sidebar registry maps icons to SF Symbols and needs every label key", () => {
  const keys = [
    "nav.home",
    "nav.admin",
    "nav.exchangeRates",
    "nav.aiChat",
    "layout.settings",
  ];
  const swift = generateNavigation(navigation("ArrowLeftRight"), keys);
  assert.match(
    swift,
    /NavItem\(titleKey: "nav\.home", url: "\/", symbol: "arrow\.left\.arrow\.right", shortcutKey: "h", badge: nil, exact: true\)/,
  );
  assert.match(swift, /id: \.admin, labelKey: "nav\.admin"/);
  assert.throws(
    () => generateNavigation(navigation("NoSuchIcon"), keys),
    /add an SF Symbol for the Lucide icon NoSuchIcon/,
  );
  assert.throws(
    () => generateNavigation(navigation("ArrowLeftRight"), keys.slice(1)),
    /nav\.home/,
  );
});
