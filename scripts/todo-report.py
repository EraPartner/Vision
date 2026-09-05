#!/usr/bin/env python3
"""List and validate the actionable items in Vision's TODO backlog."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TODO = REPO_ROOT / "TODO.md"
CHECKBOX_RE = re.compile(r"^- \[([ xX])\] (.+)$")
TITLE_RE = re.compile(r"\*\*(.+?)\*\*")
PRIORITY_RE = re.compile(r"(🔺|⏫|🔼|🔽|⏬|⬇)")
SOURCE_RE = re.compile(r"↪ _from: (.+?)_")
TRACKING_MARKER_RE = re.compile(
    r"🔎\s+(verified-present|partial|decision-needed|runtime-unverified|needs-github-check)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class TodoItem:
    line: int
    section: str
    domain: str
    title: str
    priority: str
    state: str
    source: str
    heading: str
    body: tuple[str, ...]


def classify_state(text: str) -> str:
    tracking_lines = [
        line for line in text.splitlines() if line.lstrip().startswith("- Tracking:")
    ]
    # State comes from explicit tracking metadata when it exists. Searching the
    # whole record makes ordinary prose such as "partial-month" look like a
    # historical `partial-<sha>` marker.
    state_text = "\n".join(tracking_lines) if tracking_lines else text
    lowered = state_text.lower()
    marker_matches = TRACKING_MARKER_RE.findall(state_text)
    if len(marker_matches) == 1:
        marker = marker_matches[0].lower()
        return {
            "verified-present": "verified",
            "partial": "partial",
            "decision-needed": "blocked",
            "runtime-unverified": "unverified",
            "needs-github-check": "platform-check",
        }[marker]
    if "needs-github-check" in lowered:
        return "platform-check"
    blocking_markers = (
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
    )
    if any(marker in lowered for marker in blocking_markers):
        return "blocked"
    if "🔎 partial" in lowered or "partial-" in lowered or "left:" in lowered:
        return "partial"
    if "✅" in state_text and any(
        marker in lowered
        for marker in (
            "remaining scope",
            "remaining sub-item",
            "stays open",
            "still open",
        )
    ):
        return "partial"
    if "verified-present" in lowered or "re-verified-open" in lowered:
        return "verified"
    return "unverified"


def parse_todo(path: Path) -> list[TodoItem]:
    lines = path.read_text(encoding="utf-8").splitlines()
    items: list[TodoItem] = []
    section = ""
    domain = ""
    current: dict[str, object] | None = None

    def finish() -> None:
        nonlocal current
        if current is None:
            return
        heading = str(current["heading"])
        body = tuple(current["body"])
        title_match = TITLE_RE.search(heading)
        priority_match = PRIORITY_RE.search(heading)
        source_match = SOURCE_RE.search("\n".join(body))
        combined = "\n".join((heading, *body))
        items.append(
            TodoItem(
                line=int(current["line"]),
                section=str(current["section"]),
                domain=str(current["domain"]),
                title=title_match.group(1).strip() if title_match else heading,
                priority=priority_match.group(1) if priority_match else "",
                state=classify_state(combined),
                source=source_match.group(1).strip() if source_match else "",
                heading=heading,
                body=body,
            )
        )
        current = None

    for line_number, line in enumerate(lines, start=1):
        checkbox = CHECKBOX_RE.match(line)
        if checkbox:
            finish()
            current = {
                "line": line_number,
                "section": section,
                "domain": domain,
                "heading": line,
                "body": [],
            }
            continue

        if line.startswith("## "):
            finish()
            section = line[3:].strip()
            domain = ""
            continue
        if line.startswith("### ") or line.startswith("#### "):
            finish()
            domain = line.lstrip("#").strip()
            continue

        if current is not None:
            current["body"].append(line)

    finish()
    return items


def is_open(item: TodoItem) -> bool:
    return item.heading.startswith("- [ ]")


def actionable_items(items: list[TodoItem]) -> list[TodoItem]:
    return [item for item in items if is_open(item) and item.section == "Findings"]


def validate(items: list[TodoItem]) -> list[str]:
    errors: list[str] = []
    actionable = actionable_items(items)
    seen_titles: dict[str, int] = {}

    for item in actionable:
        if not TITLE_RE.search(item.heading):
            errors.append(f"TODO.md:{item.line}: open finding needs a bold title")
        if not item.priority:
            errors.append(f"TODO.md:{item.line}: open finding needs a priority marker")
        elif not item.heading.rstrip().endswith(item.priority):
            errors.append(
                f"TODO.md:{item.line}: move tracking text after the priority to an indented 'Tracking:' line"
            )
        if not item.source:
            errors.append(
                f"TODO.md:{item.line}: open finding needs a '↪ from' source line"
            )
        tracking_lines = [
            line for line in item.body if line.lstrip().startswith("- Tracking:")
        ]
        if len(tracking_lines) != 1:
            errors.append(
                f"TODO.md:{item.line}: open finding needs exactly one 'Tracking:' line"
            )
        elif len(TRACKING_MARKER_RE.findall(tracking_lines[0])) != 1:
            errors.append(
                f"TODO.md:{item.line}: Tracking line needs exactly one recognized state marker"
            )
        if len(item.heading) > 240:
            errors.append(
                f"TODO.md:{item.line}: open finding heading is longer than 240 characters"
            )
        previous_line = seen_titles.get(item.title)
        if previous_line is not None:
            errors.append(
                f"TODO.md:{item.line}: duplicate open finding title; first appears on line {previous_line}"
            )
        else:
            seen_titles[item.title] = item.line

    for item in items:
        if (
            is_open(item)
            and "finding" in item.section.lower()
            and item.section != "Findings"
        ):
            errors.append(
                f"TODO.md:{item.line}: open finding is outside the authoritative '## Findings' queue"
            )

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List or validate open items from TODO.md's authoritative Findings queue."
    )
    parser.add_argument("--file", type=Path, default=DEFAULT_TODO)
    parser.add_argument(
        "--json", action="store_true", help="emit machine-readable JSON"
    )
    parser.add_argument("--check", action="store_true", help="validate queue hygiene")
    parser.add_argument(
        "--state",
        choices=("blocked", "partial", "platform-check", "unverified", "verified"),
        help="show only one derived work state",
    )
    parser.add_argument(
        "--priority",
        choices=("🔺", "⏫", "🔼", "🔽", "⏬", "⬇"),
        help="show only one priority",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    items = parse_todo(args.file)

    if args.check:
        errors = validate(items)
        if errors:
            print("[todo-report] hygiene check failed:", file=sys.stderr)
            for error in errors:
                print(f"- {error}", file=sys.stderr)
            return 1
        print(f"[todo-report] OK: {len(actionable_items(items))} open findings")
        return 0

    selected = actionable_items(items)
    if args.state:
        selected = [item for item in selected if item.state == args.state]
    if args.priority:
        selected = [item for item in selected if item.priority == args.priority]

    if args.json:
        serializable = []
        for item in selected:
            data = asdict(item)
            data.pop("body")
            data.pop("heading")
            serializable.append(data)
        json.dump(serializable, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    print(f"Open findings: {len(selected)}")
    current_domain = None
    for item in selected:
        if item.domain != current_domain:
            current_domain = item.domain
            print(f"\n{current_domain or 'Uncategorized'}")
        print(f"- {item.priority} [{item.state}] TODO.md:{item.line} — {item.title}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
