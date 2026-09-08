import { describe, expect, it } from "vitest";
import { parseBrokerRetagBody } from "../src/services/investmentService.js";
import { ValidationError } from "../src/middleware/errorHandler.js";

const valid = {
  transaction_ids: [1, 2],
  from_account_id: null,
  to_account_id: 7,
  idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
};

describe("parseBrokerRetagBody", () => {
  it("accepts the strict canonical request", () => {
    expect(parseBrokerRetagBody(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, transaction_ids: [] },
    { ...valid, transaction_ids: [1, 1] },
    { ...valid, transaction_ids: ["1"] },
    { ...valid, from_account_id: 0 },
    { ...valid, idempotency_key: "not-a-uuid" },
    { ...valid, extra: true },
  ])("rejects an unsafe request shape", (body) => {
    expect(() => parseBrokerRetagBody(body)).toThrow(ValidationError);
  });
});
