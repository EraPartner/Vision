import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FIXTURE_DIR,
  generateFixtures,
  TEST_FILE,
} from "../native-fixtures.ts";
import { ALLOW_LIST } from "../native-openapi.ts";
import { repoPath } from "../lib/nativeCodegen.ts";

const SPEC = `
openapi: 3.0.3
info: { title: Fixture, version: "1" }
paths:
  /api/items/{id}:
    parameters:
      - { in: path, name: id, required: true, schema: { type: integer } }
    get:
      operationId: getItem
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
        currency: { type: string }
        currencies: { type: array, items: { type: string } }
        note: { type: string, nullable: true }
        day: { type: string, format: date }
        stamp: { type: string, format: date-time }
        label: { type: string, example: "From the spec" }
        kind: { $ref: "#/components/schemas/ItemKind" }
        extra: { oneOf: [{ type: string }, { type: integer }] }
        children: { type: array, items: { $ref: "#/components/schemas/Item" } }
        totals: { type: object, additionalProperties: { type: number } }
        meta:
          type: object
          required: [created_at]
          properties:
            created_at: { type: string, format: date-time }
            optional_flag: { type: boolean }
    ItemKind:
      type: string
      enum: [cash, crypto_exchange]
    Unreached:
      type: object
      properties:
        x: { type: string }
`;

function toy(name: string): unknown {
  const generated = generateFixtures(SPEC, "getItem\n");
  const text = generated.files.get(`${FIXTURE_DIR}/${name}.json`);
  assert.ok(text, `${name} was generated`);
  return JSON.parse(text);
}

test("fixtures cover exactly the emitted schemas, minimal and maximal", () => {
  const generated = generateFixtures(SPEC, "getItem\n");
  assert.deepEqual(generated.schemas, [
    "Envelope",
    "ErrorPayload",
    "Item",
    "ItemKind",
  ]);
  assert.equal(generated.files.size, 4 * 2 + 1);
  assert.ok(generated.files.has(TEST_FILE));
  assert.ok(!generated.files.has(`${FIXTURE_DIR}/Unreached.min.json`));
});

test("the minimal sample has required properties only", () => {
  assert.deepEqual(toy("Item.min"), {
    id: 1,
    amount: 1.5,
    kind: "cash",
    meta: { created_at: "2024-01-15T10:30:00.000Z" },
  });
});

test("the maximal sample has every property with valid values", () => {
  assert.deepEqual(toy("Item.max"), {
    id: 1,
    amount: 1.5,
    currency: "EUR",
    currencies: ["EUR"],
    note: "string",
    day: "2024-01-15",
    stamp: "2024-01-15T10:30:00.000Z",
    label: "From the spec",
    kind: "cash",
    extra: "string",
    // A property that would contain its own schema stops at an empty array.
    children: [],
    totals: { key: 1.5 },
    meta: { created_at: "2024-01-15T10:30:00.000Z", optional_flag: true },
  });
  assert.equal(toy("ItemKind.min"), "cash");
});

test("the Swift test lists every model and the negative cases", () => {
  const swift = generateFixtures(SPEC, "getItem\n").files.get(TEST_FILE) ?? "";
  for (const name of ["Envelope", "ErrorPayload", "Item", "ItemKind"])
    assert.match(swift, new RegExp(`GeneratedModelDecoder\\(name: "${name}"\\)`));
  assert.match(swift, /GeneratedModelDecoder\.all\.count == 4/);
  assert.match(swift, /data\("Item", "max"\)[\s\S]*key: "currency"/);
  assert.match(swift, /OpenAPI\.ItemKind\.self, from: Data/);
});

test("committed fixtures and Swift test match openapi.yaml", () => {
  const generated = generateFixtures(
    fs.readFileSync(repoPath("openapi.yaml"), "utf8"),
    fs.readFileSync(repoPath(ALLOW_LIST), "utf8"),
  );
  const missing: string[] = [];
  const stale: string[] = [];
  for (const [relative, text] of generated.files) {
    const file = repoPath(relative);
    if (!fs.existsSync(file)) missing.push(relative);
    else if (fs.readFileSync(file, "utf8") !== text) stale.push(relative);
  }
  const onDisk = fs
    .readdirSync(repoPath(FIXTURE_DIR))
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.posix.join(FIXTURE_DIR, entry));
  const extra = onDisk.filter((relative) => !generated.files.has(relative));
  const hint = "run `bun run native:generate-fixtures` and commit the result";
  assert.deepEqual(missing, [], `fixtures missing: ${hint}`);
  assert.deepEqual(stale, [], `fixtures out of date: ${hint}`);
  assert.deepEqual(extra, [], `fixtures for removed schemas: ${hint}`);
  // Every emitted model is in the Swift test list, so a schema added without
  // regenerating fails here.
  const swift = fs.readFileSync(repoPath(TEST_FILE), "utf8");
  const listed = [
    ...swift.matchAll(/GeneratedModelDecoder\(name: "(\w+)"\)/g),
  ].map((match) => match[1]);
  assert.deepEqual(listed, generated.schemas);
});

test("typed ids, currencies and enums get decoder-valid samples", () => {
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(
      fs.readFileSync(repoPath(FIXTURE_DIR, `${name}.json`), "utf8"),
    ) as Record<string, unknown>;
  const account = read("Account.max");
  assert.equal(account.id, 1);
  assert.equal(account.funding_account_id, 1);
  assert.equal(account.currency, "EUR");
  assert.deepEqual(account.unconverted_currencies, ["EUR"]);
});

test("every minimal fixture object is a subset of its maximal one", () => {
  const dir = repoPath(FIXTURE_DIR);
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".min.json")) continue;
    const min: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, entry), "utf8"),
    );
    const max: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, entry.replace(".min.", ".max.")), "utf8"),
    );
    if (typeof min === "object" && min !== null && !Array.isArray(min)) {
      const maxKeys = new Set(Object.keys(max as object));
      for (const key of Object.keys(min))
        assert.ok(
          maxKeys.has(key),
          `${entry}: ${key} missing from the maximal sample`,
        );
    }
  }
});
