#!/usr/bin/env bun
/** List and validate the actionable items in Vision's TODO backlog. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

const DEFAULT_TODO = path.resolve(import.meta.dirname, "..", "TODO.md");
const CHECKBOX_RE = /^- \[([ xX])\] (.+)$/;
const TITLE_RE = /\*\*(.+?)\*\*/;
const PRIORITY_RE = /(🔺|⏫|🔼|🔽|⏬|⬇)/u;
const SOURCE_RE = /↪ _from: (.+?)_/;
const TRACKING_MARKER_RE =
  /🔎\s+(verified-present|partial|decision-needed|runtime-unverified|needs-github-check)\b/giu;
const STATES = [
  "blocked",
  "partial",
  "platform-check",
  "unverified",
  "verified",
] as const;
const PRIORITIES = ["🔺", "⏫", "🔼", "🔽", "⏬", "⬇"] as const;

export interface TodoItem {
  line: number;
  section: string;
  domain: string;
  title: string;
  priority: string;
  state: string;
  source: string;
  heading: string;
  body: string[];
}

const MARKER_STATES: Record<string, string> = {
  "verified-present": "verified",
  partial: "partial",
  "decision-needed": "blocked",
  "runtime-unverified": "unverified",
  "needs-github-check": "platform-check",
};

function trackingMarkers(text: string): string[] {
  return [...text.matchAll(TRACKING_MARKER_RE)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
}

function isTrackingLine(line: string): boolean {
  return line.trimStart().startsWith("- Tracking:");
}

export function classifyState(text: string): string {
  const trackingLines = text.split(/\r?\n/).filter(isTrackingLine);
  // State comes from explicit tracking metadata when it exists. Searching the
  // whole record makes ordinary prose such as "partial-month" look like a
  // historical `partial-<sha>` marker.
  const stateText = trackingLines.length > 0 ? trackingLines.join("\n") : text;
  const lowered = stateText.toLowerCase();
  const markers = trackingMarkers(stateText);
  if (markers.length === 1)
    return MARKER_STATES[markers[0] ?? ""] ?? "unverified";
  if (lowered.includes("needs-github-check")) return "platform-check";
  const blockingMarkers = [
    "blocked-on-",
    "decision-needed",
    "do not start before",
    "explicit product decision",
    "investigated-not-applied",
    "needs-companion",
    "needs a product decision",
    "needs user sign-off",
    "requires user sign-off",
    "user-gated",
    "⚠️ gated",
  ];
  if (blockingMarkers.some((marker) => lowered.includes(marker)))
    return "blocked";
  if (
    lowered.includes("🔎 partial") ||
    lowered.includes("partial-") ||
    lowered.includes("left:")
  )
    return "partial";
  if (
    stateText.includes("✅") &&
    ["remaining scope", "remaining sub-item", "stays open", "still open"].some(
      (marker) => lowered.includes(marker),
    )
  ) {
    return "partial";
  }
  if (
    lowered.includes("verified-present") ||
    lowered.includes("re-verified-open")
  )
    return "verified";
  return "unverified";
}

export function parseTodo(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  let section = "";
  let domain = "";
  let current:
    | Pick<TodoItem, "line" | "section" | "domain" | "heading" | "body">
    | undefined;

  const finish = (): void => {
    if (!current) return;
    const { heading, body } = current;
    items.push({
      ...current,
      title: TITLE_RE.exec(heading)?.[1]?.trim() ?? heading,
      priority: PRIORITY_RE.exec(heading)?.[1] ?? "",
      state: classifyState([heading, ...body].join("\n")),
      source: SOURCE_RE.exec(body.join("\n"))?.[1]?.trim() ?? "",
    });
    current = undefined;
  };

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, index) => {
    if (CHECKBOX_RE.test(line)) {
      finish();
      current = { line: index + 1, section, domain, heading: line, body: [] };
      return;
    }
    if (line.startsWith("## ")) {
      finish();
      section = line.slice(3).trim();
      domain = "";
      return;
    }
    if (line.startsWith("### ") || line.startsWith("#### ")) {
      finish();
      domain = line.replace(/^#+/, "").trim();
      return;
    }
    current?.body.push(line);
  });
  finish();
  return items;
}

function isOpen(item: TodoItem): boolean {
  return item.heading.startsWith("- [ ]");
}

export function actionableItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((item) => isOpen(item) && item.section === "Findings");
}

export function validate(items: readonly TodoItem[]): string[] {
  const errors: string[] = [];
  const seenTitles = new Map<string, number>();
  for (const item of actionableItems(items)) {
    const at = `TODO.md:${item.line}`;
    if (!TITLE_RE.test(item.heading))
      errors.push(`${at}: open finding needs a bold title`);
    if (!item.priority)
      errors.push(`${at}: open finding needs a priority marker`);
    else if (!item.heading.trimEnd().endsWith(item.priority)) {
      errors.push(
        `${at}: move tracking text after the priority to an indented 'Tracking:' line`,
      );
    }
    if (!item.source)
      errors.push(`${at}: open finding needs a '↪ from' source line`);
    const trackingLines = item.body.filter(isTrackingLine);
    if (trackingLines.length !== 1)
      errors.push(`${at}: open finding needs exactly one 'Tracking:' line`);
    else if (trackingMarkers(trackingLines[0] ?? "").length !== 1) {
      errors.push(
        `${at}: Tracking line needs exactly one recognized state marker`,
      );
    }
    if ([...item.heading].length > 240)
      errors.push(`${at}: open finding heading is longer than 240 characters`);
    const previous = seenTitles.get(item.title);
    if (previous !== undefined) {
      errors.push(
        `${at}: duplicate open finding title; first appears on line ${previous}`,
      );
    } else {
      seenTitles.set(item.title, item.line);
    }
  }
  for (const item of items) {
    if (
      isOpen(item) &&
      item.section.toLowerCase().includes("finding") &&
      item.section !== "Findings"
    ) {
      errors.push(
        `TODO.md:${item.line}: open finding is outside the authoritative '## Findings' queue`,
      );
    }
  }
  return errors;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      file: { type: "string", default: DEFAULT_TODO },
      json: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      state: { type: "string" },
      priority: { type: "string" },
    },
  });
  if (
    values.state !== undefined &&
    !(STATES as readonly string[]).includes(values.state)
  ) {
    console.error(`--state must be one of: ${STATES.join(", ")}`);
    return 2;
  }
  if (
    values.priority !== undefined &&
    !(PRIORITIES as readonly string[]).includes(values.priority)
  ) {
    console.error(`--priority must be one of: ${PRIORITIES.join(" ")}`);
    return 2;
  }
  const items = parseTodo(fs.readFileSync(values.file, "utf8"));

  if (values.check) {
    const errors = validate(items);
    if (errors.length > 0) {
      console.error("[todo-report] hygiene check failed:");
      for (const error of errors) console.error(`- ${error}`);
      return 1;
    }
    console.log(
      `[todo-report] OK: ${actionableItems(items).length} open findings`,
    );
    return 0;
  }

  const selected = actionableItems(items).filter(
    (item) =>
      (values.state === undefined || item.state === values.state) &&
      (values.priority === undefined || item.priority === values.priority),
  );
  if (values.json) {
    const serializable = selected.map(
      ({ body: _body, heading: _heading, ...rest }) => rest,
    );
    console.log(JSON.stringify(serializable, undefined, 2));
    return 0;
  }
  console.log(`Open findings: ${selected.length}`);
  let currentDomain: string | undefined;
  for (const item of selected) {
    if (item.domain !== currentDomain) {
      currentDomain = item.domain;
      console.log(`\n${currentDomain || "Uncategorized"}`);
    }
    console.log(
      `- ${item.priority} [${item.state}] TODO.md:${item.line} — ${item.title}`,
    );
  }
  return 0;
}

if (isEntrypoint(import.meta)) process.exitCode = main();
