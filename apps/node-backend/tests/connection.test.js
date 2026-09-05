import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConnectionModule({
  settings = {
    database: {
      url: "postgresql://test",
      poolSize: 5,
      maxOverflow: 10,
      echo: false,
    },
  },
} = {}) {
  vi.resetModules();

  const pool = {
    on: vi.fn(),
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    totalCount: 3,
    idleCount: 2,
    waitingCount: 1,
  };

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  const poolCtor = vi.fn().mockImplementation(function MockPool() {
    return pool;
  });

  vi.doMock("pg", () => ({
    default: {
      Pool: poolCtor,
    },
  }));

  vi.doMock("../src/config/config.js", () => ({
    default: settings,
  }));

  vi.doMock("../src/config/logger.js", () => ({
    logger,
  }));

  const module = await import("../src/database/connection.js");
  return { module, pool, poolCtor, logger };
}

describe("database connection module", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("logs idle client pool errors through logger.error", async () => {
    const { pool, logger } = await loadConnectionModule();

    const onErrorCall = pool.on.mock.calls.find(([event]) => event === "error");
    expect(onErrorCall).toBeDefined();

    const err = new Error("idle client failure");
    onErrorCall[1](err);

    expect(logger.error).toHaveBeenCalledWith(
      "Unexpected error on idle database client",
      err,
    );
  });

  it("query retries once on transient ECONNRESET and then succeeds", async () => {
    vi.useFakeTimers();
    const { module, pool, logger } = await loadConnectionModule();

    pool.query
      .mockRejectedValueOnce(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      )
      .mockResolvedValueOnce({ rows: [{ ok: true }] });

    const queryPromise = module.query("SELECT 1", [], { retries: 1 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await queryPromise;

    expect(result).toEqual({ rows: [{ ok: true }] });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("query does not retry non-transient errors", async () => {
    const { module, pool, logger } = await loadConnectionModule();
    const err = Object.assign(new Error("syntax"), { code: "42601" });
    pool.query.mockRejectedValueOnce(err);

    await expect(
      module.query("SELECT bad", [], { retries: 2 }),
    ).rejects.toThrow("syntax");

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("query throws after max retries for transient errors and logs error", async () => {
    vi.useFakeTimers();
    const { module, pool, logger } = await loadConnectionModule();

    const transient = Object.assign(
      new Error("Connection terminated by server"),
      { code: "08006" },
    );
    pool.query.mockRejectedValue(transient);

    const queryPromise = module.query("SELECT 1", [], { retries: 1 });
    const rejectionAssertion = expect(queryPromise).rejects.toThrow(
      "Connection terminated by server",
    );
    await vi.advanceTimersByTimeAsync(200);

    await rejectionAssertion;
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("checkConnection returns true on success and false on failure", async () => {
    const loaded = await loadConnectionModule();
    loaded.pool.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    await expect(loaded.module.checkConnection()).resolves.toBe(true);

    loaded.pool.query.mockRejectedValueOnce(new Error("down"));
    await expect(loaded.module.checkConnection()).resolves.toBe(false);
  });

  it("getTableCount parses integer from rows[0].count", async () => {
    const { module, pool } = await loadConnectionModule();
    pool.query.mockResolvedValueOnce({ rows: [{ count: "42" }] });

    await expect(module.getTableCount()).resolves.toBe(42);
  });

  it("getPoolStats exposes pool counters and configured maxConnections", async () => {
    const { module } = await loadConnectionModule({
      settings: {
        database: {
          url: "postgresql://test",
          poolSize: 4,
          maxOverflow: 12,
          echo: false,
        },
      },
    });

    expect(module.getPoolStats()).toEqual({
      totalCount: 3,
      idleCount: 2,
      waitingCount: 1,
      maxConnections: 12,
    });
  });

  it("closePool calls pool.end", async () => {
    const { module, pool } = await loadConnectionModule();
    pool.end.mockResolvedValueOnce(undefined);

    await module.closePool();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("queryPrepared sends named prepared statement object to pool.query", async () => {
    const { module, pool } = await loadConnectionModule();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await module.queryPrepared("select-one", "SELECT 1", [1]);

    expect(pool.query).toHaveBeenCalledWith({
      name: "select-one",
      text: "SELECT 1",
      values: [1],
    });
  });

  it("getClient proxies to pool.connect", async () => {
    const { module, pool } = await loadConnectionModule();
    const mockClient = { release: vi.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);

    await expect(module.getClient()).resolves.toBe(mockClient);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  describe("ambient transaction (AsyncLocalStorage reroute)", () => {
    function mockTxClient() {
      return {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
    }

    it("module-level query() joins the withTransaction client instead of the pool", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);

      await module.withTransaction(async () => {
        await module.query("INSERT INTO t VALUES (1)");
      });

      // BEGIN, the rerouted INSERT, COMMIT — all on the tx client; pool untouched.
      const clientSql = client.query.mock.calls.map((c) => c[0]);
      expect(clientSql).toEqual([
        "BEGIN",
        "INSERT INTO t VALUES (1)",
        "COMMIT",
      ]);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("query() outside a transaction still uses the pool", async () => {
      const { module, pool } = await loadConnectionModule();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await module.query("SELECT 1");
      expect(pool.query).toHaveBeenCalledWith("SELECT 1", undefined);
      expect(module.__getAmbientTransactionClient()).toBeNull();
    });

    it("a continuation leaked past the transaction falls back to the pool", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);
      pool.query.mockResolvedValue({ rows: [] });

      let leaked;
      await module.withTransaction(async () => {
        leaked = () => module.query("SELECT after");
      });
      await leaked();

      // The leaked query ran after release — it must NOT hit the released client.
      expect(client.query.mock.calls.map((c) => c[0])).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(pool.query).toHaveBeenCalledWith("SELECT after", undefined);
    });

    it("withSavepointIfInTransaction releases on success and rolls back to the savepoint on failure", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);

      await module.withTransaction(async () => {
        await module.withSavepointIfInTransaction("sp_ok", async () => "fine");
        await expect(
          module.withSavepointIfInTransaction("sp_fail", async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
      });

      expect(client.query.mock.calls.map((c) => c[0])).toEqual([
        "BEGIN",
        "SAVEPOINT sp_ok",
        "RELEASE SAVEPOINT sp_ok",
        "SAVEPOINT sp_fail",
        "ROLLBACK TO SAVEPOINT sp_fail",
        "COMMIT",
      ]);
    });

    it("nested withTransaction reuses one client and unique savepoints at every depth", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);
      const callbackClients = [];

      await module.withTransaction(async (outerClient) => {
        callbackClients.push(outerClient);
        await module.withTransaction(async (innerClient) => {
          callbackClients.push(innerClient);
          await module.query("INSERT INTO t VALUES (1)");
          await module.withTransaction(async (deepClient) => {
            callbackClients.push(deepClient);
            await module.query("INSERT INTO t VALUES (2)");
          });
        });
      });

      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(callbackClients).toEqual([client, client, client]);
      expect(client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN",
        "SAVEPOINT vision_nested_tx_1",
        "INSERT INTO t VALUES (1)",
        "SAVEPOINT vision_nested_tx_2",
        "INSERT INTO t VALUES (2)",
        "RELEASE SAVEPOINT vision_nested_tx_2",
        "RELEASE SAVEPOINT vision_nested_tx_1",
        "COMMIT",
      ]);
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it("rejects concurrent sibling nesting after the active savepoint settles", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);

      await expect(
        module.withTransaction(async () =>
          Promise.all([
            module.withTransaction(async () => {
              await module.query("INSERT sibling one");
            }),
            module.withTransaction(async () => {
              await module.query("INSERT sibling two");
            }),
          ]),
        ),
      ).rejects.toThrow(
        "Concurrent sibling withTransaction calls are not supported; await nested transactions sequentially",
      );

      expect(client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN",
        "SAVEPOINT vision_nested_tx_1",
        "INSERT sibling one",
        "RELEASE SAVEPOINT vision_nested_tx_1",
        "ROLLBACK",
      ]);
    });

    it("a caught nested withTransaction failure rolls back only its savepoint", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);

      await module.withTransaction(async () => {
        await expect(
          module.withTransaction(async () => {
            await module.query("INSERT INTO t VALUES (1)");
            throw new Error("inner failure");
          }),
        ).rejects.toThrow("inner failure");

        await module.query("INSERT INTO t VALUES (2)");
      });

      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN",
        "SAVEPOINT vision_nested_tx_1",
        "INSERT INTO t VALUES (1)",
        "ROLLBACK TO SAVEPOINT vision_nested_tx_1",
        "INSERT INTO t VALUES (2)",
        "COMMIT",
      ]);
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it("preserves the original nested error when savepoint rollback fails", async () => {
      const { module, pool, logger } = await loadConnectionModule();
      const original = new Error("original failure");
      const rollbackError = new Error("savepoint rollback failed");
      const client = mockTxClient();
      client.query.mockImplementation(async (sql) => {
        if (sql === "ROLLBACK TO SAVEPOINT vision_nested_tx_1") {
          throw rollbackError;
        }
        return { rows: [] };
      });
      pool.connect.mockResolvedValueOnce(client);

      await expect(
        module.withTransaction(async () => {
          await module.withTransaction(async () => {
            throw original;
          });
        }),
      ).rejects.toBe(original);

      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        "ROLLBACK TO SAVEPOINT vision_nested_tx_1 failed",
        rollbackError,
      );
      expect(client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN",
        "SAVEPOINT vision_nested_tx_1",
        "ROLLBACK TO SAVEPOINT vision_nested_tx_1",
        "ROLLBACK",
      ]);
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it("invalidates an inherited async continuation after the transaction releases", async () => {
      const { module, pool } = await loadConnectionModule();
      const client = mockTxClient();
      pool.connect.mockResolvedValueOnce(client);
      pool.query.mockResolvedValue({ rows: [] });
      let releaseContinuation;
      const gate = new Promise((resolve) => {
        releaseContinuation = resolve;
      });
      let continuation;

      await module.withTransaction(async () => {
        continuation = (async () => {
          await gate;
          return module.query("SELECT after inherited context");
        })();
      });

      releaseContinuation();
      await continuation;

      expect(client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(pool.query).toHaveBeenCalledWith(
        "SELECT after inherited context",
        undefined,
      );
    });

    it("withSavepointIfInTransaction is a passthrough outside a transaction", async () => {
      const { module, pool } = await loadConnectionModule();
      await expect(
        module.withSavepointIfInTransaction("sp", async () => 42),
      ).resolves.toBe(42);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
