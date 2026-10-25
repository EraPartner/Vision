import assert from "node:assert/strict";
import test from "node:test";
import {
  camelCase,
  parseListFile,
  pascalCase,
  swiftIdentifier,
  swiftString,
} from "../lib/nativeCodegen.ts";
import { generateAPI } from "../native-openapi.ts";
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
  assert.match(generated.models, /case cryptoExchange = "crypto_exchange"/);
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
  has("public enum `Type` {");
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
    /button size lg: not found/,
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
