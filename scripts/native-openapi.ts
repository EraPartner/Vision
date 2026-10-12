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

class Generator {
  private readonly required = new Set<string>(ALWAYS_GENERATED);
  private readonly pending = [...ALWAYS_GENERATED];

  private readonly spec: Spec;

  constructor(spec: Spec) {
    this.spec = spec;
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
  typeFor(schema: unknown, hint: string, nested: string[]): string {
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
      const merged = this.mergeAllOf(schema.allOf);
      const name = pascalCase(hint);
      nested.push(
        this.struct(name, merged.properties, merged.required, undefined),
      );
      return name;
    }
    switch (schema.type) {
      case "string":
        return "String";
      case "integer":
        return "Int";
      case "number":
        // Money and rates are Decimal, never Double (ADR-204 decision 8).
        return "Decimal";
      case "boolean":
        return "Bool";
      case "array":
        return `[${this.typeFor(schema.items, `${hint}Item`, nested)}]`;
      default: {
        const properties = isObject(schema.properties)
          ? schema.properties
          : undefined;
        if (properties && Object.keys(properties).length > 0) {
          const name = pascalCase(hint);
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
    const nested: string[] = [];
    const fields = Object.entries(properties).map(([wire, raw]) => {
      const schema = isObject(raw) ? raw : {};
      const swiftName = swiftIdentifier(camelCase(wire));
      const base = this.typeFor(schema, wire, nested);
      const optional = !required.includes(wire) || schema.nullable === true;
      return {
        wire,
        swiftName,
        plainName: swiftName.replace(/`/g, ""),
        type: optional ? `${base}?` : base,
        optional,
        description: stringField(schema, "description"),
      };
    });
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
          `${field.swiftName}: ${field.type}${field.optional ? " = nil" : ""}`,
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
      const lines = [...docLines(description, "")];
      lines.push(
        `public enum ${name}: String, Codable, Sendable, CaseIterable {`,
      );
      for (const value of schema.enum.map(String)) {
        lines.push(
          `    case ${swiftIdentifier(camelCase(value))} = ${swiftString(value)}`,
        );
      }
      lines.push("}");
      return lines.join("\n");
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
      const base = this.typeFor(schema, wire, nested);
      if (
        !["String", "Int", "Decimal", "Bool", "[String]", "[Int]"].includes(
          base,
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
    return [...emitted.keys()].sort().map((name) => emitted.get(name) ?? "");
  }
}

export function generateAPI(
  specText: string,
  allowListText: string,
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
  const generator = new Generator(spec);
  const operations = ids.map((id) =>
    generator.operationStruct(generator.operation(id)),
  );
  const models = generator.models();

  const modelsFile = [
    generatedHeader(SOURCE, COMMAND),
    "import Foundation",
    "",
    "/// The OpenAPI component schemas the allow-listed operations use",
    `/// (\`${ALLOW_LIST}\`). Dates stay the wire strings; numbers are \`Decimal\`.`,
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

  return { models: modelsFile, operations: operationsFile };
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
  } catch (error) {
    console.error(
      `[native-openapi] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) main();
