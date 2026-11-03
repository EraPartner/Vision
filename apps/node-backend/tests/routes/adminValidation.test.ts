/**
 * Admin route request validation (ADR-193): database maintenance, the data
 * editor and provider probes. Runs the REAL admin router; the database,
 * dbEditor service and provider health service are mocked.
 */
import { bodyAt } from "../helpers/responseBody.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.ts";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";
import { mockConnection } from "../helpers/repoMocks.ts";

vi.mock("../../src/database/connection.ts", () =>
  mockConnection({
    checkConnection: vi.fn(),
    getTableCount: vi.fn(),
    getClient: vi.fn(),
    query: vi.fn(),
    withExclusiveWriter: vi.fn(),
  }),
);

vi.mock("../../src/config/config.ts", () => ({
  default: {
    admin: { enableResetDb: true },
    isDevelopment: () => true,
    security: { devBypass: false },
    rateLimit: { globalMax: 1000, globalWindowMs: 60_000 },
  },
}));

vi.mock("../../src/config/logger.ts", () => ({ logger: mockLogger() }));

vi.mock("../../src/services/priceProviderService.ts", () => ({
  sanitizePersistedKinesisHistory: vi.fn(),
}));

vi.mock("../../src/services/providerHealthService.ts", () => ({
  listProviderHealth: vi.fn(),
  probeProvider: vi.fn(),
}));

vi.mock("../../src/services/dbEditor.ts", () => ({
  getTableMeta: vi.fn(),
  listUserTables: vi.fn(),
  readRows: vi.fn(),
  applyMutations: vi.fn(),
}));

import {
  getClient,
  query,
  withExclusiveWriter,
  withTransaction,
} from "../../src/database/connection.ts";
import {
  applyMutations,
  getTableMeta,
  listUserTables,
  readRows,
} from "../../src/services/dbEditor.ts";
import { probeProvider } from "../../src/services/providerHealthService.ts";

const { default: adminRouter, prettySize } = await import("../../src/routes/admin.ts");

const api = routeAgent(adminRouter, { mountPath: "/api/admin" });
const BASE = "/api/admin";

function expectValidationError(res: { body: unknown }, message: RegExp) {
  expect(res.body).toEqual(
    errEnvelope({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(message),
    }),
  );
}

describe("Admin route request validation", () => {
  /** The writer connection withExclusiveWriter hands out. */
  const writer = { exec: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listUserTables).mockResolvedValue(
      new Set(["accounts", "transactions"]),
    );
    vi.mocked(withExclusiveWriter).mockImplementation(
      // The route only calls exec() on the writer.
      (fn) => Promise.resolve(fn(writer as never)),
    );
    writer.exec.mockReturnValue(undefined);
    vi.mocked(readRows).mockResolvedValue({} as never);
    vi.mocked(applyMutations).mockResolvedValue({ dryRun: true } as never);
  });

  describe("POST /database/vacuum", () => {
    it("vacuums the file, then analyzes one allow-listed table or all tables", async () => {
      await api
        .post(`${BASE}/database/vacuum`)
        .send({ table: "transactions" })
        .expect(200);
      expect(writer.exec.mock.calls).toEqual([
        ["VACUUM"],
        ['ANALYZE "transactions"'],
        ["PRAGMA optimize"],
      ]);
      writer.exec.mockClear();
      const all = await api
        .post(`${BASE}/database/vacuum`)
        .send({ table: null })
        .expect(200);
      expect(writer.exec.mock.calls).toEqual([
        ["VACUUM"],
        ["ANALYZE"],
        ["PRAGMA optimize"],
      ]);
      expect(bodyAt(all, "data")).toEqual({ vacuumed: "all" });
    });

    it("runs VACUUM on the exclusive writer, outside any transaction", async () => {
      // SQLite refuses VACUUM inside a transaction; there is no per-table
      // privilege to check (PostgreSQL's MAINTAIN), so the guarantee is that
      // nothing else holds the writer while it runs.
      await api
        .post(`${BASE}/database/vacuum`)
        .send({ table: "accounts" })
        .expect(200);
      expect(withExclusiveWriter).toHaveBeenCalledOnce();
      expect(withTransaction).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it("reports a failed VACUUM instead of claiming success", async () => {
      writer.exec.mockImplementationOnce(() => {
        throw Object.assign(new Error("database is locked"), { code: "55P03" });
      });
      const res = await api
        .post(`${BASE}/database/vacuum`)
        .send({ table: "transactions" });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(writer.exec).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-string table and keeps the unknown-table message", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/database/vacuum`)
          .send({ table: ["transactions"] })
          .expect(400),
        /^table: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/database/vacuum`)
          .send({ table: "sqlite_schema" })
          .expect(400),
        /^Unknown table: sqlite_schema$/,
      );
      // Case-sensitive, as PostgreSQL's quoted identifiers were.
      expectValidationError(
        await api
          .post(`${BASE}/database/vacuum`)
          .send({ table: "Transactions" })
          .expect(400),
        /^Unknown table: Transactions$/,
      );
      expect(withExclusiveWriter).not.toHaveBeenCalled();
    });
  });

  describe("prettySize", () => {
    it("formats sizes exactly as pg_size_pretty did", () => {
      expect(
        [
          0, 1, 10239, 10240, 10751, 10752, 1048575, 1048576, 10485759,
          10485760, 20971520, 21474836480, 1099511627776, 1125899906842624,
          -10240,
        ].map(prettySize),
      ).toEqual([
        "0 bytes",
        "1 bytes",
        "10239 bytes",
        "10 kB",
        "10 kB",
        // Half rounding: 10752 bytes are 10.5 kB, which rounds up.
        "11 kB",
        "1024 kB",
        "1024 kB",
        "10 MB",
        "10 MB",
        "20 MB",
        "20 GB",
        "1024 GB",
        "1024 TB",
        "-10 kB",
      ]);
    });
  });

  describe("GET /database/tables/:table/rows", () => {
    it("passes parsed filters and paging to readRows", async () => {
      await api
        .get(`${BASE}/database/tables/transactions/rows`)
        .query({
          filters: JSON.stringify([{ column: "id", op: "gt", value: 3 }]),
          limit: "25",
          dir: "desc",
        })
        .expect(200);
      expect(readRows).toHaveBeenCalledWith("transactions", {
        limit: 25,
        cursor: undefined,
        orderBy: undefined,
        dir: "desc",
        where: undefined,
        filters: [{ column: "id", op: "gt", value: 3 }],
      });
    });

    it("rejects malformed filter JSON, a non-array and malformed clauses", async () => {
      expectValidationError(
        await api
          .get(`${BASE}/database/tables/transactions/rows`)
          .query({ filters: "{" })
          .expect(400),
        /^Invalid filters parameter: /,
      );
      expectValidationError(
        await api
          .get(`${BASE}/database/tables/transactions/rows`)
          .query({ filters: '{"column":"id"}' })
          .expect(400),
        /^Invalid filters parameter: filters must be an array$/,
      );
      // A null clause used to reach buildFilterFragment and crash with a 500.
      expectValidationError(
        await api
          .get(`${BASE}/database/tables/transactions/rows`)
          .query({ filters: "[null]" })
          .expect(400),
        /^Invalid filters parameter: 0: /,
      );
      expectValidationError(
        await api
          .get(`${BASE}/database/tables/transactions/rows`)
          .query("orderBy=id&orderBy=name")
          .expect(400),
        /^orderBy: /,
      );
      expect(readRows).not.toHaveBeenCalled();
    });
  });

  describe("POST /database/tables/:table/mutate", () => {
    const update = {
      op: "update",
      pk: { id: 1 },
      set: { note: "x" },
      xmin: "42",
    };

    it("passes typed changes and a boolean dry-run flag", async () => {
      await api
        .post(`${BASE}/database/tables/transactions/mutate`)
        .send({ changes: [update], dryRun: true })
        .expect(200);
      expect(applyMutations).toHaveBeenCalledWith("transactions", [update], {
        dryRun: true,
      });
    });

    it("rejects a string dry-run flag instead of committing the batch", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/database/tables/transactions/mutate`)
          .send({ changes: [update], dryRun: "true" })
          .expect(400),
        /^dryRun: /,
      );
      expect(applyMutations).not.toHaveBeenCalled();
    });

    it("rejects missing changes, unknown ops and non-object row maps", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/database/tables/transactions/mutate`)
          .send({})
          .expect(400),
        /^changes: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/database/tables/transactions/mutate`)
          .send({ changes: [{ op: "truncate" }] })
          .expect(400),
        /^changes\.0\.op: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/database/tables/transactions/mutate`)
          .send({ changes: [{ op: "insert", values: ["x"] }] })
          .expect(400),
        /^changes\.0\.values: /,
      );
      expect(applyMutations).not.toHaveBeenCalled();
    });
  });

  it("delegates schema reads and provider probes with string params", async () => {
    vi.mocked(getTableMeta).mockResolvedValue({} as never);
    vi.mocked(probeProvider).mockResolvedValue({} as never);
    await api.get(`${BASE}/database/tables/transactions/schema`).expect(200);
    await api.post(`${BASE}/providers/yahoo/probe`).expect(200);
    expect(getTableMeta).toHaveBeenCalledWith("transactions");
    expect(probeProvider).toHaveBeenCalledWith("yahoo");
  });

  it("rejects a non-boolean reset confirmation", async () => {
    expectValidationError(
      await api
        .post(`${BASE}/database/reset`)
        .send({ force: "true" })
        .expect(400),
      /^force: /,
    );
  });
});
