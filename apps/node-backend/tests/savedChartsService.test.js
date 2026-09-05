import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/middleware/errorHandler.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../src/repositories/savedChartsRepository.js", () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: mocks.create,
    update: mocks.update,
    delete: vi.fn(),
  },
}));

import savedChartsService from "../src/services/savedChartsService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("savedChartsService membership errors", () => {
  it.each(["create", "update"])(
    "maps a %s foreign-key race to a validation error",
    async (method) => {
      const foreignKeyError = Object.assign(
        new Error("foreign key violation"),
        {
          code: "23503",
        },
      );
      mocks[method].mockRejectedValue(foreignKeyError);

      const action =
        method === "create"
          ? savedChartsService.create({ categoryIds: [999] })
          : savedChartsService.update(7, { categoryIds: [999] });

      await expect(action).rejects.toMatchObject({
        constructor: ValidationError,
        code: "VALIDATION_ERROR",
        status: 400,
        cause: foreignKeyError,
      });
    },
  );

  it("does not mask unrelated repository errors", async () => {
    const failure = new Error("database unavailable");
    mocks.create.mockRejectedValue(failure);

    await expect(savedChartsService.create({ categoryIds: [] })).rejects.toBe(
      failure,
    );
  });
});
