import { describe, expect, it } from "vitest";
import { __validateAnalysisSql } from "../src/services/analysisExecutor.js";

describe("analysis SQL boundary", () => {
  it("accepts declared approved datasets, CTEs, joins, aggregates, and windows", () => {
    const sql = `WITH monthly AS (
      SELECT account_id, SUM(spending_amount) AS spend
      FROM vision_analysis.cash_flows_v1 GROUP BY account_id
    )
    SELECT a.account_name, m.spend, rank() OVER (ORDER BY m.spend DESC)
    FROM monthly m JOIN vision_analysis.accounts_v1 a ON a.account_id = m.account_id`;
    expect(__validateAnalysisSql(sql, ["cash-flows", "accounts"])).toContain(
      "rank()",
    );
  });

  it.each([
    "UPDATE vision_analysis.cash_flows_v1 SET signed_amount=0",
    "SELECT * FROM public.transactions",
    "SELECT pg_read_file('/etc/passwd') FROM vision_analysis.accounts_v1",
    "SELECT pg_sleep(1) FROM vision_analysis.accounts_v1",
    "SELECT * FROM vision_analysis.accounts_v1; SELECT 1",
    "COPY vision_analysis.accounts_v1 TO PROGRAM 'false'",
    'SELECT * FROM "public"."transactions"',
  ])("rejects unsafe SQL: %s", (sql) => {
    expect(() => __validateAnalysisSql(sql, ["accounts"])).toThrow();
  });

  it("rejects approved but undeclared datasets", () => {
    expect(() =>
      __validateAnalysisSql("SELECT * FROM vision_analysis.transactions_v1", [
        "accounts",
      ]),
    ).toThrow("not declared");
    expect(() =>
      __validateAnalysisSql(
        'SELECT * FROM "vision_analysis"."transactions_v1"',
        ["accounts"],
      ),
    ).toThrow("not declared");
  });

  it("requires a non-empty set of known dataset declarations", () => {
    expect(() => __validateAnalysisSql("SELECT 1", [])).toThrow(
      "must be declared",
    );
    expect(() => __validateAnalysisSql("SELECT 1", ["unknown"])).toThrow(
      "not approved",
    );
  });

  it("permits v2 hierarchy analysis while retaining saved v1 SQL", () => {
    expect(
      __validateAnalysisSql(
        "SELECT category_path FROM vision_analysis.transactions_v2",
        ["transactions"],
      ),
    ).toContain("category_path");
    expect(
      __validateAnalysisSql(
        "SELECT category_general FROM vision_analysis.transactions_v1",
        ["transactions"],
      ),
    ).toContain("category_general");
  });
});
