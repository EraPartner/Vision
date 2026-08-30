import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const backendRequire = createRequire(import.meta.url);
const packagingRequire = createRequire(
  join(repoRoot, "packaging/electron/package.json"),
);

describe("packaging dependency parity", () => {
  it("tests the same yauzl version that the Electron app ships", () => {
    const backendPackage = backendRequire("../package.json");
    const packagingPackage = packagingRequire("./package.json");
    const backendYauzl = backendRequire("yauzl/package.json");
    const packagingYauzl = packagingRequire("yauzl/package.json");

    expect(packagingPackage.dependencies.yauzl).toBe(
      backendPackage.devDependencies.yauzl,
    );
    expect(packagingYauzl.version).toBe(backendYauzl.version);
  });
});
