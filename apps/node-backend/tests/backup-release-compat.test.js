import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { openBundle } = require(
  join(repoRoot, "packaging/electron/backup/bundle.js"),
);

describe("backup release compatibility", () => {
  it("opens the sanitized bundle produced by Vision 1.0.2", async () => {
    const fixturePath = join(
      repoRoot,
      "packaging/electron/backup/fixtures/vision-1.0.2-sanitized.visionbak.enc",
    );
    const fixtureBytes = await fsp.readFile(fixturePath);
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "096068975bedafbf7ac0e77a2c57ba4ee13bf4bf37b32bca5064fd27e3bbf766",
    );
    const result = await openBundle(fixturePath, {
      passphrase: "vision-v1.0.2-fixture",
    });
    try {
      expect(result.metadata.appVersion).toBe("1.0.2");
      expect(result.metadata.schemaHead).toBe("fixture_schema");
      expect(await fsp.readFile(result.dbSqlPath, "utf8")).toContain(
        "INSERT INTO fixture_probe VALUES (1, 'v1.0.2');",
      );
      expect(result.frontendState).toEqual({
        keys: { "vision.language": "nl" },
      });
      expect(
        await fsp.readFile(
          join(result.attachmentsDir, "tx-001", "receipt.txt"),
          "utf8",
        ),
      ).toBe("SANITIZED-RECEIPT");
    } finally {
      result.cleanup();
    }
  });
});
