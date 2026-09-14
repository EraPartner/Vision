import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

function migration(name) {
  return readFileSync(resolve(repoRoot, "alembic/versions", name), "utf8");
}

describe("analysis and broker-history migrations", () => {
  it("creates forward-only broker snapshots without historical backfill", () => {
    const source = migration("0109_forward_only_broker_history.py");
    const upgrade = source.slice(
      source.indexOf("def upgrade"),
      source.indexOf("def downgrade"),
    );

    expect(upgrade).toContain("CREATE TABLE portfolio_broker_snapshots");
    expect(upgrade).not.toMatch(/INSERT\s+INTO/i);
    expect(upgrade).not.toContain("portfolio_performance_snapshots");
    expect(source).toContain("DROP TABLE IF EXISTS portfolio_broker_snapshots");
  });

  it("creates immutable saved definitions and durable run state", () => {
    const source = migration("0110_saved_analyses.py");

    expect(source).toContain("CREATE TABLE saved_analyses");
    expect(source).toContain("CREATE TABLE saved_analysis_definition_versions");
    expect(source).toContain("CREATE TABLE saved_analysis_runs");
    expect(source).toContain("reject_saved_analysis_version_update");
    expect(source).toContain("RAISE EXCEPTION");
    expect(source).toContain("DROP TABLE IF EXISTS saved_analysis_runs");
    expect(source).toContain("DROP TABLE IF EXISTS saved_analyses");
  });

  it("creates recoverable AI research and disclosure state with a reversible downgrade", () => {
    const source = migration("0111_ai_research_investigations.py");
    for (const table of [
      "ai_research_documents",
      "ai_research_passages",
      "ai_investigation_jobs",
      "ai_investigation_steps",
      "ai_disclosure_grants",
      "ai_disclosure_records",
    ]) {
      expect(source).toContain(`CREATE TABLE ${table}`);
      expect(source).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    expect(source).toContain("preview_payload_sha256");
    expect(source).toContain("max_disclosure_units");
    expect(source).toContain("cloud-synthesis-selected");
    expect(source).toContain("ADD COLUMN state_json");
    expect(source).toContain("DROP COLUMN IF EXISTS state_json");
  });
});
