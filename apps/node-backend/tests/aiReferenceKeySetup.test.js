import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReferenceMappingKey } from "../src/services/aiReferenceKeySetup.js";

const directories = [];

function location() {
  const dir = mkdtempSync(join(tmpdir(), "vision-reference-setup-"));
  directories.push(dir);
  return join(dir, "runtime.env");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("reference key setup", () => {
  it("creates one private installation key and reuses it", () => {
    const filePath = location();
    writeFileSync(filePath, "DATABASE_URL=synthetic-value\n", { mode: 0o600 });
    const env = {};
    expect(ensureReferenceMappingKey({ filePath, env })).toEqual({
      created: true,
    });
    expect(env.AI_REFERENCE_MAPPING_KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(readFileSync(filePath, "utf8")).toContain(
      `AI_REFERENCE_MAPPING_KEY=${env.AI_REFERENCE_MAPPING_KEY}\n`,
    );
    expect(readFileSync(filePath, "utf8")).toContain(
      "DATABASE_URL=synthetic-value\n",
    );
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(ensureReferenceMappingKey({ filePath, env })).toEqual({
      created: false,
    });
  });

  it("refuses an existing invalid key without replacing it", () => {
    const filePath = location();
    writeFileSync(filePath, "AI_REFERENCE_MAPPING_KEY=invalid\n", {
      mode: 0o600,
    });
    expect(() => ensureReferenceMappingKey({ filePath, env: {} })).toThrow(
      "The existing reference mapping key is invalid",
    );
    expect(readFileSync(filePath, "utf8")).toBe(
      "AI_REFERENCE_MAPPING_KEY=invalid\n",
    );
  });

  it("fills a blank local key setting without adding a duplicate", () => {
    const filePath = location();
    writeFileSync(
      filePath,
      "DATABASE_URL=synthetic-value\nAI_REFERENCE_MAPPING_KEY=\n",
      {
        mode: 0o600,
      },
    );
    const env = {};
    expect(ensureReferenceMappingKey({ filePath, env })).toEqual({
      created: true,
    });
    expect(
      readFileSync(filePath, "utf8").match(/AI_REFERENCE_MAPPING_KEY=/g),
    ).toHaveLength(1);
    expect(readFileSync(filePath, "utf8")).toContain(
      `AI_REFERENCE_MAPPING_KEY=${env.AI_REFERENCE_MAPPING_KEY}\n`,
    );
  });

  it("refuses a symlinked configuration file", () => {
    const filePath = location();
    const target = `${filePath}.target`;
    writeFileSync(target, "synthetic target", { mode: 0o600 });
    symlinkSync(target, filePath);
    expect(() => ensureReferenceMappingKey({ filePath, env: {} })).toThrow(
      "The local environment file is not a regular file",
    );
    expect(readFileSync(target, "utf8")).toBe("synthetic target");
  });
});
