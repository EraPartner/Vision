import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// This is a complete file inventory, not a claim of semantic review. Boundary
// labels are conservative source/path cues; detailed reviewed decisions live
// in coverage-ledger.json. Exact source matches are candidates, never deletions.
const paths = [
  ...new Set(
    execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "apps",
        "packages",
        "packaging/electron",
        "scripts",
        ".github",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n"),
  ),
]
  .filter(
    (path) =>
      /(?:\.(?:test|spec)\.(?:[cm]?[jt]sx?|py)|(?:^|\/)test_[^/]+\.py|(?:^|\/)[^/]+-test\.sh)$/.test(
        path,
      ) && existsSync(path),
  )
  .sort();
const fingerprints = new Map();
const files = paths.map((path) => {
  const source = readFileSync(path, "utf8");
  const boundary = path.endsWith("vision.browser.test.mjs")
    ? "real-browser-and-database-authored"
    : path.includes("browser-tests/yahoo-provider-fixture.test")
      ? "controlled-provider-protocol-test"
      : path.includes("live-contracts/")
        ? "live-http-contract"
        : /\.db\.test\./.test(path)
          ? "database-test"
          : /fast-check|\.property\.test\./.test(source + path)
            ? "property-test"
            : path.startsWith("packaging/electron/")
              ? "native-runtime-or-filesystem-test"
              : /@testing-library\/react|@vitest-environment jsdom/.test(source)
                ? "simulated-dom"
                : /readFileSync|readFile\(/.test(source) &&
                    /className|\.tsx?["'`]/.test(source)
                  ? "source-or-file-contract"
                  : /vi\.mock|jest\.mock/.test(source)
                    ? "mocked-unit-or-service"
                    : "unit-script-or-contract-needs-review";
  const flags = [];
  if (
    /readFileSync|readFile\(/.test(source) &&
    /className|\.tsx?["'`]/.test(source)
  )
    flags.push("source-assertion-review");
  if (/mock\.calls\[|toHaveBeenNthCalledWith/.test(source))
    flags.push("call-order-review");
  if (/golden|toMatchSnapshot|toMatchInlineSnapshot/.test(source + path))
    flags.push("expected-output-provenance-review");
  const hash = createHash("sha256").update(source).digest("hex");
  fingerprints.set(hash, [...(fingerprints.get(hash) ?? []), path]);
  return {
    path,
    inferredBoundary: boundary,
    decision: "retain unless detailed reviewed ledger says otherwise",
    ...(flags.length ? { reviewFlags: flags } : {}),
  };
});
const counts = {};
for (const file of files)
  counts[file.inferredBoundary] = (counts[file.inferredBoundary] ?? 0) + 1;
const result = {
  generatedOn: new Date().toISOString().slice(0, 10),
  scope:
    "Tracked and nonignored test/spec files in apps, packages, packaging/electron, scripts and .github; helpers and ignored build outputs excluded",
  interpretation:
    "Automated boundary classification only; no execution, pass count, coverage percentage, or independent expected-value correctness is inferred",
  totalFiles: files.length,
  counts,
  identicalSourceGroups: [...fingerprints.values()].filter(
    (group) => group.length > 1,
  ),
  files,
};
writeFileSync(
  "scripts/browser-tests/test-file-inventory.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      totalFiles: result.totalFiles,
      counts,
      identicalSourceGroups: result.identicalSourceGroups,
    },
    null,
    2,
  ),
);
