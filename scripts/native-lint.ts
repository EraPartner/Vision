#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import { repoPath } from "./lib/nativeCodegen.ts";

/**
 * Ban-list lint for hand-written Swift in apps/native/Sources (Generated
 * directories excluded). It runs inside `bun run native:test-generators`
 * through scripts/native-tests/native-lint.test.ts and in the pre-commit hook when Swift
 * sources are staged; there is no separate CI job.
 *
 *   bun scripts/native-lint.ts                   check against the baseline
 *   bun scripts/native-lint.ts --update-baseline lower baseline counts, never raise
 *
 * Strict rules have no baseline: every hit needs `// lint:allow <rule> <reason>`
 * on the same line or on the comment line directly above. Ratchet rules count
 * hits per file in apps/native/lint-baseline.txt; the total per rule may only
 * go down. Annotated hits are not counted for either kind.
 */

export const SOURCES_DIR = "apps/native/Sources";
export const BASELINE_FILE = "apps/native/lint-baseline.txt";

export type RuleKind = "strict" | "ratchet";

interface Rule {
  id: string;
  kind: RuleKind;
  description: string;
  /** Reports 0-based column offsets of hits in one masked code line. */
  find: (code: string, file: string) => number[];
}

function matches(re: RegExp, code: string): number[] {
  const out: number[] = [];
  for (const m of code.matchAll(re)) out.push(m.index);
  return out;
}

const MONEY_FILE = /(Money|Price|Amount|Balance|Currency|Tax)/;
const API_LAYER = "/VisionNativeCore/API/";

export const RULES: Rule[] = [
  {
    id: "force-cast",
    kind: "strict",
    description: "as!",
    find: (c) => matches(/\bas!/g, c),
  },
  {
    id: "force-try",
    kind: "strict",
    description: "try!",
    find: (c) => matches(/\btry!/g, c),
  },
  {
    id: "fatal-error",
    kind: "strict",
    description: "fatalError / preconditionFailure",
    find: (c) => matches(/\b(?:fatalError|preconditionFailure)\s*\(/g, c),
  },
  {
    id: "unchecked-sendable",
    kind: "strict",
    description: "@unchecked Sendable",
    find: (c) => matches(/@unchecked\s+Sendable\b/g, c),
  },
  {
    id: "nonisolated-unsafe",
    kind: "strict",
    description: "nonisolated(unsafe)",
    find: (c) => matches(/\bnonisolated\(unsafe\)/g, c),
  },
  {
    id: "any-hashable",
    kind: "strict",
    description: "AnyHashable",
    find: (c) => matches(/\bAnyHashable\b/g, c),
  },
  {
    id: "string-any-dict",
    kind: "strict",
    description: "[String: Any]",
    find: (c) => matches(/\[\s*String\s*:\s*Any\s*\]/g, c),
  },
  {
    id: "explicit-any",
    kind: "strict",
    description: "explicit Any",
    find: (c) =>
      matches(
        /\bAny\b/g,
        c.replace(/\[\s*String\s*:\s*Any\s*\]/g, (m) => " ".repeat(m.length)),
      ),
  },
  {
    id: "implicit-unwrap",
    kind: "strict",
    description: "implicitly unwrapped optional",
    find: (c) =>
      matches(/:\s*[A-Z][\w.]*(?:<[^>]*>)?(?:\[[^\]]*\])?!(?![=.\w])/g, c),
  },
  {
    id: "force-unwrap",
    kind: "ratchet",
    description: "postfix force unwrap",
    find: (c) => {
      // Mask try! / as! (own rules) and IUO declarations (own rule).
      const masked = c
        .replace(/\b(?:try|as)!/g, (m) => " ".repeat(m.length))
        .replace(
          /(:\s*[A-Z][\w.]*(?:<[^>]*>)?(?:\[[^\]]*\])?)!(?![=.\w])/g,
          (_m, a: string) => a + " ",
        );
      // `x!` where the bang is not part of `!=`; prefix `!x` follows a space or bracket.
      return matches(/[\w)\]?]!(?!=)/g, masked).map((i) => i + 1);
    },
  },
  {
    id: "double-money",
    kind: "ratchet",
    description: "Double in money-named files",
    find: (c, file) =>
      MONEY_FILE.test(path.basename(file)) ? matches(/\bDouble\b/g, c) : [],
  },
  {
    id: "raw-id",
    kind: "ratchet",
    description: "raw Int/String for *Id/*ID outside the API layer",
    find: (c, file) =>
      file.includes(API_LAYER)
        ? []
        : matches(/\b[a-z]\w*(?:Id|ID)\??\s*:\s*(?:Int|String)\b/g, c),
  },
  {
    id: "raw-currency",
    kind: "ratchet",
    description: "raw Int/String for *currency names outside the API layer",
    find: (c, file) =>
      file.includes(API_LAYER)
        ? []
        : matches(/\b[a-z]\w*[cC]urrency\w*\??\s*:\s*(?:Int|String)\b/g, c),
  },
  {
    id: "string-literal-compare",
    kind: "ratchet",
    description: '== "literal" and case "literal"',
    find: (c) => [...matches(/==\s*"/g, c), ...matches(/\bcase\s+"/g, c)],
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

export interface Hit {
  rule: string;
  file: string;
  line: number;
  text: string;
}

interface Lexed {
  /** Code per line with comments blanked and string contents blanked (quotes kept). */
  code: string[];
  /** Comment text per line. */
  comments: string[];
}

/** Splits Swift source into masked code lines and comment text, keeping line numbers. */
export function lex(source: string): Lexed {
  const code: string[] = [""];
  const comments: string[] = [""];
  const put = (ch: string, isCode: boolean, comment = "") => {
    if (ch === "\n") {
      code.push("");
      comments.push("");
      return;
    }
    code[code.length - 1] += isCode ? ch : " ";
    comments[comments.length - 1] += comment;
  };
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        put(" ", false, source[i]!);
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      while (i < n) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          put(" ", false, "/*");
          put(" ", false);
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          put(" ", false, "*/");
          put(" ", false);
          i += 2;
          if (depth === 0) break;
        } else {
          if (source[i] === "\n") put("\n", false);
          else put(" ", false, source[i]!);
          i++;
        }
      }
      continue;
    }
    if (ch === '"' || ch === "#") {
      let hashes = 0;
      let j = i;
      while (source[j] === "#") {
        hashes++;
        j++;
      }
      if (source[j] === '"') {
        const multi = source.startsWith('"""', j);
        const open = multi ? '"""' : '"';
        const close = open + "#".repeat(hashes);
        const interp = "\\" + "#".repeat(hashes) + "(";
        for (let k = i; k < j + open.length; k++) put(source[k]!, true);
        i = j + open.length;
        while (i < n && !source.startsWith(close, i)) {
          if (source.startsWith(interp, i)) {
            let depth = 0;
            do {
              const c = source[i]!;
              if (c === "(") depth++;
              else if (c === ")") depth--;
              put(c === "\n" ? "\n" : " ", false);
              i++;
            } while (i < n && depth > 0);
            continue;
          }
          if (source[i] === "\\" && hashes === 0 && i + 1 < n) {
            put(" ", false);
            put(source[i + 1] === "\n" ? "\n" : " ", false);
            i += 2;
            continue;
          }
          if (!multi && source[i] === "\n") break; // unterminated, bail out
          put(source[i] === "\n" ? "\n" : " ", false);
          i++;
        }
        if (source.startsWith(close, i)) {
          for (let k = 0; k < close.length; k++) put(source[i + k]!, true);
          i += close.length;
        }
        continue;
      }
    }
    put(ch, true);
    i++;
  }
  return { code, comments };
}

const ALLOW = /lint:allow\s+([a-z-]+)\s+(\S.*)$/;

/** True when the line or a comment-only line directly above carries a valid lint:allow. */
function allowed(lexed: Lexed, index: number, rule: string): boolean {
  const check = (comment: string | undefined) => {
    const m = comment ? ALLOW.exec(comment) : null;
    return (
      m !== null && m[1] === rule && m[2]!.replace(/\*\/\s*$/, "").trim() !== ""
    );
  };
  if (check(lexed.comments[index])) return true;
  const prev = index - 1;
  return (
    prev >= 0 && lexed.code[prev]!.trim() === "" && check(lexed.comments[prev])
  );
}

export function scanSource(source: string, file: string): Hit[] {
  const lexed = lex(source);
  const rawLines = source.split("\n");
  const hits: Hit[] = [];
  lexed.code.forEach((code, index) => {
    if (code.trim() === "") return;
    for (const rule of RULES) {
      if (rule.find(code, file).length === 0) continue;
      if (allowed(lexed, index, rule.id)) continue;
      hits.push({
        rule: rule.id,
        file,
        line: index + 1,
        text: (rawLines[index] ?? "").trim(),
      });
    }
  });
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "Generated") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".swift")) out.push(full);
  }
}

export function scanTree(
  root: string = repoPath(SOURCES_DIR),
  relativeTo: string = repoPath(),
): Hit[] {
  const files: string[] = [];
  walk(root, files);
  files.sort();
  const hits: Hit[] = [];
  for (const full of files) {
    const rel = path.relative(relativeTo, full).split(path.sep).join("/");
    hits.push(...scanSource(fs.readFileSync(full, "utf8"), rel));
  }
  return hits;
}

/** rule -> file -> count */
export type Counts = Map<string, Map<string, number>>;

export function countHits(hits: Hit[]): Counts {
  const counts: Counts = new Map();
  for (const h of hits) {
    const files = counts.get(h.rule) ?? new Map<string, number>();
    files.set(h.file, (files.get(h.file) ?? 0) + 1);
    counts.set(h.rule, files);
  }
  return counts;
}

export function ruleTotal(counts: Counts, rule: string): number {
  let total = 0;
  for (const n of counts.get(rule)?.values() ?? []) total += n;
  return total;
}

export function parseBaseline(text: string): Counts {
  const counts: Counts = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(\S+)\t(\S+)\t(\d+)$/.exec(line);
    if (!m) throw new Error(`Malformed baseline line: ${raw}`);
    const files = counts.get(m[1]!) ?? new Map<string, number>();
    files.set(m[2]!, Number(m[3]));
    counts.set(m[1]!, files);
  }
  return counts;
}

export function formatBaseline(counts: Counts): string {
  const lines = [
    "# Ratchet baseline for scripts/native-lint.ts: rule<TAB>file<TAB>count.",
    "# Counts may only go down. Lower them with: bun scripts/native-lint.ts --update-baseline",
  ];
  for (const rule of RULES.filter((r) => r.kind === "ratchet")) {
    const files = [...(counts.get(rule.id) ?? [])].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [file, n] of files)
      if (n > 0) lines.push(`${rule.id}\t${file}\t${n}`);
  }
  return lines.join("\n") + "\n";
}

/** Returns human readable failures: strict hits, and ratchet rules whose total rose. */
export function evaluate(hits: Hit[], baseline: Counts): string[] {
  const failures: string[] = [];
  const kinds = new Map(RULES.map((r) => [r.id, r.kind]));
  for (const h of hits) {
    if (kinds.get(h.rule) === "strict") {
      failures.push(
        `${h.file}:${h.line}: [${h.rule}] ${h.text}\n    fix it or add "// lint:allow ${h.rule} <reason>"`,
      );
    }
  }
  const current = countHits(hits);
  for (const rule of RULES.filter((r) => r.kind === "ratchet")) {
    const now = ruleTotal(current, rule.id);
    const was = ruleTotal(baseline, rule.id);
    if (now <= was) continue;
    failures.push(
      `[${rule.id}] ${rule.description}: ${now} hits, baseline ${was} (+${now - was})`,
    );
    const grown = new Set<string>();
    for (const [file, n] of current.get(rule.id) ?? []) {
      if (n > (baseline.get(rule.id)?.get(file) ?? 0)) grown.add(file);
    }
    for (const h of hits) {
      if (h.rule === rule.id && grown.has(h.file)) {
        failures.push(`${h.file}:${h.line}: [${rule.id}] ${h.text}`);
      }
    }
  }
  return failures;
}

/** Lowers baseline counts to the current ones; never raises or adds entries. */
export function lowerBaseline(baseline: Counts, current: Counts): Counts {
  const next: Counts = new Map();
  for (const [rule, files] of baseline) {
    const out = new Map<string, number>();
    for (const [file, n] of files) {
      const now = current.get(rule)?.get(file) ?? 0;
      const kept = Math.min(n, now);
      if (kept > 0) out.set(file, kept);
    }
    next.set(rule, out);
  }
  return next;
}

export function lintRepo(): { failures: string[]; hits: Hit[] } {
  const hits = scanTree();
  const baselinePath = repoPath(BASELINE_FILE);
  const baseline = fs.existsSync(baselinePath)
    ? parseBaseline(fs.readFileSync(baselinePath, "utf8"))
    : new Map<string, Map<string, number>>();
  return { failures: evaluate(hits, baseline), hits };
}

function main(): void {
  const args = process.argv.slice(2);
  const hits = scanTree();
  const baselinePath = repoPath(BASELINE_FILE);
  if (args.includes("--init-baseline")) {
    fs.writeFileSync(baselinePath, formatBaseline(countHits(hits)));
    return;
  }
  const baseline = parseBaseline(fs.readFileSync(baselinePath, "utf8"));
  if (args.includes("--update-baseline")) {
    fs.writeFileSync(
      baselinePath,
      formatBaseline(lowerBaseline(baseline, countHits(hits))),
    );
  }
  const refreshed = args.includes("--update-baseline")
    ? parseBaseline(fs.readFileSync(baselinePath, "utf8"))
    : baseline;
  const failures = evaluate(hits, refreshed);
  const current = countHits(hits);
  for (const rule of RULES.filter((r) => r.kind === "ratchet")) {
    console.log(
      `${rule.id}: ${ruleTotal(current, rule.id)} (baseline ${ruleTotal(refreshed, rule.id)})`,
    );
  }
  if (failures.length > 0) {
    console.error(`\nnative-lint failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("native-lint ok");
}

if (isEntrypoint(import.meta)) main();
