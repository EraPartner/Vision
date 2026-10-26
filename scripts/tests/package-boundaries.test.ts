import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBoundaries, parseBunLock } from "../check-package-boundaries.ts";

type Dependencies = Record<string, string>;

interface Manifest {
  name: string;
  private: boolean;
  scripts?: Record<string, string>;
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
}

interface LockWorkspace {
  name: string;
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
}

interface Lock {
  workspaces: Record<string, LockWorkspace>;
  packages: Record<string, unknown[]>;
}

interface Fixtures {
  manifests: Map<string, Manifest>;
  rootLock: Lock;
  electronLock: Lock;
}

const entries: [string, string][] = [
  ["package.json", "vision"],
  ["apps/frontend/package.json", "vision-frontend"],
  ["apps/node-backend/package.json", "financial-transaction-manager-node"],
  ["packages/shared-utils/package.json", "@vision/shared-utils"],
  ["packages/types/package.json", "@vision/types"],
  ["packaging/electron/package.json", "vision-desktop"],
];

function fixtures(): Fixtures {
  const manifests = new Map<string, Manifest>(
    entries.map(([p, name]) => [p, { name, private: true }]),
  );
  const rootLock: Lock = { workspaces: {}, packages: {} };
  const electronLock: Lock = {
    workspaces: { "": { name: "vision-desktop" } },
    packages: {},
  };
  for (const [pathname, name] of entries.slice(0, -1)) {
    const key =
      pathname === "package.json"
        ? ""
        : pathname.slice(0, -"/package.json".length);
    rootLock.workspaces[key] = { name };
  }
  return { manifests, rootLock, electronLock };
}

function manifest(state: Fixtures, pathname: string): Manifest {
  const value = state.manifests.get(pathname);
  assert.ok(value, `${pathname} fixture must exist`);
  return value;
}

function workspace(lock: Lock, key: string): LockWorkspace {
  const value = lock.workspaces[key];
  assert.ok(value, `${key} lock workspace fixture must exist`);
  return value;
}

function errors(state: Fixtures): string {
  return checkBoundaries(
    state.manifests,
    state.rootLock,
    state.electronLock,
  ).join("\n");
}

void test("parses Bun trailing commas without corrupting quoted text", () => {
  assert.deepEqual(parseBunLock('{"a": "x, }", "b": [1,],}'), {
    a: "x, }",
    b: [1],
  });
});

void test("all current internal package names remain private", () => {
  const state = fixtures();
  assert.deepEqual(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock),
    [],
  );
  manifest(state, "apps/node-backend/package.json").private = false;
  assert.match(errors(state), /private: true/);
});

void test("a new internal manifest requires an explicit policy update", () => {
  const state = fixtures();
  state.manifests.set("packages/new/package.json", {
    name: "@vision/new",
    private: true,
  });
  assert.match(errors(state), /Unreviewed package manifest/);
});

void test("a public-registry shadow of an internal package is rejected", () => {
  const state = fixtures();
  state.rootLock.packages["@vision/types"] = [
    "@vision/types@9.9.9",
    "",
    {},
    "sha512-evil",
  ];
  assert.match(errors(state), /resolves outside/);
});

void test("internal dependency names cannot use registry specifiers", () => {
  const state = fixtures();
  manifest(state, "apps/frontend/package.json").dependencies = {
    "@vision/types": "^1.0.0",
  };
  assert.match(errors(state), /reviewed workspace dependency/);
});

void test("manifest changes without a matching lockfile are rejected", () => {
  const state = fixtures();
  manifest(state, "apps/frontend/package.json").dependencies = {
    react: "^99.0.0",
  };
  assert.match(errors(state), /differs from the committed lockfile/);
});

void test("external dependency sources and records without integrity are rejected", () => {
  const state = fixtures();
  manifest(state, "package.json").devDependencies = {
    example: "github:owner/repo",
  };
  workspace(state.rootLock, "").devDependencies = {
    example: "github:owner/repo",
  };
  state.rootLock.packages.example = ["example@1.0.0", "", {}, ""];
  assert.match(errors(state), /unreviewed external dependency source example/);
  assert.match(errors(state), /missing integrity digest/);
});

void test("new executable install hooks require a policy review", () => {
  const state = fixtures();
  manifest(state, "apps/frontend/package.json").scripts = {
    postinstall: "node setup.js",
  };
  assert.match(errors(state), /unreviewed executable install hook postinstall/);
});

void test("admits only the reviewed xlsx tarball with its pinned integrity", () => {
  const url = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
  const integrity =
    "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==";
  const state = fixtures();
  manifest(state, "apps/frontend/package.json").dependencies = {
    xlsx: url,
  };
  workspace(state.rootLock, "apps/frontend").dependencies = { xlsx: url };
  state.rootLock.packages.xlsx = [`xlsx@${url}`, {}, integrity];
  assert.deepEqual(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock),
    [],
  );

  state.rootLock.packages.xlsx = [`xlsx@${url}`, {}, "sha512-AAAA"];
  assert.match(errors(state), /xlsx has an unreviewed source/);

  const other = "https://cdn.sheetjs.com/xlsx-0.20.4/xlsx-0.20.4.tgz";
  manifest(state, "apps/frontend/package.json").dependencies = {
    xlsx: other,
  };
  assert.match(errors(state), /unreviewed external dependency source xlsx/);
});
