import { beforeEach, describe, expect, it, vi } from "vitest";

type PivotSpy = (...args: unknown[]) => Promise<{ data: object; meta: object }>;

const recipientPivotSpy = vi.fn<PivotSpy>(async () => ({ data: {}, meta: {} }));
const tagPivotSpy = vi.fn<PivotSpy>(async () => ({ data: {}, meta: {} }));

vi.mock(
  "../../src/services/calculations/aggregation/recipientPivot.ts",
  () => ({
    computeRecipientPivot: (...args: unknown[]) => recipientPivotSpy(...args),
  }),
);
vi.mock("../../src/services/calculations/aggregation/tagPivot.ts", () => ({
  computeTagPivot: (...args: unknown[]) => tagPivotSpy(...args),
}));

const { default: aggregationsRouter } =
  await import("../../src/routes/aggregations.ts");

function getHandler(path: string) {
  // Express's IRoute type omits the runtime `methods` map.
  const layer = aggregationsRouter.stack.find(
    (candidate) =>
      candidate.route?.path === path &&
      (candidate.route as unknown as { methods: Record<string, boolean> })
        .methods.get,
  );
  return layer!.route!.stack.at(-1)!.handle as unknown as (
    req: unknown,
    res: unknown,
  ) => Promise<void>;
}

const routes: Array<[string, typeof recipientPivotSpy]> = [
  ["/recipient-pivot", recipientPivotSpy],
  ["/tag-pivot", tagPivotSpy],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(routes)("GET %s date-range query params", (path, computeSpy) => {
  const handler = getHandler(path);

  async function invoke(query: Record<string, string | undefined>) {
    const response = { ok: vi.fn() };
    await handler({ query }, response);
    return response;
  }

  it("accepts and forwards the canonical start_date/end_date pair", async () => {
    await invoke({ start_date: "2025-01-01", end_date: "2025-12-31" });
    expect(computeSpy.mock.calls[0]![0]).toMatchObject({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
  });

  it("rejects the retired start/end aliases before computing", async () => {
    await expect(
      invoke({ start: "2024-01-01", end: "2024-12-31" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it.each([{ start_date: "2025-02-30x" }, { end_date: "not-a-date" }])(
    "rejects malformed dates before computing the pivot (%j)",
    async (query) => {
      await expect(invoke(query)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(computeSpy).not.toHaveBeenCalled();
    },
  );
});

describe("GET /tag-pivot all query parameter", () => {
  const handler = getHandler("/tag-pivot");

  it("forwards the canonical all=true parameter", async () => {
    const response = { ok: vi.fn() };
    await handler({ query: { all: "true" } }, response);
    expect(tagPivotSpy.mock.calls[0]![0]).toMatchObject({ allTags: true });
  });

  it("rejects the retired all_tags alias before computing", async () => {
    const response = { ok: vi.fn() };
    await expect(
      handler({ query: { all_tags: "true" } }, response),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(tagPivotSpy).not.toHaveBeenCalled();
  });
});
