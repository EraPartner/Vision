import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.ts";
vi.mock("../src/database/connection.ts", () => mockTxConnection());
import { query, withTransaction } from "../src/database/connection.ts";
import repo from "../src/repositories/settingsRepository.ts";
beforeEach(() => vi.clearAllMocks());
describe("conditional whole-value settings replacement", () => {
  it("uses persisted JSON equality for existing values and sends a complete replacement", async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const expected = {
      exists: true,
      value: { nested: { a: 1, b: 2 }, remove: true },
    };
    const value = { nested: { a: 3 }, array: [1, 2] };
    await expect(
      repo.replace("app_settings", value, expected),
    ).resolves.toMatchObject({ value, expected: { exists: true, value } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("AND value = $3::jsonb"),
      ["app_settings", JSON.stringify(value), JSON.stringify(expected.value)],
    );
  });
  it("rejects stale saves without an unconditional fallback", async () => {
    query.mockResolvedValue({ rowCount: 0 });
    await expect(
      repo.replace("app_settings", {}, { exists: true, value: {} }),
    ).rejects.toMatchObject({ status: 409 });
    expect(query).toHaveBeenCalledOnce();
  });
  it("uses insert-only creation, so a concurrent creator conflicts", async () => {
    query.mockResolvedValue({ rowCount: 0 });
    await expect(
      repo.replace("app_settings", {}, { exists: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls[0][0]).toContain("DO NOTHING RETURNING");
  });
  it("distinguishes persisted JSON null from absent rows and revives legacy display values only", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value: null }] })
      .mockResolvedValueOnce({ rows: [{ value: '{"mode":"dark"}' }] });
    expect(await repo.getRecord("theme_settings")).toEqual({
      expected: { exists: false },
    });
    expect(await repo.getRecord("theme_settings")).toEqual({
      value: null,
      expected: { exists: true, value: null },
    });
    expect(await repo.getRecord("theme_settings")).toEqual({
      value: { mode: "dark" },
      expected: { exists: true, value: '{"mode":"dark"}' },
    });
  });
  it("protects deletion with the loaded value", async () => {
    query.mockResolvedValue({ rowCount: 0 });
    await expect(
      repo.deleteExpected("app_settings", { exists: true, value: {} }),
    ).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls[0][0]).toContain("AND value = $2::jsonb");
  });
  it("wraps ordered bulk saves in one transaction and propagates conflict", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    await expect(
      repo.replaceMany(
        { theme_settings: {}, app_settings: {} },
        { theme_settings: { exists: false }, app_settings: { exists: false } },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(query.mock.calls.map((call) => call[1][0])).toEqual([
      "app_settings",
      "theme_settings",
    ]);
  });
});
