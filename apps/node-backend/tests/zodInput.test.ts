import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatZodIssues, parseInput } from "../src/lib/zodInput.ts";
import { ValidationError } from "../src/middleware/errorHandler.ts";

const schema = z.strictObject({
  name: z.string().min(1),
  count: z.coerce.number().int(),
});

describe("parseInput", () => {
  it("returns the parsed output", () => {
    expect(parseInput(schema, { name: "a", count: "3" })).toEqual({
      name: "a",
      count: 3,
    });
  });

  it("throws a 400 ValidationError naming every failing path", () => {
    let caught: unknown;
    try {
      parseInput(schema, { name: "", count: "x" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toMatch(/^name: .+; count: .+$/);
  });

  it("applies the prefix and separator", () => {
    expect(() =>
      parseInput(schema, {}, { prefix: "Invalid body", separator: ", " }),
    ).toThrow(/^Invalid body: name: .+, count: .+$/);
  });

  it("leaves out paths when asked", () => {
    expect(() =>
      parseInput(z.object({ message: z.string({ error: '"message" is required' }) }), {}, {
        omitPaths: true,
      }),
    ).toThrow(/^"message" is required$/);
  });

  it("reports root-level issues without a path", () => {
    const result = z.string().safeParse(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodIssues(result.error)).toBe(result.error.issues[0]!.message);
    }
  });
});
