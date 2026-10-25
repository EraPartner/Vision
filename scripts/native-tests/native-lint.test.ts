import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BASELINE_FILE,
  countHits,
  evaluate,
  formatBaseline,
  lowerBaseline,
  lintRepo,
  parseBaseline,
  RULE_IDS,
  scanSource,
  scanTree,
} from "../native-lint.ts";
import { repoPath } from "../lib/nativeCodegen.ts";

const UI = "apps/native/Sources/VisionNativeUI/Sample.swift";

function rulesFor(source: string, file = UI): string[] {
  return scanSource(source, file).map((h) => h.rule);
}

const POSITIVE: Record<string, { source: string; file?: string }> = {
  "force-cast": { source: "let a = b as! Foo" },
  "force-try": { source: "let a = try! load()" },
  "fatal-error": { source: 'fatalError("no")' },
  "unchecked-sendable": { source: "final class A: @unchecked Sendable {}" },
  "nonisolated-unsafe": { source: "nonisolated(unsafe) static var x = 1" },
  "any-hashable": { source: "let k: Set<AnyHashable> = []" },
  "string-any-dict": { source: "let d: [String: Any] = [:]" },
  "explicit-any": { source: "var token: Any?" },
  "implicit-unwrap": { source: "var view: NSView!" },
  "force-unwrap": { source: "let a = values[key]!" },
  "double-money": {
    source: "let total: Double = 1",
    file: "apps/native/Sources/VisionNativeCore/Screens/MoneyThing.swift",
  },
  "raw-id": { source: "let accountId: Int" },
  "raw-currency": { source: "func f(defaultCurrency: String) {}" },
  "string-literal-compare": { source: 'if kind == "income" {}' },
};

test("every rule has a positive case", () => {
  assert.deepEqual(Object.keys(POSITIVE).sort(), [...RULE_IDS].sort());
});

for (const [rule, { source, file }] of Object.entries(POSITIVE)) {
  test(`rule ${rule} fires and lint:allow suppresses it`, () => {
    assert.ok(rulesFor(source, file).includes(rule), `${rule} should fire`);
    const trailing = `${source} // lint:allow ${rule} because tested`;
    assert.ok(!rulesFor(trailing, file).includes(rule), "trailing allow");
    const above = `// lint:allow ${rule} because tested\n${source}`;
    assert.ok(!rulesFor(above, file).includes(rule), "allow on previous line");
    const wrong = `${source} // lint:allow other-rule because tested`;
    assert.ok(
      rulesFor(wrong, file).includes(rule),
      "other rule does not suppress",
    );
    const noReason = `${source} // lint:allow ${rule}`;
    assert.ok(rulesFor(noReason, file).includes(rule), "reason is required");
  });
}

test("case literal and reversed contexts are counted", () => {
  assert.ok(
    rulesFor('switch k { case "a": break default: break }').includes(
      "string-literal-compare",
    ),
  );
});

test("no false positives for comments, strings, operators and API layer", () => {
  const clean = [
    "// as! try! fatalError( @unchecked Sendable AnyHashable",
    "/* nested /* x! */ y as! Z */",
    'let s = "as! try! x! [String: Any] == \\"a\\""',
    'let t = """\n  value! as! Any\n  == "x"\n  """',
    'let u = #"raw x! Any"#',
    'let v = "a \\(count!) b"',
    "if a != b, !c, x != nil {}",
    "let f = !flag",
    "if !(a && b) {}",
    "let opt: Foo? = nil",
    "let ok = a == b",
    "func any(_ x: any Sendable) {}",
    "let flag = lhs != rhs && !other",
    "let fatalErrors = 1",
    "let accountIds: [Int] = []",
    "let accountId: AccountID",
    "let n: Double = 1",
  ].join("\n");
  assert.deepEqual(scanSource(clean, UI), []);
  const api = "apps/native/Sources/VisionNativeCore/API/Model.swift";
  assert.deepEqual(
    scanSource("let accountId: Int\nlet currency: String", api),
    [],
  );
});

test("force unwrap rule sees postfix bangs only", () => {
  const hits = scanSource(
    "a!.b\nc[0]!\nf()!\nx! == y\nx != y\nlet z: Foo! = nil",
    UI,
  );
  assert.deepEqual(
    hits.map((h) => `${h.line}:${h.rule}`),
    [
      "1:force-unwrap",
      "2:force-unwrap",
      "3:force-unwrap",
      "4:force-unwrap",
      "6:implicit-unwrap",
    ],
  );
});

test("line numbers survive multi-line strings and block comments", () => {
  const hits = scanSource(
    'let a = """\nx\ny\n"""\n/* c\n c */\nlet b = try! f()',
    UI,
  );
  assert.deepEqual(
    hits.map((h) => `${h.line}:${h.rule}`),
    ["7:force-try"],
  );
});

test("a seeded temp file fails the tree check and the Generated directory is skipped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-lint-"));
  try {
    const sources = path.join(root, "Sources");
    fs.mkdirSync(path.join(sources, "Generated"), { recursive: true });
    fs.writeFileSync(
      path.join(sources, "Generated", "G.swift"),
      "let a = try! f()\n",
    );
    fs.writeFileSync(
      path.join(sources, "Bad.swift"),
      "let a = try! f()\nlet b = x as! Y\n",
    );
    fs.writeFileSync(
      path.join(sources, "Ok.swift"),
      "let a = try! f() // lint:allow force-try ok\n",
    );
    const hits = scanTree(sources, root);
    assert.deepEqual(
      hits.map((h) => `${h.file}:${h.line}:${h.rule}`),
      ["Sources/Bad.swift:1:force-try", "Sources/Bad.swift:2:force-cast"],
    );
    const failures = evaluate(hits, new Map());
    assert.equal(failures.length, 2);
    assert.match(failures[0]!, /^Sources\/Bad\.swift:1: \[force-try\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ratchet fails on increases, prints file:line, and only ever lowers", () => {
  const file = "apps/native/Sources/VisionNativeUI/A.swift";
  const other = "apps/native/Sources/VisionNativeUI/B.swift";
  const baseline = parseBaseline(
    `string-literal-compare\t${file}\t1\nstring-literal-compare\t${other}\t2\n`,
  );
  const hit = (f: string, line: number) => ({
    rule: "string-literal-compare",
    file: f,
    line,
    text: 'x == "a"',
  });
  // Same total, moved between files: allowed.
  assert.deepEqual(
    evaluate([hit(file, 1), hit(file, 2), hit(other, 1)], baseline),
    [],
  );
  // Total rises: fails and names the file that grew.
  const failures = evaluate(
    [hit(file, 1), hit(file, 2), hit(other, 1), hit(other, 2)],
    baseline,
  );
  assert.match(
    failures[0]!,
    /string-literal-compare\].*4 hits, baseline 3 \(\+1\)/,
  );
  assert.ok(failures.some((f) => f.startsWith(`${file}:2:`)));
  // Update lowers counts but never raises or adds entries.
  const current = countHits([
    hit(file, 1),
    hit(file, 2),
    hit(repoPath("x"), 1),
  ]);
  const lowered = lowerBaseline(baseline, current);
  assert.equal(lowered.get("string-literal-compare")?.get(file), 1);
  assert.equal(lowered.get("string-literal-compare")?.has(other), false);
  assert.equal(lowered.get("string-literal-compare")?.size, 1);
  assert.ok(
    formatBaseline(lowered).includes(`string-literal-compare\t${file}\t1`),
  );
});

test("Swift sources have no un-annotated violations and stay within the baseline", () => {
  assert.ok(fs.existsSync(repoPath(BASELINE_FILE)), "baseline file exists");
  const started = performance.now();
  const { failures } = lintRepo();
  const elapsed = performance.now() - started;
  assert.deepEqual(failures, []);
  assert.ok(elapsed < 2000, `lint took ${Math.round(elapsed)} ms`);
});
