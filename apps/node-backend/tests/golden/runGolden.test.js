import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGolden } from "./runGolden.js";

let fixtureRoot;

async function writeFixture(relPath, body) {
  const full = join(fixtureRoot, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(body, null, 2), "utf8");
}

describe("runGolden harness", () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "vision-golden-harness-"));
  });

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("passes when actual matches expected", async () => {
    await writeFixture("ok.input.json", { n: 2 });
    await writeFixture("ok.expected.json", { doubled: 4 });
    await runGolden("ok", ({ n }) => ({ doubled: n * 2 }), fixtureRoot);
  });

  it("fails when actual diverges from expected", async () => {
    await writeFixture("drift.input.json", { n: 2 });
    await writeFixture("drift.expected.json", { doubled: 4 });
    await expect(
      runGolden("drift", ({ n }) => ({ doubled: n * 3 }), fixtureRoot),
    ).rejects.toThrow();
  });

  it("throws clearly when expected fixture is missing", async () => {
    await writeFixture("missing.input.json", { n: 1 });
    await expect(runGolden("missing", (i) => i, fixtureRoot)).rejects.toThrow(
      /UPDATE_GOLDENS=1/,
    );
  });
});
