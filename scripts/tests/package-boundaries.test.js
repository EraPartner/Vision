"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkBoundaries,
  parseBunLock,
} = require("../check-package-boundaries.js");

const entries = [
  ["package.json", "vision"],
  ["apps/frontend/package.json", "vision-frontend"],
  ["apps/node-backend/package.json", "financial-transaction-manager-node"],
  ["packages/shared-utils/package.json", "@vision/shared-utils"],
  ["packages/types/package.json", "@vision/types"],
  ["packaging/electron/package.json", "vision-desktop"],
];

function fixtures() {
  const manifests = new Map(
    entries.map(([p, name]) => [p, { name, private: true }]),
  );
  const rootLock = { workspaces: {}, packages: {} };
  const electronLock = {
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

test("parses Bun trailing commas without corrupting quoted text", () => {
  assert.deepEqual(parseBunLock('{"a": "x, }", "b": [1,],}'), {
    a: "x, }",
    b: [1],
  });
});

test("all current internal package names remain private", () => {
  const state = fixtures();
  assert.deepEqual(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock),
    [],
  );
  state.manifests.get("apps/node-backend/package.json").private = false;
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /private: true/,
  );
});

test("a new internal manifest requires an explicit policy update", () => {
  const state = fixtures();
  state.manifests.set("packages/new/package.json", {
    name: "@vision/new",
    private: true,
  });
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /Unreviewed package manifest/,
  );
});

test("a public-registry shadow of an internal package is rejected", () => {
  const state = fixtures();
  state.rootLock.packages["@vision/types"] = [
    "@vision/types@9.9.9",
    "",
    {},
    "sha512-evil",
  ];
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /resolves outside/,
  );
});

test("internal dependency names cannot use registry specifiers", () => {
  const state = fixtures();
  state.manifests.get("apps/frontend/package.json").dependencies = {
    "@vision/types": "^1.0.0",
  };
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /reviewed workspace dependency/,
  );
});

test("manifest changes without a matching lockfile are rejected", () => {
  const state = fixtures();
  state.manifests.get("apps/frontend/package.json").dependencies = {
    react: "^99.0.0",
  };
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /differs from the committed lockfile/,
  );
});

test("external dependency sources and records without integrity are rejected", () => {
  const state = fixtures();
  state.manifests.get("package.json").devDependencies = {
    example: "github:owner/repo",
  };
  state.rootLock.workspaces[""].devDependencies = {
    example: "github:owner/repo",
  };
  state.rootLock.packages.example = ["example@1.0.0", "", {}, ""];
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /unreviewed external dependency source example/,
  );
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /missing integrity digest/,
  );
});

test("new executable install hooks require a policy review", () => {
  const state = fixtures();
  state.manifests.get("apps/frontend/package.json").scripts = {
    postinstall: "node setup.js",
  };
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /unreviewed executable install hook postinstall/,
  );
});

test("admits only the reviewed xlsx tarball with its pinned integrity", () => {
  const url = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
  const integrity =
    "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==";
  const state = fixtures();
  state.manifests.get("apps/frontend/package.json").dependencies = {
    xlsx: url,
  };
  state.rootLock.workspaces["apps/frontend"].dependencies = { xlsx: url };
  state.rootLock.packages.xlsx = [`xlsx@${url}`, {}, integrity];
  assert.deepEqual(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock),
    [],
  );

  state.rootLock.packages.xlsx = [`xlsx@${url}`, {}, "sha512-AAAA"];
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /xlsx has an unreviewed source/,
  );

  const other = "https://cdn.sheetjs.com/xlsx-0.20.4/xlsx-0.20.4.tgz";
  state.manifests.get("apps/frontend/package.json").dependencies = {
    xlsx: other,
  };
  assert.match(
    checkBoundaries(state.manifests, state.rootLock, state.electronLock).join(
      "\n",
    ),
    /unreviewed external dependency source xlsx/,
  );
});
