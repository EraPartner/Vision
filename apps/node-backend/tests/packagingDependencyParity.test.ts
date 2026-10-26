import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = resolve(import.meta.dirname, "../../..");
const backendRequire = createRequire(import.meta.url);
const packagingRequire = createRequire(
  join(repoRoot, "packaging/electron/package.json"),
);

const backendManifest = z.object({
  devDependencies: z.object({ yauzl: z.string() }),
});
const packagingManifest = z.object({
  dependencies: z.object({ yauzl: z.string() }),
});
const yauzlManifest = z.object({ version: z.string() });

describe("packaging dependency parity", () => {
  it("tests the same yauzl version that the Electron app ships", () => {
    const backendPackage = backendManifest.parse(
      backendRequire("../package.json"),
    );
    const packagingPackage = packagingManifest.parse(
      packagingRequire("./package.json"),
    );
    const backendYauzl = yauzlManifest.parse(
      backendRequire("yauzl/package.json"),
    );
    const packagingYauzl = yauzlManifest.parse(
      packagingRequire("yauzl/package.json"),
    );

    expect(packagingPackage.dependencies.yauzl).toBe(
      backendPackage.devDependencies.yauzl,
    );
    expect(packagingYauzl.version).toBe(backendYauzl.version);
  });
});
