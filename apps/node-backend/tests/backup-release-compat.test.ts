import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
// The compiled CommonJS module is loaded at run time, so the part of its shape
// this test reads is declared here (importing the source's types would pull in
// the untyped yauzl dependency).
interface OpenedBundle {
  metadata: Readonly<Record<string, unknown>>;
  databasePath: string;
  attachmentsDir: string | null;
  frontendState: unknown;
  cleanup: () => void;
}
interface BundleModule {
  openBundle: (
    bundlePath: string,
    options?: { passphrase?: string | null },
  ) => Promise<OpenedBundle>;
}
const require = createRequire(import.meta.url);
const { openBundle } = require(
  join(repoRoot, "packaging/electron/out/backup/bundle.js"),
) as BundleModule;

describe("backup release compatibility", () => {
  // Vision 1.0.2 wrote an encrypted format-1 bundle. It still decrypts with its
  // passphrase, and is then refused by its declared format rather than as a
  // wrong passphrase or a corrupt file.
  it("refuses the bundle produced by Vision 1.0.2 by its format", async () => {
    const fixturePath = join(
      repoRoot,
      "packaging/electron/backup/fixtures/vision-1.0.2-sanitized.visionbak.enc",
    );
    const fixtureBytes = await fsp.readFile(fixturePath);
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "096068975bedafbf7ac0e77a2c57ba4ee13bf4bf37b32bca5064fd27e3bbf766",
    );
    const failure: unknown = await openBundle(fixturePath, {
      passphrase: "vision-v1.0.2-fixture",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: unknown }).code).toBe("BACKUP_FORMAT_UNSUPPORTED");
    expect((failure as Error).message).toContain("backup format 1");
  });
});
