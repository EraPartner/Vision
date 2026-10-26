/**
 * Compile-time half of the row contract (ADR-193): `checkedRows` and
 * `checkedRow` refuse a builder whose declared row type cannot be the rows its
 * schema checks. The assertions run in `tsc -p tsconfig.tests.json`; at
 * runtime the file only pins that the helpers exist.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { RawBuilder } from "kysely";
import { checkedRow, checkedRows } from "../src/database/db.ts";
import type { RowSchema } from "../src/database/rowContracts.ts";

type Builder<Row> = RawBuilder<Row>;
type BuilderParam<Row, Checked> = Parameters<
  typeof checkedRows<Checked, Builder<Row>>
>[1];

describe("checkedRows builder row type", () => {
  it("accepts a declared row that overlaps the checked row", () => {
    expectTypeOf<BuilderParam<{ n: string }, { n: string }>>().not.toBeNever();
    // A schema may narrow a declared string (brand, enum) or a nullable column.
    expectTypeOf<
      BuilderParam<{ s: string | null }, { s: string }>
    >().not.toBeNever();
    // An untyped `sql` template declares `unknown` and is left to runtime.
    expectTypeOf<BuilderParam<unknown, { n: string }>>().not.toBeNever();
  });

  it("rejects a declared row whose column cannot be the checked type", () => {
    // `sql<number>` over a pg NUMERIC / bigint, which node-postgres returns as a string.
    expectTypeOf<BuilderParam<{ n: number }, { n: string }>>().toBeNever();
    // A column the schema requires but the builder never selects.
    expectTypeOf<BuilderParam<{ a: string }, { b: string }>>().toBeNever();
  });

  it("applies the same rule to checkedRow", () => {
    expectTypeOf<
      Parameters<typeof checkedRow<{ n: string }, Builder<{ n: number }>>>[1]
    >().toBeNever();
  });

  it("keeps the schema parameter a plain row schema", () => {
    expectTypeOf<
      Parameters<typeof checkedRows<{ n: string }, Builder<{ n: string }>>>[0]
    >().toEqualTypeOf<RowSchema<{ n: string }>>();
    expect(typeof checkedRows).toBe("function");
  });
});
