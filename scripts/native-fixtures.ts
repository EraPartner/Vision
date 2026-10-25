#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import {
  ALLOW_LIST,
  generateAPI,
  identifierStem,
  isCurrencyField,
} from "./native-openapi.ts";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  generatedHeader,
  parseYaml,
  repoPath,
  swiftString,
} from "./lib/nativeCodegen.ts";

/**
 * Generates the decode contract fixtures of Vision Native (WP-4): for every
 * schema scripts/native-openapi.ts emits as a Swift model, a minimal (required
 * properties only) and a maximal (all properties) JSON sample, plus the Swift
 * test that decodes each one into its model, re-encodes it and compares the two
 * JSON documents semantically.
 *
 *   bun run native:generate-fixtures
 *
 * The output is a pure function of openapi.yaml and the operation allow-list, so
 * adding a schema without regenerating fails scripts/native-tests.
 *
 * Sample values: an `example` on a scalar when it fits the schema, else a
 * synthesized value (first enum value, `1` / `"id-1"` for ids, `"EUR"` for
 * currencies, valid date and date-time text, `1.5` for numbers). Samples never
 * contain `null`, so a re-encoded model (which omits nil) equals its input.
 */

export const FIXTURE_DIR = "apps/native/Tests/VisionNativeCoreTests/Fixtures/api";
export const TEST_FILE =
  "apps/native/Tests/VisionNativeCoreTests/Contract/GeneratedModelDecodeTests.swift";
const COMMAND = "native:generate-fixtures";
const SOURCE = "scripts/native-fixtures.ts from openapi.yaml";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
type Schema = { [key: string]: unknown };
type Mode = "min" | "max";

/** A sample that would have to contain itself. */
const CYCLE = Symbol("cycle");

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Valid samples for the spec's string patterns (Swift does not check them; consumers might). */
const PATTERN_SAMPLES: Record<string, string> = {
  "^\\d{4}-\\d{2}-\\d{2}$": "2024-01-15",
  "^\\d{1,3}(?:\\.\\d+)?\\s+\\d{1,3}(?:\\.\\d+)?%\\s+\\d{1,3}(?:\\.\\d+)?%$":
    "50 50% 50%",
  "^vision-(financial|portfolio|tax)-\\d{4}-\\d{2}-\\d{2}\\.pdf$":
    "vision-tax-2024-01-15.pdf",
  "^[A-Z]{3}$": "EUR",
  "^act_[A-Za-z0-9_-]{1,64}$": "act_1",
  "^[0-9a-f]{64}$": "0".repeat(64),
  "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$": "1.5",
  "^/(name|parameters|charts|querySpec)(/.*)?$": "/name",
  "^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$": "sample-1",
  "^[0-9]{4}-[0-9]{2}$": "2024-01",
  "^[0-9]{4}-(0[1-9]|1[0-2])$": "2024-01",
  "^\\s*[A-Za-z]{3}\\s*$": "EUR",
  "^[A-Z]{2}$": "BE",
  "^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$": "1.5",
  "^\\d+$": "1",
};
const LEAP_DATE_PATTERN_PREFIX = "^(?:(?:\\d\\d[2468][048]";

const FORMAT_SAMPLES: Record<string, string> = {
  date: "2024-01-15",
  "date-time": "2024-01-15T10:30:00.000Z",
  uuid: "00000000-0000-4000-8000-000000000001",
  uri: "https://example.com/resource",
  email: "user@example.com",
  time: "10:30:00",
};

class Sampler {
  private readonly schemas: Record<string, Schema>;

  constructor(schemas: Record<string, Schema>) {
    this.schemas = schemas;
  }

  /** A sample for the top-level schema `name`. */
  component(name: string, mode: Mode): Json {
    const value = this.sample(
      { $ref: `#/components/schemas/${name}` },
      mode,
      name,
      [],
      name,
    );
    if (value === CYCLE) throw new Error(`${name}: cannot build a finite sample.`);
    return value;
  }

  private resolve(ref: string): { name: string; schema: Schema } {
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) throw new Error(`Unsupported $ref ${ref}.`);
    const name = ref.slice(prefix.length);
    const schema = this.schemas[name];
    if (!isObject(schema)) throw new Error(`Unknown schema ${name}.`);
    return { name, schema };
  }

  /** Properties and required names of an object schema, with `allOf` parts merged. */
  objectParts(schema: Schema): { properties: Schema; required: string[] } {
    const properties: Schema = {};
    const required = new Set<string>();
    const parts = Array.isArray(schema.allOf) ? schema.allOf : [schema];
    for (const part of parts) {
      if (!isObject(part)) continue;
      const ref = typeof part.$ref === "string" ? part.$ref : undefined;
      const resolved = ref ? this.resolve(ref).schema : part;
      if (Array.isArray(resolved.allOf)) {
        const inner = this.objectParts(resolved);
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

  private sample(
    schema: unknown,
    mode: Mode,
    wire: string,
    stack: string[],
    where: string,
  ): Json | typeof CYCLE {
    if (!isObject(schema) || Object.keys(schema).length === 0) return "value";
    if (typeof schema.$ref === "string") {
      const { name, schema: target } = this.resolve(schema.$ref);
      if (stack.includes(name)) return CYCLE;
      return this.sample(target, mode, wire, [...stack, name], name);
    }
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
      const branches = (Array.isArray(schema.oneOf)
        ? schema.oneOf
        : (schema.anyOf as unknown[]));
      for (const branch of branches) {
        const value = this.sample(branch, mode, wire, stack, where);
        if (value !== CYCLE) return value;
      }
      return "value";
    }
    if (Array.isArray(schema.allOf)) {
      if (schema.allOf.length === 1 && isObject(schema.allOf[0])) {
        const only = schema.allOf[0];
        if (typeof only.$ref === "string")
          return this.sample(only, mode, wire, stack, where);
      }
      const { properties, required } = this.objectParts(schema);
      return this.object(properties, required, mode, stack, where);
    }
    switch (schema.type) {
      case "string":
        return this.string(schema, wire);
      case "integer":
        return this.number(schema, true);
      case "number":
        return this.number(schema, false);
      case "boolean":
        return true;
      case "array": {
        const minItems =
          typeof schema.minItems === "number" ? schema.minItems : 0;
        const count = mode === "max" ? Math.max(1, minItems) : minItems;
        if (count === 0) return [];
        const items: Json[] = [];
        for (let index = 0; index < count; index++) {
          const item = this.sample(schema.items, mode, wire, stack, `${where}[]`);
          if (item === CYCLE) return [];
          items.push(item);
        }
        return items;
      }
      default: {
        const properties = isObject(schema.properties)
          ? schema.properties
          : undefined;
        if (properties && Object.keys(properties).length > 0) {
          const required = Array.isArray(schema.required)
            ? schema.required.map(String)
            : [];
          return this.object(properties, required, mode, stack, where);
        }
        if (isObject(schema.additionalProperties)) {
          if (mode === "min") return {};
          const value = this.sample(
            schema.additionalProperties,
            mode,
            "key",
            stack,
            `${where}{}`,
          );
          return value === CYCLE ? {} : { key: value };
        }
        return "value";
      }
    }
  }

  private object(
    properties: Schema,
    required: string[],
    mode: Mode,
    stack: string[],
    where: string,
  ): Json {
    const out: { [key: string]: Json } = {};
    for (const [wire, raw] of Object.entries(properties)) {
      const isRequired = required.includes(wire);
      if (mode === "min" && !isRequired) continue;
      const value = this.sample(raw, mode, wire, stack, `${where}.${wire}`);
      if (value === CYCLE) {
        if (isRequired)
          throw new Error(`${where}.${wire}: required property contains itself.`);
        continue;
      }
      out[wire] = value;
    }
    return out;
  }

  private string(schema: Schema, wire: string): string {
    const example = typeof schema.example === "string" ? schema.example : undefined;
    const values = Array.isArray(schema.enum)
      ? schema.enum.filter((value): value is string => typeof value === "string")
      : [];
    if (values.length > 0)
      return example !== undefined && values.includes(example)
        ? example
        : (values[0] ?? "");
    // The Swift decoder rejects anything but three capital letters here.
    if (isCurrencyField(wire, schema)) return "EUR";
    if (example !== undefined) return example;
    const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined;
    if (pattern !== undefined) {
      const patterned =
        PATTERN_SAMPLES[pattern] ??
        (pattern.startsWith(LEAP_DATE_PATTERN_PREFIX) ? "2024-01-15" : undefined);
      if (patterned !== undefined) return patterned;
    }
    const format = typeof schema.format === "string" ? schema.format : undefined;
    const formatted = format ? FORMAT_SAMPLES[format] : undefined;
    if (formatted !== undefined) return formatted;
    if (identifierStem(wire) && format === undefined) return "id-1";
    let text = "string";
    const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
    const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : 1e9;
    if (text.length < minLength) text = text.padEnd(minLength, "x");
    if (text.length > maxLength) text = text.slice(0, maxLength);
    return text;
  }

  private number(schema: Schema, integer: boolean): number {
    const example = typeof schema.example === "number" ? schema.example : undefined;
    if (example !== undefined && (!integer || Number.isInteger(example)))
      return example;
    let value = integer ? 1 : 1.5;
    if (typeof schema.minimum === "number" && value < schema.minimum)
      value = integer ? Math.ceil(schema.minimum) : schema.minimum;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      value = integer ? Math.floor(schema.maximum) : schema.maximum;
    return value;
  }
}

export interface GeneratedFixtures {
  /** Repository-relative path -> file text, for every fixture and the Swift test. */
  files: Map<string, string>;
  /** The emitted schemas the fixtures cover. */
  schemas: string[];
}

function swiftTest(
  names: string[],
  negatives: { currency?: [string, string]; id?: [string, string]; enumName?: string },
): string {
  const lines: string[] = [
    generatedHeader(SOURCE, COMMAND),
    "import Foundation",
    "import Testing",
    "",
    "@testable import VisionNativeCore",
    "",
    "// One fixture-driven decode test per generated OpenAPI model (WP-4). Each schema has a",
    "// minimal (`.min`) and a maximal (`.max`) JSON sample under `Fixtures/api`; the test decodes",
    "// the sample into `OpenAPI.<Schema>`, encodes it again and compares the two as JSON values.",
    "// Dates are still wire strings, so there is no malformed-date case, and identifiers accept",
    "// any integer, so there is no id-0 case.",
    "",
    "/// One generated model: decodes JSON bytes into it and encodes the value back.",
    "struct GeneratedModelDecoder: Sendable {",
    "    let name: String",
    "    let roundTrip: @Sendable (Data) throws -> Data",
    "",
    "    init(name: String, roundTrip: @escaping @Sendable (Data) throws -> Data) {",
    "        self.name = name",
    "        self.roundTrip = roundTrip",
    "    }",
    "}",
    "",
    "/// A fixture to round-trip: `name` is the schema, `kind` is `min` or `max`.",
    "struct GeneratedModelCase: Sendable, CustomTestStringConvertible {",
    "    let name: String",
    "    let kind: String",
    "    let roundTrip: @Sendable (Data) throws -> Data",
    "",
    '    var testDescription: String { "\\(name).\\(kind)" }',
    "",
    "    static let all: [GeneratedModelCase] = GeneratedModelDecoder.all.flatMap { decoder in",
    '        ["min", "max"].map { kind in',
    "            GeneratedModelCase(name: decoder.name, kind: kind, roundTrip: decoder.roundTrip)",
    "        }",
    "    }",
    "}",
    "",
    "enum GeneratedFixtureError: Error {",
    "    case missing(String)",
    "    case notAnObject",
    "}",
    "",
    "enum GeneratedFixtures {",
    "    /// The bytes of `Fixtures/api/<name>.<kind>.json` (copied into the test bundle).",
    "    static func data(_ name: String, _ kind: String) throws -> Data {",
    '        guard let url = Bundle.module.url(forResource: "\\(name).\\(kind)", withExtension: "json", subdirectory: "api") else {',
    '            throw GeneratedFixtureError.missing("\\(name).\\(kind).json")',
    "        }",
    "        return try Data(contentsOf: url)",
    "    }",
    "",
    "    /// `data` (a JSON object) with `key` set to `value`.",
    "    static func replacing(_ data: Data, key: String, with value: JSONValue) throws -> Data {",
    "        guard case .object(var fields) = try JSONValue.parse(data) else {",
    "            throw GeneratedFixtureError.notAnObject",
    "        }",
    "        fields[key] = value",
    "        return try JSONEncoder().encode(JSONValue.object(fields))",
    "    }",
    "}",
    "",
    "enum GeneratedModelCodec {",
    "    static func roundTrip<T: Codable>(_ type: T.Type, _ data: Data) throws -> Data {",
    "        try JSONEncoder().encode(try JSONDecoder().decode(type, from: data))",
    "    }",
    "",
    "    /// JSON equality where `1` and `1.0` are the same number.",
    "    static func equivalent(_ lhs: JSONValue, _ rhs: JSONValue) -> Bool {",
    "        switch (lhs, rhs) {",
    "        case (.null, .null): return true",
    "        case (.bool(let a), .bool(let b)): return a == b",
    "        case (.string(let a), .string(let b)): return a == b",
    "        case (.array(let a), .array(let b)):",
    "            return a.count == b.count && zip(a, b).allSatisfy { equivalent($0.0, $0.1) }",
    "        case (.object(let a), .object(let b)):",
    "            return a.count == b.count",
    "                && a.allSatisfy { pair in b[pair.key].map { equivalent(pair.value, $0) } ?? false }",
    "        default:",
    "            guard let a = number(lhs), let b = number(rhs) else { return false }",
    "            return a == b",
    "        }",
    "    }",
    "",
    "    private static func number(_ value: JSONValue) -> Double? {",
    "        switch value {",
    "        case .int(let number): return Double(number)",
    "        case .double(let number): return number",
    "        default: return nil",
    "        }",
    "    }",
    "}",
    "",
    "struct GeneratedModelDecodeTests {",
    '    @Test("Fixture decodes, re-encodes and matches its input", arguments: GeneratedModelCase.all)',
    "    func fixtureRoundTrips(_ fixture: GeneratedModelCase) throws {",
    "        let input = try GeneratedFixtures.data(fixture.name, fixture.kind)",
    "        let output = try fixture.roundTrip(input)",
    "        let expected = try JSONValue.parse(input)",
    "        let actual = try JSONValue.parse(output)",
    '        #expect(GeneratedModelCodec.equivalent(expected, actual), "\\(fixture.testDescription) changed in the round trip")',
    "    }",
    "",
    `    @Test("Every generated model has a fixture case")`,
    "    func everyModelHasACase() {",
    `        #expect(GeneratedModelDecoder.all.count == ${names.length})`,
    "    }",
    "",
    '    @Test("Only three capital letters decode as a currency code")',
    "    func currencyCodeRejectsMalformedText() throws {",
    "        let decoder = JSONDecoder()",
    '        #expect(try decoder.decode(CurrencyCode.self, from: Data(#""EUR""#.utf8)).rawValue == "EUR")',
    '        for text in ["eur", "Eur", "EURO", "EU", "", "E1R", " EU"] {',
    '            let json = Data("\\"\\(text)\\"".utf8)',
    "            #expect(throws: DecodingError.self) { try decoder.decode(CurrencyCode.self, from: json) }",
    "        }",
    "    }",
  ];
  if (negatives.currency) {
    const [schema, key] = negatives.currency;
    lines.push(
      "",
      '    @Test("A lowercase currency in a payload is a decoding error")',
      "    func lowercaseCurrencyInPayloadThrows() throws {",
      `        let data = try GeneratedFixtures.data(${swiftString(schema)}, "max")`,
      `        let bad = try GeneratedFixtures.replacing(data, key: ${swiftString(key)}, with: .string("eur"))`,
      `        #expect(throws: DecodingError.self) { try JSONDecoder().decode(OpenAPI.${schema}.self, from: bad) }`,
      "    }",
    );
  }
  if (negatives.id) {
    const [schema, key] = negatives.id;
    lines.push(
      "",
      '    @Test("A string where an integer id belongs is a decoding error")',
      "    func mistypedIdThrows() throws {",
      `        let data = try GeneratedFixtures.data(${swiftString(schema)}, "max")`,
      `        let bad = try GeneratedFixtures.replacing(data, key: ${swiftString(key)}, with: .string("abc"))`,
      `        #expect(throws: DecodingError.self) { try JSONDecoder().decode(OpenAPI.${schema}.self, from: bad) }`,
      "    }",
    );
  }
  if (negatives.enumName) {
    lines.push(
      "",
      '    @Test("An enum value the client does not know decodes to unknown and encodes back")',
      "    func unknownEnumValueSurvives() throws {",
      `        let decoded = try JSONDecoder().decode(OpenAPI.${negatives.enumName}.self, from: Data(#""not-a-known-value""#.utf8))`,
      '        #expect(decoded.rawValue == "not-a-known-value")',
      "        let encoded = try JSONEncoder().encode(decoded)",
      '        #expect(String(decoding: encoded, as: UTF8.self) == #""not-a-known-value""#)',
      "    }",
    );
  }
  lines.push(
    "",
    "    /// The platform `JSONDecoder` (the one `APIClient` uses, default strategies) must keep every",
    "    /// digit of a JSON number that decodes into a `Decimal`. If Foundation parses the number as a",
    "    /// `Double` first, the exact comparisons below fail; that would need a custom decoding strategy.",
    "    private struct Amount: Codable, Equatable {",
    "        let amount: Decimal",
    "    }",
    "",
    '    @Test("Decimal keeps all digits of a long fractional number")',
    "    func decimalKeepsLongDigits() throws {",
    '        let json = Data(#"{"amount":12345678901234.123456}"#.utf8)',
    "        let decoded = try JSONDecoder().decode(Amount.self, from: json)",
    '        #expect(decoded.amount == Decimal(string: "12345678901234.123456"))',
    '        #expect(decoded.amount.description == "12345678901234.123456")',
    "        let encoded = String(decoding: try JSONEncoder().encode(decoded), as: UTF8.self)",
    '        #expect(encoded.contains("12345678901234.123456"))',
    "    }",
    "",
    '    @Test("Decimal decodes 0.1 and 0.2 exactly, so they add to 0.3")',
    "    func decimalSumsWithoutBinaryError() throws {",
    '        let tenth = try JSONDecoder().decode(Amount.self, from: Data(#"{"amount":0.1}"#.utf8)).amount',
    '        let fifth = try JSONDecoder().decode(Amount.self, from: Data(#"{"amount":0.2}"#.utf8)).amount',
    '        #expect(tenth == Decimal(string: "0.1"))',
    '        #expect(fifth == Decimal(string: "0.2"))',
    '        #expect(tenth + fifth == Decimal(string: "0.3"))',
    '        #expect((tenth + fifth).description == "0.3")',
    "    }",
    "",
    '    @Test("Decimal keeps a large integer-valued amount and a tiny fraction")',
    "    func decimalKeepsExtremes() throws {",
    '        let json = Data(#"{"amount":9007199254740993.01}"#.utf8)',
    "        let decoded = try JSONDecoder().decode(Amount.self, from: json)",
    '        #expect(decoded.amount.description == "9007199254740993.01")',
    '        let tiny = try JSONDecoder().decode(Amount.self, from: Data(#"{"amount":0.000000000000000001}"#.utf8))',
    '        #expect(tiny.amount == Decimal(string: "0.000000000000000001"))',
    "    }",
    "}",
    "",
    "extension GeneratedModelDecoder {",
    "    /// Every model the OpenAPI generator emits, sorted by schema name.",
    "    static let all: [GeneratedModelDecoder] = [",
  );
  for (const name of names)
    lines.push(
      `        GeneratedModelDecoder(name: ${swiftString(name)}) { try GeneratedModelCodec.roundTrip(OpenAPI.${name}.self, $0) },`,
    );
  lines.push("    ]", "}", "");
  return lines.join("\n");
}

export function generateFixtures(
  specText: string,
  allowListText: string,
): GeneratedFixtures {
  const generated = generateAPI(specText, allowListText);
  const parsed = parseYaml(specText);
  if (!isObject(parsed) || !isObject(parsed.components))
    throw new Error("openapi.yaml must declare components.");
  const schemas = parsed.components.schemas as Record<string, Schema>;
  const sampler = new Sampler(schemas);
  const files = new Map<string, string>();
  for (const name of generated.schemas) {
    for (const mode of ["min", "max"] as const) {
      files.set(
        `${FIXTURE_DIR}/${name}.${mode}.json`,
        `${JSON.stringify(sampler.component(name, mode), null, 2)}\n`,
      );
    }
  }

  // Negative cases need a model with a scalar currency / integer id property of its own.
  const negatives: Parameters<typeof swiftTest>[1] = {};
  for (const name of generated.schemas) {
    const schema = schemas[name];
    if (!isObject(schema)) continue;
    if (schema.type === "string" && Array.isArray(schema.enum)) {
      negatives.enumName ??= name;
      continue;
    }
    const { properties } = sampler.objectParts(schema);
    for (const [wire, raw] of Object.entries(properties)) {
      if (!isObject(raw)) continue;
      if (
        negatives.currency === undefined &&
        raw.type === "string" &&
        isCurrencyField(wire, raw)
      )
        negatives.currency = [name, wire];
      if (negatives.id === undefined && wire === "id" && raw.type === "integer")
        negatives.id = [name, wire];
    }
  }
  files.set(TEST_FILE, swiftTest(generated.schemas, negatives));
  return { files, schemas: generated.schemas };
}

/** Writes the files that differ and removes stale fixtures; returns the number written. */
export function writeFixtures(root: string, generated: GeneratedFixtures): number {
  let written = 0;
  const fixtureDir = path.join(root, FIXTURE_DIR);
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const entry of fs.readdirSync(fixtureDir)) {
    if (entry.endsWith(".json") && !generated.files.has(`${FIXTURE_DIR}/${entry}`))
      fs.rmSync(path.join(fixtureDir, entry));
  }
  for (const [relative, text] of generated.files) {
    const file = path.join(root, relative);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    written++;
  }
  return written;
}

function main(): void {
  try {
    const generated = generateFixtures(
      fs.readFileSync(repoPath("openapi.yaml"), "utf8"),
      fs.readFileSync(repoPath(ALLOW_LIST), "utf8"),
    );
    const written = writeFixtures(repoPath(), generated);
    console.log(
      `[native-fixtures] ${generated.schemas.length} schemas, ${generated.files.size - 1} fixtures and ${TEST_FILE}; ${written} file(s) written.`,
    );
  } catch (error) {
    console.error(
      `[native-fixtures] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) main();
